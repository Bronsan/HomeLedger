//! Supervision of the embedded Python service.
//!
//! The desktop build ships the same backend as the gateway build, wrapped as a
//! child process. This module owns that process: finding it, starting it,
//! keeping it alive, and — most importantly — not leaving it behind.
//!
//! Three failure modes shaped this design:
//!
//! * **Port races.** Asking the OS for a free port and then telling Python to
//!   bind it leaves a window where another process can take it. Instead we ask
//!   Python to bind the socket *first* and report the result, so the port we
//!   advertise is the port that is actually listening.
//! * **Pipe deadlock.** A child that writes to stderr faster than we read it
//!   blocks forever once the pipe buffer fills. Both streams get drained
//!   continuously on their own threads.
//! * **Orphans.** If the shell crashes, the server must not keep running. We
//!   keep the child's stdin pipe open and never write to it: when this process
//!   dies the pipe closes, and the child sees EOF.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const READY_PREFIX: &str = "HOMELEDGER_READY ";
const PREFERRED_PORTS: [u16; 10] = [47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830, 47831, 47832];
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

/// Last N stderr lines, kept in memory so a startup failure can be shown to the
/// user without making them open a log file first.
pub type Tail = Arc<Mutex<VecDeque<String>>>;

#[derive(Debug, Deserialize)]
struct RuntimeInfo {
    url: String,
    install_id: String,
    #[serde(default)]
    desktop_token: String,
}

#[derive(Debug, Deserialize)]
struct ReadyLine {
    #[serde(default)]
    url: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    error: String,
    #[serde(default)]
    message: String,
}

pub struct Running {
    pub url: String,
    pub token: String,
    child: Option<Child>,
    /// Held open on purpose. Dropping it closes the pipe and the child exits.
    _stdin: Option<ChildStdin>,
}

impl Running {
    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Closing stdin is the polite signal; the child watches for EOF.
            self._stdin.take();
            for _ in 0..40 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// What we know about how to start the backend on this machine.
enum Launch {
    /// A frozen single-file binary shipped inside the bundle.
    Binary { program: PathBuf },
    /// Running from source: `python -m app.desktop`.
    Python { program: PathBuf, cwd: PathBuf },
}

fn resource_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let exe = if cfg!(windows) {
        "homeledger-server.exe"
    } else {
        "homeledger-server"
    };
    let base = dir.join("server");
    // onedir bundle first (the shipping layout), then a bare single binary so a
    // hand-built onefile drop-in still works.
    [
        base.join("homeledger-server").join(exe),
        base.join(exe),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn find_backend_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("HOMELEDGER_BACKEND_DIR") {
        let p = PathBuf::from(dir);
        if p.join("app").join("desktop.py").is_file() {
            return Some(p);
        }
    }

    // Walk up from the executable: handles both `target/debug/prog` and a
    // relocated build output.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    // Compile-time project root, so `cargo run` works from any cwd.
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));

    for root in roots {
        for rel in ["backend", "../backend"] {
            let p = root.join(rel);
            if p.join("app").join("desktop.py").is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn resolve_launch(app: &AppHandle) -> Result<Launch, String> {
    if let Some(bin) = resource_sidecar(app) {
        return Ok(Launch::Binary { program: bin });
    }

    let backend = find_backend_dir().ok_or_else(|| {
        "找不到后端程序：安装包内缺少 server/homeledger-server，源码模式下也未找到 backend/ 目录".to_string()
    })?;

    let python = if let Ok(p) = std::env::var("HOMELEDGER_PYTHON") {
        PathBuf::from(p)
    } else {
        let venv = if cfg!(windows) {
            backend.join(".venv").join("Scripts").join("python.exe")
        } else {
            backend.join(".venv").join("bin").join("python")
        };
        if venv.is_file() {
            venv
        } else if cfg!(windows) {
            PathBuf::from("python")
        } else {
            PathBuf::from("python3")
        }
    };

    Ok(Launch::Python {
        program: python,
        cwd: backend,
    })
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn pick_port() -> u16 {
    PREFERRED_PORTS
        .into_iter()
        .find(|p| port_free(*p))
        .unwrap_or(0)
}

pub fn probe(url: &str, timeout: Duration) -> Option<serde_json::Value> {
    let endpoint = format!("{}/api/v1/system/health", url.trim_end_matches('/'));
    let resp = ureq::get(&endpoint).timeout(timeout).call().ok()?;
    resp.into_json::<serde_json::Value>().ok()
}

fn read_runtime(data_dir: &Path) -> Option<RuntimeInfo> {
    let raw = std::fs::read_to_string(data_dir.join("desktop-runtime.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Reuse a server that is already listening with the same data directory.
///
/// This matters more than it looks: users who start the gateway manually and
/// then open the desktop app would otherwise run two servers against one
/// database file, which is the exact thing the architecture forbids.
fn try_adopt(data_dir: &Path) -> Option<Running> {
    let info = read_runtime(data_dir)?;
    let health = probe(&info.url, Duration::from_millis(1200))?;
    if health.get("ok")?.as_bool() != Some(true) {
        return None;
    }
    // Same install id => same data directory => safe to share.
    if health.get("install_id")?.as_str()? != info.install_id {
        return None;
    }
    Some(Running {
        url: info.url,
        token: info.desktop_token,
        child: None,
        _stdin: None,
    })
}

impl Running {
    /// Call an endpoint that is only reachable with the shell's private token.
    pub fn post(&self, path: &str) -> Result<serde_json::Value, String> {
        let url = format!("{}{}", self.url.trim_end_matches('/'), path);
        let resp = ureq::post(&url)
            .timeout(Duration::from_secs(120))
            .set("X-Desktop-Token", &self.token)
            .set("Content-Type", "application/json")
            .send_string("{}");
        match resp {
            Ok(r) => r
                .into_json::<serde_json::Value>()
                .map_err(|e| format!("响应解析失败：{e}")),
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                Err(format!("HTTP {code}：{body}"))
            }
            Err(e) => Err(format!("请求失败：{e}")),
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    stream: R,
    sink: Tail,
    ready_tx: Option<mpsc::Sender<String>>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&raw).trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            if let Some(rest) = line.strip_prefix(READY_PREFIX) {
                if let Some(tx) = &ready_tx {
                    let _ = tx.send(rest.to_string());
                }
                continue;
            }
            if let Ok(mut tail) = sink.lock() {
                tail.push_back(line);
                while tail.len() > 60 {
                    tail.pop_front();
                }
            }
        }
        // Signal EOF so the caller stops waiting.
        if let Some(tx) = &ready_tx {
            let _ = tx.send(String::new());
        }
    });
}

#[derive(Debug, Clone, Serialize)]
pub struct BootError {
    pub message: String,
    pub tail: Vec<String>,
}

/// Best-effort LAN address of this machine.
///
/// No packet is sent: `connect` on a UDP socket only resolves a route, so this
/// answers instantly and works with no network. When there is no default route
/// (no DHCP lease, airplane mode) there is also no address a phone could type
/// in, so `None` is the honest answer rather than a guess.
///
/// The destination is only a route hint. Anything outside the local subnet
/// works; AliDNS is used because it is reachable from China without a VPN,
/// which is where most of this project's users are.
#[cfg(desktop)]
pub fn lan_ip() -> Option<std::net::IpAddr> {
    use std::net::{IpAddr, UdpSocket};

    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("223.5.5.5:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(IpAddr::V4(v4)),
        _ => None,
    }
}

/// Start (or adopt) the household server for this data directory.
///
/// `lan` decides the bind address, and it is the one thing a desktop install can
/// offer that a phone cannot: a port other devices in the household can reach.
/// It is still the same process and the same database either way — only the
/// listening socket changes.
pub fn ensure_started(app: &AppHandle, data_dir: &Path, lan: bool) -> Result<Running, BootError> {
    if let Some(running) = try_adopt(data_dir) {
        return Ok(running);
    }

    let launch = resolve_launch(app).map_err(|message| BootError {
        message,
        tail: vec![],
    })?;

    std::fs::create_dir_all(data_dir).ok();
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();

    let mut last_error = String::from("未知错误");
    let mut last_tail: Vec<String> = Vec::new();

    // Two attempts: the preferred port, then an OS-assigned one. More than two
    // and a genuine bug (missing binary, broken venv) would just look slow.
    for attempt in 0..2 {
        let port = if attempt == 0 { pick_port() } else { 0 };
        let tail: Tail = Arc::new(Mutex::new(VecDeque::new()));

        let mut cmd = match &launch {
            Launch::Binary { program } => Command::new(program),
            Launch::Python { program, cwd } => {
                let mut c = Command::new(program);
                c.current_dir(cwd).arg("-m").arg("app.desktop");
                c
            }
        };

        cmd.arg("--port")
            .arg(port.to_string())
            .arg("--host")
            .arg(if lan { "0.0.0.0" } else { "127.0.0.1" })
            .arg("--data-dir")
            .arg(data_dir)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .env("HOMELEDGER_DEPLOYMENT_MODE", "local")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            // Do not flash a console window on every launch.
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                return Err(BootError {
                    message: format!("无法启动内置服务：{err}"),
                    tail: vec![],
                })
            }
        };

        let stdin = child.stdin.take();
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(out) = child.stdout.take() {
            spawn_reader(out, tail.clone(), Some(tx));
        }
        if let Some(err) = child.stderr.take() {
            // Mirror stderr to a file so a crash leaves evidence behind, and to
            // the in-memory tail so the splash screen can show it right away.
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("sidecar.log"))
                .ok();
            if let Some(mut f) = file {
                let mirror: Tail = tail.clone();
                thread::spawn(move || {
                    let mut reader = BufReader::new(err);
                    let mut buf = Vec::new();
                    loop {
                        buf.clear();
                        match reader.read_until(b'\n', &mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                        let _ = f.write_all(&buf);
                        let _ = f.flush();
                        if let Ok(mut t) = mirror.lock() {
                            t.push_back(String::from_utf8_lossy(&buf).trim_end().to_string());
                            while t.len() > 60 {
                                t.pop_front();
                            }
                        }
                    }
                });
            } else {
                spawn_reader(err, tail.clone(), None);
            }
        }

        let deadline = Instant::now() + BOOT_TIMEOUT;
        let mut payload: Option<ReadyLine> = None;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(line) if line.is_empty() => break,
                Ok(line) => {
                    if let Ok(parsed) = serde_json::from_str::<ReadyLine>(&line) {
                        payload = Some(parsed);
                    }
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(Some(_)) = child.try_wait() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        match payload {
            Some(ready) if !ready.error.is_empty() => {
                last_error = format!("内置服务启动失败：{}", ready.message);
                last_tail = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
                let _ = child.kill();
                let _ = child.wait();
                continue; // maybe the port was taken — retry on an ephemeral one
            }
            Some(ready) => {
                // READY is printed before uvicorn finishes starting, so poll
                // until the API actually answers.
                let url = if ready.url.is_empty() {
                    format!("http://127.0.0.1:{}", ready.port)
                } else {
                    ready.url.clone()
                };
                let health_deadline = Instant::now() + HEALTH_TIMEOUT;
                let mut healthy = false;
                while Instant::now() < health_deadline {
                    if probe(&url, Duration::from_millis(800)).is_some() {
                        healthy = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                if healthy {
                    return Ok(Running {
                        url,
                        token: String::new(),
                        child: Some(child),
                        _stdin: stdin,
                    });
                }
                last_error = "内置服务已启动但接口无响应".to_string();
                last_tail = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
                let _ = child.kill();
                let _ = child.wait();
            }
            None => {
                last_error = "内置服务启动超时".to_string();
                last_tail = tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default();
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    Err(BootError {
        message: last_error,
        tail: last_tail,
    })
}
