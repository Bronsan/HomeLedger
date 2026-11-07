import { useCallback, useEffect, useMemo, useState } from "react";
import {
  familyStore,
  get,
  getMode,
  isTauri,
  normalizeServer,
  serverStore,
  setMode,
  tokenStore,
} from "../api/client";
import { Icon } from "./icons";
import { Spinner, useConfirm, useToast } from "./ui";
import { fmtDateTime } from "../lib/format";
import { bootstrap, rebootstrap } from "../local/api";
import { qrServiceStatus } from "../sync/engine";
import { exportSnapshot } from "../local/handlers";
import { resetStore, store } from "../local/store";
import {
  SyncState,
  linkServer,
  lock,
  snapshot,
  subscribe,
  syncNow,
  unlinkServer,
  unlock,
} from "../sync/engine";

type ShellInfo = { lanUrls?: string[]; baseUrl?: string };

/** Call the Tauri shell, if this build is running inside one. */
function shellInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: Function } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== "function") return null;
  return Promise.resolve(invoke(cmd, args)) as Promise<T>;
}

/**
 * The one screen that decides where data lives.
 *
 * Three states, and the UI refuses to blur them:
 *
 *   仅本机       nothing leaves the device
 *   本机 + 同步   device is the database, changes replicate encrypted
 *   直连服务器    server is the database (thin client)
 *
 * Changing between them is a migration, not a toggle, so every switch asks for
 * confirmation and says what happens to the data already on the device.
 */
export function SyncPanel() {
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [state, setState] = useState<SyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setLocalMode] = useState(getMode());

  const [form, setForm] = useState({
    serverUrl: "",
    email: "",
    password: "",
    passphrase: "",
    confirm: "",
    createAccount: true,
    familyName: "",
  });
  const [unlockPass, setUnlockPass] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** LAN addresses the desktop shell reports, e.g. ["http://192.168.1.5:47823"]. */
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [lanBusy, setLanBusy] = useState(false);
  // The sticker viewer is asleep most of the time by design, so "off" and
  // "broken" look identical without a status line.
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);

  useEffect(() => subscribe(setState), []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const data =
        getMode() === "remote"
          ? await get("/system/qr").catch(() => null)
          : await qrServiceStatus();
      if (alive && data) setQr(data as Record<string, unknown>);
    };
    void tick();
    const timer = window.setInterval(tick, 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [state?.configured]);

  // The shell knows what port it bound and which address the LAN gave this
  // machine; the webview cannot work either out by itself (its own origin is
  // tauri://localhost). Asking over IPC is the only honest source.
  useEffect(() => {
    if (!isTauri()) return;
    shellInvoke<ShellInfo>("app_info")
      ?.then((info) => {
        const urls = info?.lanUrls;
        if (Array.isArray(urls)) setLanUrls(urls.filter((u): u is string => typeof u === "string"));
      })
      .catch(() => {
        // No sidecar, no LAN, or an older shell: the card simply does not show.
      });
  }, []);

  useEffect(() => {
    void bootstrap().then((s) => {
      setForm((f) => ({
        ...f,
        serverUrl: f.serverUrl || s.meta.server_url || "",
        familyName: f.familyName || s.meta.family_name,
      }));
    });
  }, []);

  const refresh = useCallback(async () => setState(await snapshot()), []);

  const handleLink = async () => {
    setError("");
    if (!/^https?:\/\/.+/.test(form.serverUrl.trim())) {
      setError("服务器地址需要以 http:// 或 https:// 开头");
      return;
    }
    if (!form.email.includes("@")) {
      setError("请填写服务器账号邮箱");
      return;
    }
    if (form.password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (form.passphrase.length < 8) {
      setError("同步口令至少 8 位。它是唯一能解开云端数据的钥匙，忘记后无法找回");
      return;
    }
    if (form.passphrase !== form.confirm) {
      setError("两次输入的同步口令不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await linkServer({
        serverUrl: form.serverUrl.trim(),
        email: form.email.trim(),
        password: form.password,
        passphrase: form.passphrase,
        createAccount: form.createAccount,
        familyName: form.familyName.trim() || undefined,
      });
      toast(
        res.mergedCatalog > 0
          ? `已加入这个家庭，合并了 ${res.mergedCatalog} 个重名的分类/地点`
          : res.joined
            ? "已接入家庭，正在拉取数据"
            : "已建立加密同步"
      );
      await refresh();
      setMode("sync");
      setLocalMode("sync");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    setBusy(true);
    try {
      await syncNow();
      toast("同步完成");
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async () => {
    setError("");
    setBusy(true);
    try {
      await unlock(unlockPass);
      setUnlockPass("");
      await refresh();
      toast("已解锁");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleLock = async () => {
    setBusy(true);
    try {
      // Removes the persisted DEK, not the local data. Stays locked after a
      // reload until the passphrase is entered again.
      await lock();
      await refresh();
      toast("已锁定同步口令");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    const ok = await confirm("断开后本机数据保留，但不再与服务器同步。", {
      title: "断开同步",
      confirmText: "断开",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await unlinkServer();
      await refresh();
      setLocalMode(getMode());
      toast("已断开同步");
    } finally {
      setBusy(false);
    }
  };

  const switchToRemote = async () => {
    // The address is the one thing this mode cannot invent. Asking here beats
    // switching into a mode that has nowhere to send its requests — which used
    // to land on a blank window.
    const address = normalizeServer(form.serverUrl || serverStore.get());
    if (!address) {
      setError("先在上面填服务器地址，例如 192.168.1.10:8000");
      return;
    }
    const ok = await confirm(
      `界面将直接读写 ${address} 上的数据库，本机离线时无法使用。\n\n本机已有的数据不会被删除，但不会自动上传。建议先开启同步把数据推上去。`,
      { title: "切换到直连服务器", confirmText: "切换并重新加载", danger: false }
    );
    if (!ok) return;
    serverStore.set(address);
    tokenStore.clear();
    familyStore.clear();
    setMode("remote");
    location.reload();
  };

  const switchToLocal = async () => {
    const ok = await confirm(
      "界面改用这台设备自己的数据库，服务器上的数据不会自动复制过来。\n\n如果需要把服务器数据带到本机，请在本机模式里用「连接同步」加入同一个家庭。",
      { title: "切换到本机模式", confirmText: "切换并重新加载", danger: false }
    );
    if (!ok) return;
    setMode("local");
    location.reload();
  };

  const enableLan = async () => {
    const ok = await confirm(
      "这台电脑会开始在局域网监听端口，同一 Wi-Fi 下的设备可以打开登录页。\n\n数据仍然端到端加密，但建议只在家庭网络里开启。",
      { title: "允许家庭内设备连接", confirmText: "开启", danger: false }
    );
    if (!ok) return;
    setLanBusy(true);
    try {
      const info = await shellInvoke<ShellInfo>("set_lan_share", { enabled: true });
      const urls = (info?.lanUrls || []).filter((u): u is string => typeof u === "string");
      setLanUrls(urls);
      if (urls.length) {
        setForm((f) => ({ ...f, serverUrl: f.serverUrl || urls[0] }));
        toast("已开启，把地址填到手机上即可");
      } else {
        toast("已开启，但没找到局域网地址——确认这台电脑连着 Wi-Fi 或网线");
      }
    } catch (err) {
      toast(String((err as Error)?.message || err), "error");
    } finally {
      setLanBusy(false);
    }
  };

  const disableLan = async () => {
    const ok = await confirm(
      "家里其他设备将无法连到这台电脑。已经在同步的设备不受影响，只是下次连不上。",
      { title: "关闭对外服务", confirmText: "关闭", danger: false }
    );
    if (!ok) return;
    setLanBusy(true);
    try {
      await shellInvoke<ShellInfo>("set_lan_share", { enabled: false });
      setLanUrls([]);
      toast("已关闭，只有这台电脑能访问");
    } catch (err) {
      toast(String((err as Error)?.message || err), "error");
    } finally {
      setLanBusy(false);
    }
  };

  const exportBackup = async () => {
    const s = await store();
    const data = exportSnapshot(s);
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `homeledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已导出，请妥善保存");
  };

  const wipe = async () => {
    const first = await confirm(
      "将删除这台设备上的全部数据（服务器上的不受影响）。此操作不可撤销。",
      { title: "清空本机数据", confirmText: "继续" }
    );
    if (!first) return;
    const second = await confirm("最后确认：真的要清空本机数据库吗？", {
      title: "最后确认",
      confirmText: "清空",
    });
    if (!second) return;
    await resetStore();
    rebootstrap();
    location.reload();
  };

  const status = useMemo(() => {
    if (!state) return null;
    if (state.error) return { tone: "danger", text: state.error };
    if (state.running) return { tone: "info", text: "正在同步…" };
    if (state.configured && !state.unlocked) return { tone: "warn", text: "已连接，但口令未解锁" };
    if (state.configured) return { tone: "ok", text: "已连接" };
    return { tone: "ok", text: "仅本机" };
  }, [state]);

  return (
    <>
      {confirmDialog}
      <div className="card">
        <div className="card-head">
          <div className="card-title">
            <Icon name="cloud" size={15} />
            数据存在哪里
          </div>
          {status && (
            <span
              className={`badge ${status.tone === "danger" ? "danger" : status.tone === "warn" ? "warn" : "ok"}`}
            >
              {status.text}
            </span>
          )}
        </div>

        <div className="col gap-8" style={{ marginBottom: 14 }}>
          <ModeRow
            active={mode === "local"}
            title="仅本机"
            desc="数据只在这台设备上。不需要网络，不需要账号，也不会同步到任何地方。"
            onClick={() => mode !== "local" && switchToLocal()}
          />
          <ModeRow
            active={mode === "sync"}
            title="本机 + 加密同步"
            desc="本机保存完整数据，断网照常使用。轻量字段同步到服务器，隐私字段与照片端到端加密。"
            onClick={() => {
              if (mode !== "sync" && state?.configured) {
                setMode("sync");
                location.reload();
              }
            }}
          />
          <ModeRow
            active={mode === "remote"}
            title="直连服务器"
            desc="界面直接读写服务器数据库，适合没有本地存储的浏览器。离线不可用。"
            onClick={() => mode !== "remote" && switchToRemote()}
          />
        </div>

        {isTauri() && !state?.configured && (
          <div
            className="row gap-8"
            style={{
              alignItems: "flex-start",
              background: "var(--brand-soft)",
              border: "1px solid var(--brand-soft-2)",
              borderRadius: "var(--radius-sm)",
              padding: "11px 13px",
              marginBottom: 14,
            }}
          >
            <Icon name="server" size={14} style={{ marginTop: 2, flex: "0 0 auto" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                这台电脑本身就能当服务器
              </div>
              {lanUrls.length > 0 ? (
                <>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-2)" }}>
                    同一个 Wi-Fi 下，手机填下面这个地址就能连过来同步。传的是密文——
                    路由器看得到流量，也读不懂里面的序列号和照片。
                  </div>
                  <div className="row gap-8 mt-8" style={{ flexWrap: "wrap" }}>
                    {lanUrls.map((u) => (
                      <span key={u} className="row gap-8">
                        <code
                          className="mono"
                          style={{
                            background: "var(--surface)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-xs)",
                            padding: "3px 8px",
                            fontSize: 12,
                          }}
                        >
                          {u}
                        </code>
                        <button
                          className="btn btn-sm"
                          onClick={() => {
                            setForm((f) => ({ ...f, serverUrl: u }));
                            toast("已填入服务器地址");
                          }}
                        >
                          用这个地址
                        </button>
                      </span>
                    ))}
                    <button className="btn btn-sm" disabled={lanBusy} onClick={disableLan}>
                      {lanBusy ? <Spinner /> : null}
                      关闭对外服务
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-2)" }}>
                    默认只服务这台电脑。打开之后，同一 Wi-Fi 下的手机才能连过来——
                    不需要另外买 NAS 或云主机。传的是密文，路由器读不懂内容。
                  </div>
                  <button
                    className="btn btn-sm btn-primary mt-8"
                    disabled={lanBusy}
                    onClick={enableLan}
                  >
                    {lanBusy ? <Spinner /> : <Icon name="server" size={13} />}
                    允许家庭内设备连接
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {!state?.configured && (
          <>
            <div className="hint mb-12">
              连接后，本机已有数据会作为第一批内容推送上去；如果服务器上已经有这个家庭的数据，
              会先拉下来再合并。两端都按写入时间取新，冲突不会丢数据。
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="label">服务器地址</label>
                <input
                  className="input mono"
                  placeholder="http://192.168.1.10:8000"
                  value={form.serverUrl}
                  onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">家庭名称（新建时使用）</label>
                <input
                  className="input"
                  value={form.familyName}
                  onChange={(e) => setForm({ ...form, familyName: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">服务器账号</label>
                <input
                  className="input"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">账号密码</label>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">同步口令（端到端加密）</label>
                <input
                  className="input"
                  type="password"
                  placeholder="至少 8 位，务必记住"
                  value={form.passphrase}
                  onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">再输一次</label>
                <input
                  className="input"
                  type="password"
                  value={form.confirm}
                  onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                />
              </div>
            </div>
            <label className="row gap-8 mt-12" style={{ fontSize: 12.5, color: "var(--text-2)" }}>
              <input
                type="checkbox"
                checked={form.createAccount}
                onChange={(e) => setForm({ ...form, createAccount: e.target.checked })}
              />
              在这台服务器上新注册账号（取消则用已有账号登录）
            </label>
            {error && (
              <div className="hint" style={{ color: "var(--danger)", marginTop: 10 }}>
                {error}
              </div>
            )}
            <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={handleLink} disabled={busy}>
                {busy ? <Spinner /> : <Icon name="link" size={14} />}
                连接并开始同步
              </button>
            </div>
          </>
        )}

        {state?.configured && (
          <>
            <div className="provider-row">
              <div className="provider-ic">
                <Icon name="server" size={15} />
              </div>
              <div className="grow">
                <div className="selectable" style={{ fontSize: 13, fontWeight: 550 }}>
                  {state.server_url}
                </div>
                <div className="tiny faint">{state.account || "已连接"} · 端到端加密</div>
              </div>
              <span className={`status-dot ${state.unlocked ? "ok" : "off"}`} />
            </div>
            <div className="provider-row">
              <div className="provider-ic">
                <Icon name="refresh" size={15} />
              </div>
              <div className="grow">
                <div style={{ fontSize: 13, fontWeight: 550 }}>
                  {state.running ? "正在同步…" : "上次同步"}
                </div>
                <div className="tiny faint">
                  {state.last_sync_at ? fmtDateTime(state.last_sync_at) : "尚未同步"} ·{" "}
                  {state.pending} 条待推送
                </div>
              </div>
              <button className="btn btn-sm" onClick={handleSync} disabled={busy || !state.unlocked}>
                立即同步
              </button>
            </div>

            {!state.unlocked && (
              <div className="col gap-8 mt-12">
                <div className="hint">
                  这台设备还没有解锁同步口令。输入口令后即可解密云端数据。
                </div>
                <div className="row gap-8">
                  <input
                    className="input"
                    type="password"
                    placeholder="同步口令"
                    value={unlockPass}
                    onChange={(e) => setUnlockPass(e.target.value)}
                  />
                  <button className="btn btn-primary" onClick={handleUnlock} disabled={busy}>
                    解锁
                  </button>
                </div>
              </div>
            )}

            <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
              {state.unlocked && (
                <button className="btn" onClick={handleLock} disabled={busy}>
                  锁定口令
                </button>
              )}
              <button className="btn" onClick={handleUnlink} disabled={busy}>
                断开同步
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">
            <Icon name="shield" size={15} />
            加密与分层
          </div>
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          服务器保存两类东西，用途不同：
        </div>
        <div className="provider-row">
          <div className="provider-ic">
            <Icon name="database" size={15} />
          </div>
          <div className="grow">
            <div style={{ fontSize: 13, fontWeight: 550 }}>轻量元数据（明文）</div>
            <div className="tiny faint">
              名称、编号、分类、位置、状态、数量、时间戳。用于让新设备在输入口令前也能看到列表。
            </div>
          </div>
        </div>
        <div className="provider-row">
          <div className="provider-ic">
            <Icon name="lock" size={15} />
          </div>
          <div className="grow">
            <div style={{ fontSize: 13, fontWeight: 550 }}>隐私字段与全部附件（密文）</div>
            <div className="tiny faint">
              序列号、价格、购买渠道、描述、备注，以及所有照片文件。XChaCha20-Poly1305，密钥只存在你的设备上。
            </div>
          </div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          同步口令不会上传。忘记口令等于丢失云端隐私字段，服务器无法帮你恢复——这是端到端加密的代价，
          也是它唯一诚实的承诺。
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">
            <Icon name="qr" size={15} />
            二维码查看服务
          </div>
          <span
            className={`badge ${qr?.state === "awake" ? "ok" : ""}`}
            style={{ fontSize: 11.5 }}
          >
            {qr ? (qr.state === "awake" ? `服务中 · ${qr.viewers} 台设备` : "静默中") : "未知"}
          </span>
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-2)" }}>
          贴在东西上的二维码指向服务器，扫码就能看到这件东西——不用装 App，也不用登录。
          页面每 5 秒发一次心跳；关掉页面 {String(qr?.idle_seconds ?? 90)} 秒后服务自动休眠，
          平时不占内存也不跑线程。
        </div>
        <div className="mt-12" style={{ display: "grid", gap: 7 }}>
          <div className="row gap-8" style={{ justifyContent: "space-between" }}>
            <span className="tiny faint">标签指向</span>
            <code className="mono" style={{ fontSize: 12 }}>
              {String(qr?.base ?? "—")}
            </code>
          </div>
          <div className="row gap-8" style={{ justifyContent: "space-between" }}>
            <span className="tiny faint">访问范围</span>
            <span style={{ fontSize: 12.5 }}>
              {qr?.lan_only ? "仅家庭内网" : "任何能连上的网络"}
            </span>
          </div>
          <div className="row gap-8" style={{ justifyContent: "space-between" }}>
            <span className="tiny faint">最近一次扫描</span>
            <span style={{ fontSize: 12.5 }}>
              {typeof qr?.last_scan_at === "string" ? fmtDateTime(qr.last_scan_at) : "还没人扫过"}
            </span>
          </div>
          <div className="row gap-8" style={{ justifyContent: "space-between" }}>
            <span className="tiny faint">累计查看</span>
            <span style={{ fontSize: 12.5 }}>{String(qr?.views_total ?? 0)} 次</span>
          </div>
        </div>
        {qr && qr.reachable === false && (
          <div className="hint" style={{ marginTop: 10, color: "var(--danger)" }}>
            服务器现在只听本机回环地址，手机扫了会打不开。打开上面的「允许家庭内设备连接」后再打印标签。
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">
            <Icon name="hard-drive" size={15} />
            本机数据
          </div>
          <div className="row gap-6">
            <button className="btn btn-sm" onClick={exportBackup}>
              <Icon name="download" size={13} />
              导出快照
            </button>
          </div>
        </div>
        <div className="hint">
          本机数据存放在{isTauri() ? "应用数据目录" : "浏览器数据库"}里。清除浏览器数据、卸载应用都会删除它；
          定期导出快照，或开启同步，才不会只剩下一个空壳。
        </div>
        <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-sm btn-danger" onClick={wipe}>
            清空本机数据
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">
            <Icon name="sliders" size={15} />
            高级
          </div>
          <button className="btn btn-sm" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "收起" : "展开"}
          </button>
        </div>
        {showAdvanced && (
          <div className="hint">
            当前运行环境：{isTauri() ? "桌面 / 移动应用" : "浏览器"}。<br />
            桌面端与移动端默认使用本机数据库；浏览器默认直连服务器，以免既有网关部署被无意切换。
            切换后页面会重新加载，本机数据保留在原处、互不影响。
          </div>
        )}
      </div>
    </>
  );
}

function ModeRow(props: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`mode-row ${props.active ? "active" : ""}`}
      onClick={props.onClick}
      type="button"
    >
      <div className="mode-dot" />
      <div className="grow" style={{ textAlign: "left" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{props.title}</div>
        <div className="tiny faint" style={{ lineHeight: 1.55, marginTop: 2 }}>
          {props.desc}
        </div>
      </div>
      {props.active && <Icon name="check" size={15} />}
    </button>
  );
}
