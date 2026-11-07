"""Sidecar entry point used by the desktop shell.

The Tauri application launches this module as a child process instead of
re-implementing any business logic. The contract between the two is deliberately
small and machine-checkable:

1. We bind the listening socket ourselves, so the port is known *before* we
   announce it. Letting uvicorn pick the port and scraping its log would be a
   race; asking the OS for an ephemeral port and hoping it is still free when
   uvicorn binds it is a different race.
2. We print exactly one line to stdout::

       HOMELEDGER_READY {"port": 47823, "pid": 1234, "install_id": "..."}

   The shell parses that line and nothing else. Human-readable logs go to
   stderr and to ``<data_dir>/logs/desktop.log``.
3. We exit when the parent process goes away. A desktop app that leaves an
   orphaned server behind on every crash is a support burden, so we watch both
   stdin (the shell keeps the write end, so it closes on exit) and the parent
   pid.

Everything else stays in :mod:`app.main`. This module only owns process
lifetime, which is exactly the part a GUI shell cannot do for us.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import threading
from pathlib import Path

log = logging.getLogger("homeledger.desktop")

READY_PREFIX = "HOMELEDGER_READY "


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="homeledger-desktop-server",
        description="HomeLedger 桌面版内置服务（由桌面外壳启动，通常无需手动运行）",
    )
    p.add_argument(
        "--port",
        type=int,
        default=47823,
        help="监听端口；0 表示由系统分配。默认 47823 —— 固定端口能让 WebView 的 "
        "localStorage（登录态）在重启后保持有效。",
    )
    p.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址。127.0.0.1 只服务本机；0.0.0.0 让同一局域网的其他设备也能连上来同步",
    )
    p.add_argument("--data-dir", default="", help="数据目录，覆盖 HOMELEDGER_DATA_DIR")
    p.add_argument("--parent-pid", type=int, default=0, help="父进程 pid，退出后随之关闭")
    p.add_argument("--log-level", default="INFO", help="日志级别")
    return p.parse_args(argv)


def _setup_logging(data_dir: Path, level: str) -> None:
    """Log to a file as well as stderr.

    A packaged desktop app has no terminal, so stderr goes nowhere the user can
    see. The log file is what makes "it won't start" debuggable at all.
    """
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]

    try:
        log_dir = data_dir / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        from logging.handlers import RotatingFileHandler

        fh = RotatingFileHandler(
            log_dir / "desktop.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
        handlers.append(fh)
    except OSError as exc:  # read-only dir, full disk, …
        # Not fatal: the app still runs, it just loses its paper trail.
        print(f"警告：无法写入日志文件（{exc}）", file=sys.stderr)

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )


def _bind(host: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    # Windows needs SO_EXCLUSIVEADDRUSE; POSIX wants SO_REUSEADDR so a previous
    # instance that just exited does not hold the port in TIME_WAIT.
    if os.name == "nt":
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    sock.set_inheritable(True)
    return sock


def _local_ipv4s() -> list[str]:
    """Addresses this machine answers on, best effort, no dependencies.

    Only used to build the CORS allow-list when the LAN listener is on: a
    browser pointing at ``http://192.168.1.5:47823`` sends that exact string as
    ``Origin``, so the list has to contain it. Nothing is sent — connecting a
    UDP socket only resolves a route.
    """
    found: set[str] = set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("223.5.5.5", 80))
            found.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass

    return sorted(a for a in found if a and not a.startswith("127."))


# Origins a WebView sends. The window no longer navigates to the sidecar, so
# every request it makes is cross-origin: the desktop shell sends
# `tauri://localhost`, a phone sends `http://tauri.localhost`. Without these the
# app could not talk to its own bundled server at all.
_TAURI_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)


def _cors_origins(port: int, lan: bool) -> str:
    origins = [
        *_TAURI_ORIGINS,
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
    ]
    if lan:
        origins += [f"http://{ip}:{port}" for ip in _local_ipv4s()]
    # Preserve order, drop duplicates: the middleware echoes the list into a
    # header for preflights and a doubled entry is just noise.
    return ",".join(dict.fromkeys(origins))


def _write_runtime(path: Path, payload: dict) -> None:
    """Publish where this instance lives, readable only by the current user.

    The file contains the tray bridge token, so it must not be world-readable.
    Writing to a temp file and renaming keeps a reader from ever seeing a
    half-written document.
    """
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:  # pragma: no cover - exotic filesystems
        pass
    tmp.replace(path)


def _parent_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    if os.name == "nt":  # pragma: no cover - handled by stdin EOF on Windows
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but belongs to another user — still alive.
        return True
    return True


def _watch_parent(server, parent_pid: int) -> None:
    """Stop the server once the GUI shell is gone.

    Two independent signals, because each one alone has a hole:

    * **stdin EOF** works everywhere but only if the parent actually pipes
      stdin. Tauri does; a terminal does not.
    * **parent pid** works on POSIX but is racy if the pid gets reused, so it
      is only a fallback.

    Whichever fires first wins.
    """

    def _stdin_watch() -> None:
        try:
            stream = sys.stdin
            if stream is None or stream.closed:
                return
            while True:
                chunk = stream.readline()
                if chunk == "":
                    break
        except (OSError, ValueError):
            pass
        if parent_pid > 0:
            log.info("父进程已关闭标准输入，准备退出")
            server.should_exit = True

    if parent_pid > 0:
        threading.Thread(target=_stdin_watch, name="parent-stdin", daemon=True).start()

        def _poll() -> None:
            import time

            while not server.should_exit:
                time.sleep(2.0)
                if not _parent_alive(parent_pid):
                    log.info("父进程 %s 已退出，关闭内置服务", parent_pid)
                    server.should_exit = True

        threading.Thread(target=_poll, name="parent-pid", daemon=True).start()


def _force_utf8_pipes() -> None:
    """Write UTF-8 when stdout/stderr are pipes, keep the console encoding otherwise.

    The shell captures our stderr and shows the last lines when startup fails.
    On a Chinese Windows, Python encodes those pipes with the ANSI code page
    (cp936), the shell decodes them as UTF-8, and the user's only diagnostic
    turns into ``���÷���``. Reconfiguring to UTF-8 fixes that — but only for
    pipes: a real console already knows its own code page, and forcing UTF-8
    there would produce mojibake in the opposite direction for anyone running
    `python -m app.desktop` from a terminal.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is not None and not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - 非常规流对象
            pass


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _force_utf8_pipes()

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else Path(
        os.getenv("HOMELEDGER_DATA_DIR") or (Path.home() / ".homeledger")
    )
    data_dir = data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    # These must be set *before* app.config is imported: Settings() snapshots
    # the environment at import time.
    os.environ["HOMELEDGER_DATA_DIR"] = str(data_dir)
    os.environ["HOMELEDGER_DEPLOYMENT_MODE"] = os.getenv(
        "HOMELEDGER_DEPLOYMENT_MODE", "local"
    )
    os.environ["HOMELEDGER_DESKTOP_SHELL"] = "1"
    # Printed stickers carry the address other devices can reach. That is not
    # the loopback address this process is usually bound to, so the sticker
    # generator has to know which interface we are on.
    os.environ["HOMELEDGER_BIND_HOST"] = args.host

    _setup_logging(data_dir, args.log_level)

    # Bind before importing the app: the port has to be known to build the CORS
    # allow-list, and the middleware reads its configuration at import time.
    try:
        sock = _bind(args.host, args.port)
    except OSError as exc:
        payload = {"error": "bind_failed", "port": args.port, "message": str(exc)}
        print(READY_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)
        log.error("无法绑定 %s:%s —— %s", args.host, args.port, exc)
        return 2

    actual_port = sock.getsockname()[1]
    # Whether this install is also a server for the household. A desktop install
    # is single-household by definition, so the allow-list stays explicit rather
    # than "*" (which would be rejected anyway — the app authenticates with
    # cookies and credentials, and the CORS spec forbids "*" with credentials).
    lan = args.host not in ("127.0.0.1", "::1", "localhost")
    os.environ.setdefault("HOMELEDGER_CORS_ORIGINS", _cors_origins(actual_port, lan))

    from .config import settings  # noqa: E402  (must follow env setup)
    from .main import app  # noqa: E402
    from .routers.desktop import desktop_token  # noqa: E402

    runtime_file = data_dir / "desktop-runtime.json"
    token = desktop_token()

    try:
        import uvicorn

        config = uvicorn.Config(
            app,
            log_level=args.log_level.lower(),
            access_log=False,
            # We already own the socket; uvicorn must not try to bind again.
            lifespan="on",
        )
        server = uvicorn.Server(config)

        _watch_parent(server, args.parent_pid)

        # 0.0.0.0 means "every interface"; the shell still connects over the
        # loopback, so report that instead of an address no client can dial.
        url_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
        url = f"http://{'[::1]' if ':' in url_host else url_host}:{actual_port}"
        payload = {
            "port": actual_port,
            "url": url,
            "pid": os.getpid(),
            "data_dir": str(data_dir),
            "install_id": settings.resolved_install_id,
            "mode": settings.deployment_mode,
            "desktop_token": token,
        }

        # Register before announcing readiness: the shell reads this file to
        # decide whether an instance is already serving this data directory.
        _write_runtime(runtime_file, payload)
        print(READY_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)
        log.info("内置服务已启动：%s（数据目录 %s）", url, data_dir)

        server.run(sockets=[sock])
    finally:
        # Only remove the registration if it is still ours — a restarted
        # instance may have replaced it already.
        try:
            current = json.loads(runtime_file.read_text(encoding="utf-8"))
            if current.get("pid") == os.getpid():
                runtime_file.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
        try:
            sock.close()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
