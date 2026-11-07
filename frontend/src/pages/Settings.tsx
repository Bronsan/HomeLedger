import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, authedUrl, del, get, getMode, patch, post, setMode, tokenStore } from "../api/client";
import type { Backup, Family, DeploymentInfo } from "../api/types";
import { Icon } from "../components/icons";
import { SyncPanel } from "../components/SyncPanel";
import {
  ConfirmDialog,
  Empty,
  Modal,
  PillGroup,
  SlidingIndicator,
  Spinner,
  useToast,
} from "../components/ui";
import { ROLE_LABEL, useAuth } from "../hooks/auth";
import { APP_VERSION } from "../lib/build";
import { fmtBytes, fmtDateTime } from "../lib/format";
import { entryStore, serviceSession } from "../lib/service";
import {
  BACKGROUNDS,
  FORMULAS,
  PALETTES,
  applyAccent,
  applyBg,
  currentAccent,
  currentBg,
} from "../lib/theme";
import { applyThemeChoice, type ThemeChoice } from "../lib/theme-transition";

type Tab = "family" | "sync" | "deploy" | "data" | "account";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "family", label: "家庭", icon: "home" },
  { key: "sync", label: "同步", icon: "cloud" },
  { key: "deploy", label: "部署", icon: "server" },
  { key: "data", label: "数据与备份", icon: "database" },
  { key: "account", label: "账号", icon: "user" },
];

interface Providers {
  database: { dialect: string; ok: boolean; concurrent_writers?: boolean; recommended_mode?: string };
  storage: { ok: boolean; backend: string; root?: string };
  backup: { ok: boolean; backend: string; dir?: string };
  notifications: { ok: boolean; channel: string }[];
  ai: { name: string; supports_vision: boolean; leaves_device: boolean; privacy_notice: string };
  deployment: DeploymentInfo;
}

interface PublicInfo {
  registered_users?: number;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.replace(/^\ufeff/, ""));
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] || ""));
    return row;
  });
}

export function SettingsPage() {
  const { user, family, refresh, logout, can, deployment } = useAuth();
  // Server backups and provider details are instance administration now, not
  // household permissions. In local/sync mode the same tab manages this
  // device's exports, so the household permission still applies there.
  const serverAdmin = Boolean(user?.is_instance_admin);
  const remote = getMode() === "remote";
  const backupAllowed = remote ? serverAdmin : can("system.backup");
  const restoreAllowed = remote && serverAdmin;
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "family";
  // 配色与背景改的是 document 属性（不走 React 状态），tick 只负责刷新选中态。
  const [accentTick, setAccentTick] = useState(0);
  const accent = useMemo(() => currentAccent(), [tab, accentTick]);
  const bg = useMemo(() => currentBg(), [tab, accentTick]);
  const currentPalette = PALETTES.find((p) => p.key === accent) ?? PALETTES[0];
  // 配色默认收起：25 枚色卡一次铺开会把外观卡撑得很长。
  const [paletteOpen, setPaletteOpen] = useState(false);

  const [providers, setProviders] = useState<Providers | null>(null);
  const [publicInfo, setPublicInfo] = useState<PublicInfo | null>(null);
  // 安装版第一次启动选的使用方式；浏览器版没有这一层，保持 null。
  const [entry, setEntry] = useState(() => entryStore.get());
  const serviceUser = serviceSession.user();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [familyName, setFamilyName] = useState(family?.name || "");
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [colors] = useState(["#0d6b5f", "#b45309", "#6d28d9", "#be123c", "#0369a1", "#4d7c0f"]);
  const [avatarColor, setAvatarColor] = useState(user?.avatar_color || "#0d6b5f");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // undefined = 不动；"" = 移除；dataURL = 上传。点「保存资料」时随资料一起提交
  const [pendingAvatar, setPendingAvatar] = useState<string | undefined>(undefined);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Backup | null>(null);
  const [restoreText, setRestoreText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Backup | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<{
    created: number;
    skipped: number;
    errors: { row: number; message: string }[];
    preview: { row: number; code: string; name: string }[];
    new_categories: string[];
    new_locations: string[];
  } | null>(null);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "light");

  const loadBackups = useCallback(async () => {
    try {
      const res = await get<{ items: Backup[] }>("/system/backups");
      setBackups(res.items);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    get<Providers>("/system/providers").then(setProviders).catch(() => {});
    get<PublicInfo>("/system/info").then(setPublicInfo).catch(() => {});
  }, []);

  useEffect(() => {
    setFamilyName(family?.name || "");
  }, [family]);

  useEffect(() => {
    setDisplayName(user?.display_name || "");
    setAvatarColor(user?.avatar_color || "#0d6b5f");
  }, [user]);

  useEffect(() => {
    if (tab === "data") void loadBackups();
  }, [tab, loadBackups]);

  const applyTheme = (t: ThemeChoice) => {
    applyThemeChoice(t, () => {
      // 让主题按钮的选中态和新的配色在同一帧被浏览器抓进过渡的新快照。
      flushSync(() => setTheme(t));
    });
  };

  const saveFamily = async () => {
    setBusy(true);
    try {
      await patch("/families/current", { name: familyName });
      await refresh();
      toast("家庭信息已更新");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    try {
      await patch("/auth/me", {
        display_name: displayName,
        avatar_color: avatarColor,
        ...(pendingAvatar !== undefined ? { avatar_data: pendingAvatar } : {}),
      });
      setPendingAvatar(undefined);
      await refresh();
      toast("个人资料已更新");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (pw.next !== pw.confirm) {
      toast("两次输入的新密码不一致", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await post<{ token: string }>("/auth/change-password", {
        current_password: pw.current,
        new_password: pw.next,
      });
      localStorage.setItem("hl_token", res.token);
      setPw({ current: "", next: "", confirm: "" });
      toast("密码已更新，其它设备需要重新登录");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const createBackup = async () => {
    setBusy(true);
    try {
      await post("/system/backups", { note: "手动备份", include_files: true });
      toast(getMode() === "remote" ? "备份已创建" : "快照已导出到下载目录");
      await loadBackups();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async (b: Backup) => {
    if (getMode() !== "remote") {
      toast("本机备份在创建时已直接下载到浏览器下载目录");
      return;
    }
    try {
      // authedUrl carries the server origin for direct-mode/Tauri builds and a
      // query token for this GET, which the download route explicitly allows.
      const res = await fetch(authedUrl(`/system/backups/${encodeURIComponent(b.filename)}/download`));
      if (!res.ok) throw new Error("下载失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = b.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const runImport = async (dry: boolean) => {
    const rows = parseCsv(importText);
    if (rows.length === 0) {
      toast("没有解析到数据行，请检查格式", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{
        created: number;
        skipped: number;
        errors: { row: number; message: string }[];
        preview: { row: number; code: string; name: string }[];
        new_categories: string[];
        new_locations: string[];
      }>("/items/import", {
        method: "POST",
        body: { rows, dry_run: dry, create_missing_taxonomy: true },
      });
      setImportPreview(res);
      if (!dry) {
        toast(`已导入 ${res.created} 件物品`);
        setImportOpen(false);
        setImportText("");
        nav("/items");
      } else {
        toast(`预检：将导入 ${res.created} 行`);
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  /** 回到欢迎页重新选：本机 / 联网账号。 */
  const reopenEntry = () => {
    entryStore.clear();
    setEntry(null);
    nav("/welcome");
  };

  const switchServiceAccount = () => {
    serviceSession.clear();
    reopenEntry();
  };

  const useLocalEntry = () => {
    serviceSession.clear();
    entryStore.set("local");
    setMode("local");
    tokenStore.set("local");
    setEntry("local");
    toast("已切换到本机模式");
  };

  const modeInfo = useMemo(() => {
    if (!providers) return null;
    return providers.deployment;
  }, [providers]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">设置</h1>
          <div className="sub">
            {family?.name} · {ROLE_LABEL[(family?.my_role as never) || "member"]}
          </div>
        </div>
      </div>

      <div className="settings-grid">
        <div className="settings-nav">
          <SlidingIndicator activeKey={tab} className="settings-nav-indicator" />
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`settings-nav-item ${tab === t.key ? "active" : ""}`}
              onClick={() => setParams({ tab: t.key })}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <Icon name={t.icon} size={14} />
                {t.label}
              </span>
            </button>
          ))}
        </div>

        <div className="col gap-16">
          {tab === "family" && (
            <>
              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="home" size={15} />
                    家庭信息
                  </div>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label className="label">家庭名称</label>
                    <input
                      className="input"
                      value={familyName}
                      onChange={(e) => setFamilyName(e.target.value)}
                      disabled={!can("system.deploy")}
                    />
                  </div>
                  <div className="field">
                    <label className="label">邀请码</label>
                    <div className="input mono" style={{ display: "flex", alignItems: "center" }}>
                      {family?.invite_code}
                    </div>
                  </div>
                  <div className="field">
                    <label className="label">部署模式</label>
                    <div className="input" style={{ display: "flex", alignItems: "center" }}>
                      {deployment?.label || "—"}
                    </div>
                  </div>
                  <div className="field">
                    <label className="label">创建时间</label>
                    <div className="input num" style={{ display: "flex", alignItems: "center" }}>
                      {family?.created_at ? fmtDateTime(family.created_at) : "—"}
                    </div>
                  </div>
                </div>
                {can("system.deploy") && (
                  <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
                    <button className="btn btn-primary" onClick={saveFamily} disabled={busy}>
                      {busy ? <Spinner /> : <Icon name="check" size={14} />}
                      保存
                    </button>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="users" size={15} />
                    成员
                  </div>
                  <button className="btn btn-sm" onClick={() => nav("/members")}>
                    管理成员与权限
                    <Icon name="chevron-right" size={13} />
                  </button>
                </div>
                <div className="hint">
                  角色分为所有者、管理员、普通成员、只读成员、访客。权限按物品、文档、维护、成员、
                  系统五个维度细粒度控制，可针对单个成员做额外授予或禁止。
                </div>
              </div>
            </>
          )}

          {tab === "sync" && <SyncPanel />}

          {tab === "deploy" && (
            <>
              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="server" size={15} />
                    当前部署
                  </div>
                  <span className="badge brand">{modeInfo?.label || deployment?.label}</span>
                </div>
                <div className="mode-cards">
                  {(
                    [
                      { key: "local", t: "本地单机", d: "数据不离开这台设备，适合个人使用" },
                      { key: "gateway", t: "家庭网关", d: "常驻家中的 NAS / 迷你主机，全家局域网使用" },
                      { key: "cloud", t: "云服务器", d: "异地访问与远程协作，可对接对象存储" },
                    ] as const
                  ).map((m) => (
                    <div
                      className={`mode-card ${modeInfo?.mode === m.key ? "active" : ""}`}
                      key={m.key}
                    >
                      {modeInfo?.mode === m.key && (
                        <span className="badge brand mc-badge">当前</span>
                      )}
                      <div className="mc-t">
                        <Icon
                          name={m.key === "local" ? "laptop" : m.key === "gateway" ? "hard-drive" : "cloud"}
                          size={14}
                        />
                        {m.t}
                      </div>
                      <div className="mc-d">{m.d}</div>
                    </div>
                  ))}
                </div>
                {modeInfo && modeInfo.warnings.length > 0 && (
                  <div className="mt-16 col gap-8">
                    {modeInfo.warnings.map((w, i) => (
                      <div
                        key={i}
                        className="row gap-8"
                        style={{
                          fontSize: 12,
                          color: "var(--amber)",
                          background: "var(--amber-soft)",
                          padding: "9px 11px",
                          borderRadius: "var(--radius-xs)",
                          alignItems: "flex-start",
                        }}
                      >
                        <Icon name="alert" size={13} style={{ marginTop: 1, flex: "0 0 auto" }} />
                        <span style={{ lineHeight: 1.55 }}>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="layers" size={15} />
                    服务组件
                  </div>
                  <span className="tiny faint">可替换的基础设施提供者</span>
                </div>
                {providers ? (
                  <>
                    <div className="provider-row">
                      <div className="provider-ic">
                        <Icon name="database" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>数据库</div>
                        <div className="tiny faint">
                          {providers.database.dialect.toUpperCase()} ·{" "}
                          {providers.database.concurrent_writers ? "支持并发写入" : "写入串行化"}
                        </div>
                      </div>
                      <span className={`status-dot ${providers.database.ok ? "ok" : "off"}`} />
                    </div>
                    <div className="provider-row">
                      <div className="provider-ic">
                        <Icon name="hard-drive" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>附件存储</div>
                        <div className="tiny faint">
                          {providers.storage.backend === "local" ? "本地文件系统" : "S3 兼容对象存储"}
                          {providers.storage.root ? ` · ${providers.storage.root}` : ""}
                        </div>
                      </div>
                      <span className={`status-dot ${providers.storage.ok ? "ok" : "off"}`} />
                    </div>
                    <div className="provider-row">
                      <div className="provider-ic">
                        <Icon name="archive" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>备份</div>
                        <div className="tiny faint">{providers.backup.dir || "本地目录"}</div>
                      </div>
                      <span className={`status-dot ${providers.backup.ok ? "ok" : "off"}`} />
                    </div>
                    <div className="provider-row">
                      <div className="provider-ic">
                        <Icon name="sparkles" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>AI 识别</div>
                        <div className="tiny faint">{providers.ai.privacy_notice}</div>
                      </div>
                      <span className="badge">{providers.ai.name}</span>
                    </div>
                    <div className="provider-row">
                      <div className="provider-ic">
                        <Icon name="bell" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 13, fontWeight: 550 }}>通知通道</div>
                        <div className="tiny faint">
                          {providers.notifications.map((n) => n.channel).join(" / ")}
                        </div>
                      </div>
                      <span className="status-dot ok" />
                    </div>
                  </>
                ) : (
                  <div className="skeleton" style={{ height: 120 }} />
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="check-circle" size={15} />
                    上线检查清单
                  </div>
                </div>
                <div className="col gap-8">
                  {(modeInfo?.checklist || []).map((c) => (
                    <label className="checkbox" key={c.key}>
                      <input type="checkbox" defaultChecked={c.done} />
                      <span className="box">
                        <Icon name="check" size={11} />
                      </span>
                      <span>{c.label}</span>
                    </label>
                  ))}
                </div>
                <div className="hint mt-12">
                  清单仅作提示，不会自动检测。数据目录：
                  <span className="mono"> {modeInfo?.data_dir}</span>
                </div>
              </div>
            </>
          )}

          {tab === "data" && (
            <>
              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="archive" size={15} />
                    备份
                  </div>
                  <div className="row gap-6">
                    {backupAllowed && (
                      <button className="btn btn-sm btn-primary" onClick={createBackup} disabled={busy}>
                        {busy ? <Spinner size={13} /> : <Icon name="plus" size={13} />}
                        立即备份
                      </button>
                    )}
                  </div>
                </div>
                <div className="hint mb-12">
                  {remote
                    ? serverAdmin
                      ? "服务器备份包含数据库快照、全部附件与同步密文 blob，可在同一实例上恢复。恢复会覆盖整库并要求重启服务。"
                      : "服务器备份与恢复由实例管理员维护，家庭成员不能读取或覆盖整库。你可以随时导出自己的数据。"
                    : "本机模式的「备份」是导出：一份 JSON 快照直接下载到系统下载目录，含物品、位置、分类与维护记录。下面这行记录只是留痕，不替你保管文件——重要数据请自己再复制一份到别处。"}
                </div>
                {backups.length === 0 && (
                  <Empty icon="archive" title="还没有备份" desc="点击「立即备份」创建第一份完整快照" />
                )}
                <div className="col">
                  {backups.map((b) => (
                    <div className="provider-row" key={b.id}>
                      <div className="provider-ic">
                        <Icon name="database" size={15} />
                      </div>
                      <div className="grow">
                        <div style={{ fontSize: 12.5, fontWeight: 550 }} className="mono">
                          {b.filename}
                        </div>
                        <div className="tiny faint">
                          {fmtBytes(b.size_bytes)} · {b.includes_files ? "含附件" : "仅数据库"} ·{" "}
                          {fmtDateTime(b.created_at)} · {b.kind === "auto" ? "自动" : "手动"}
                        </div>
                      </div>
                      <button className="btn btn-sm" onClick={() => downloadBackup(b)}>
                        <Icon name="download" size={13} />
                      </button>
                      {/* 恢复要覆盖整库，只有「服务器是数据库」的模式做得到。
                          本机/同步模式下数据库在设备里，点下去只会得到一句
                          「本机模式暂不支持该操作」，不如不给这个按钮。 */}
                      {restoreAllowed && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => {
                            setRestoreTarget(b);
                            setRestoreText("");
                          }}
                        >
                          恢复
                        </button>
                      )}
                      {backupAllowed && (
                        <button
                          className="icon-btn"
                          title="删除这条备份记录"
                          onClick={() => setDeleteTarget(b)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="download" size={15} />
                    导出
                  </div>
                </div>
                <div className="row gap-8 wrap">
                  <a
                    className="btn btn-sm"
                    href="/api/v1/items/export.csv"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="file-text" size={13} />
                    导出 CSV（表格）
                  </a>
                  <a
                    className="btn btn-sm"
                    href="/api/v1/system/export.json"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="file" size={13} />
                    导出 JSON（完整）
                  </a>
                  <button
                    className="btn btn-sm"
                    onClick={() => nav("/labels")}
                    title="去标签页挑选物品、预览后再打印"
                  >
                    <Icon name="printer" size={13} />
                    打印标签
                  </button>
                </div>
                <div className="hint mt-10">
                  导出为只读文件，适合迁移或做离线存档；恢复请使用上方的备份包。
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="upload" size={15} />
                    批量导入
                  </div>
                  <button className="btn btn-sm" onClick={() => setImportOpen(true)}>
                    粘贴 CSV 导入
                  </button>
                </div>
                <div className="hint">
                  支持从 Excel 或其它家庭清单迁移。表头可用中英文（名称 / 分类 / 位置 / 品牌 /
                  型号 / 序列号 / 条码 / 价格 / 购买日期 / 保修截止 / 标签）。导入前会自动预检，
                  不会写入脏数据。
                </div>
              </div>
            </>
          )}

          {tab === "account" && (
            <>
              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="user" size={15} />
                    个人资料
                  </div>
                </div>
                <div className="row gap-16 mb-16">
                  <div
                    className="avatar lg"
                    style={{
                      width: 52,
                      height: 52,
                      fontSize: 20,
                      overflow: "hidden",
                      background: pendingAvatar
                        ? "transparent"
                        : avatarColor,
                    }}
                  >
                    {pendingAvatar ? (
                      <img
                        src={pendingAvatar}
                        alt="头像预览"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : user?.avatar_url ? (
                      <img src={user.avatar_url} alt="头像" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      (displayName || "?").slice(0, 1)
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{user?.email}</div>
                    <div className="tiny faint">
                      加入于 {family?.created_at ? fmtDateTime(family.created_at) : "—"}
                    </div>
                    <div className="row gap-6 mt-8">
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (!f) return;
                          if (f.size > 750 * 1024) {
                            toast("头像图片请小于 750KB", "error");
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () => setPendingAvatar(String(reader.result));
                          reader.readAsDataURL(f);
                        }}
                      />
                      <button className="btn btn-sm btn-ghost" onClick={() => avatarInputRef.current?.click()}>
                        <Icon name="upload" size={13} />
                        上传头像
                      </button>
                      {(pendingAvatar !== undefined || user?.avatar_url) && (
                        <button
                          className="btn btn-sm btn-ghost"
                          style={{ color: "var(--danger)" }}
                          onClick={() => setPendingAvatar("")}
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label className="label">显示名称</label>
                    <input
                      className="input"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="label">头像颜色</label>
                    <div className="row gap-6" style={{ height: 36, alignItems: "center" }}>
                      {colors.map((c) => (
                        <button
                          key={c}
                          onClick={() => setAvatarColor(c)}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: "var(--radius-xs)",
                            background: c,
                            border:
                              avatarColor === c ? "2.5px solid var(--text)" : "2px solid transparent",
                            cursor: "pointer",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
                  <button className="btn btn-primary" onClick={saveProfile} disabled={busy}>
                    {busy ? <Spinner /> : <Icon name="check" size={14} />}
                    保存资料
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="lock" size={15} />
                    修改密码
                  </div>
                </div>
                <div className="form-grid">
                  <div className="field span-2">
                    <label className="label">当前密码</label>
                    <input
                      className="input"
                      type="password"
                      value={pw.current}
                      onChange={(e) => setPw({ ...pw, current: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="label">新密码</label>
                    <input
                      className="input"
                      type="password"
                      value={pw.next}
                      onChange={(e) => setPw({ ...pw, next: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="label">确认新密码</label>
                    <input
                      className="input"
                      type="password"
                      value={pw.confirm}
                      onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                    />
                  </div>
                </div>
                <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
                  <button
                    className="btn"
                    onClick={changePassword}
                    disabled={busy || !pw.current || pw.next.length < 8}
                  >
                    更新密码
                  </button>
                </div>
                <div className="hint mt-10">修改后本机会自动使用新令牌，其它设备需要重新登录。</div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="shield" size={15} />
                    隐私与数据
                  </div>
                </div>
                <div className="hint" style={{ lineHeight: 1.7 }}>
                  物品、照片和附件默认只保存在本机。连接账号服务器时，服务器只保存
                  登录所需的最少信息：邮箱、密码哈希、显示名和家庭成员关系。
                </div>
                <div className="hint mt-8" style={{ lineHeight: 1.7 }}>
                  不采集手机号、真实姓名、住址、定位、通讯录、设备标识或使用行为；
                  审计日志只记录“谁改了什么”，不保存 IP 地址或浏览器标识。只有你
                  主动开启加密同步时，服务器才会收到同步索引与密文；敏感字段和照片
                  在离开设备前已经加密。
                </div>
                {publicInfo?.registered_users != null && (
                  <div
                    className="row-between mt-14"
                    style={{ fontSize: 12.5, paddingTop: 12, borderTop: "1px solid var(--border)" }}
                  >
                    <span className="muted">当前服务器注册账号</span>
                    <b>{publicInfo.registered_users} 个</b>
                  </div>
                )}
                <div className="tiny faint mt-8">
                  注册人数只统计账号总数，不展示任何个人信息。
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name={theme === "dark" ? "moon" : "sun"} size={15} />
                    外观
                  </div>
                </div>
                <PillGroup>
                  <button
                    className={`pill ${theme === "light" ? "active" : ""}`}
                    onClick={() => applyTheme("light")}
                    aria-pressed={theme === "light"}
                  >
                    浅色
                  </button>
                  <button
                    className={`pill ${theme === "dark" ? "active" : ""}`}
                    onClick={() => applyTheme("dark")}
                    aria-pressed={theme === "dark"}
                  >
                    深色
                  </button>
                  <button
                    className={`pill ${theme === "system" ? "active" : ""}`}
                    onClick={() => applyTheme("system")}
                    aria-pressed={theme === "system"}
                  >
                    跟随系统
                  </button>
                </PillGroup>
                <button
                  type="button"
                  className={`appearance-toggle ${paletteOpen ? "open" : ""}`}
                  aria-expanded={paletteOpen}
                  aria-controls="appearance-palettes"
                  onClick={() => setPaletteOpen((v) => !v)}
                >
                  <span className="appearance-toggle-main">
                    <span className="palette-swatch" aria-hidden="true">
                      <i style={{ background: currentPalette.dot }} />
                      <i style={{ background: currentPalette.glowA }} />
                      <i style={{ background: currentPalette.glowB }} />
                    </span>
                    <span className="appearance-toggle-text">
                      <span className="appearance-toggle-label">配色方案</span>
                      <span className="appearance-toggle-current">{currentPalette.label}</span>
                    </span>
                  </span>
                  <Icon name={paletteOpen ? "chevron-up" : "chevron-down"} size={15} />
                </button>
                {paletteOpen && (
                  <div id="appearance-palettes" className="appearance-palette-panel">
                    <div className="hint" style={{ marginTop: 2 }}>
                      按六种色彩公式分组；强调色与两束背景环境光一起换。
                    </div>
                    <div className="palette-groups">
                      {FORMULAS.map((f) => (
                        <div className="palette-group" key={f.key}>
                          <div className="palette-group-head">
                            <span className="palette-group-name">{f.label}</span>
                            <span className="palette-group-hint">{f.hint}</span>
                          </div>
                          <div className="palette-row">
                            {PALETTES.filter((p) => p.formula === f.key).map((p) => (
                              <button
                                key={p.key || "default"}
                                className={`palette-chip ${accent === p.key ? "active" : ""}`}
                                title={p.label}
                                aria-label={`配色方案：${p.label}（${f.label}）`}
                                aria-pressed={accent === p.key}
                                onClick={() => {
                                  applyAccent(p.key);
                                  setAccentTick((t) => t + 1);
                                }}
                              >
                                <span className="palette-swatch" aria-hidden="true">
                                  <i style={{ background: p.dot }} />
                                  <i style={{ background: p.glowA }} />
                                  <i style={{ background: p.glowB }} />
                                </span>
                                <span className="palette-name">{p.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-14" style={{ fontWeight: 600, fontSize: 13 }}>
                  背景
                </div>
                <div className="hint" style={{ marginTop: 2 }}>
                  底色纹理与环境光，可与任意配色组合。
                </div>
                <div className="bg-tiles mt-10">
                  {BACKGROUNDS.map((b) => (
                    <button
                      key={b.key || "default"}
                      className={`bg-tile ${bg === b.key ? "active" : ""}`}
                      title={b.label}
                      aria-label={`背景：${b.label}`}
                      aria-pressed={bg === b.key}
                      onClick={() => {
                        applyBg(b.key);
                        setAccentTick((t) => t + 1);
                      }}
                    >
                      <span
                        className={`bg-tile-preview bg-tile-preview-${b.key || "default"}`}
                        aria-hidden="true"
                      />
                      <span className="bg-tile-name">{b.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name={entry === "online" ? "cloud" : "hard-drive"} size={15} />
                    使用方式
                  </div>
                </div>
                {entry === "online" ? (
                  <>
                    <div className="row-between" style={{ fontSize: 12.5 }}>
                      <span className="muted">联网账号</span>
                      <b>{serviceUser?.email || "已登录"}</b>
                    </div>
                    <div className="hint mt-8" style={{ lineHeight: 1.7 }}>
                      账号保存在服务服务器，每次启动验证一次；物品数据仍只在本机。
                    </div>
                    <div className="row gap-8 mt-12" style={{ flexWrap: "wrap" }}>
                      <button className="btn" onClick={switchServiceAccount}>
                        切换账号
                      </button>
                      <button className="btn" onClick={useLocalEntry}>
                        改回本机模式
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="hint" style={{ lineHeight: 1.7 }}>
                      当前是本机模式，不需要账号，物品数据只保存在这台设备。
                    </div>
                    <button className="btn mt-12" onClick={reopenEntry}>
                      改用联网账号
                    </button>
                  </>
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">
                    <Icon name="log-out" size={15} />
                    会话
                  </div>
                </div>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (getMode() === "remote") {
                      logout();
                      nav("/login");
                    } else {
                      switchServiceAccount();
                    }
                  }}
                >
                  <Icon name="log-out" size={14} />
                  {getMode() === "remote" ? "退出登录" : "切换使用方式"}
                </button>
              </div>

              <div className="hint" style={{ textAlign: "center" }}>
                HomeLedger v{deployment?.version || APP_VERSION}
              </div>
              {deployment?.version && deployment.version !== APP_VERSION && (
                <div className="hint" style={{ textAlign: "center", color: "var(--amber)" }}>
                  服务端是 v{deployment.version}，这份界面是 v{APP_VERSION}——两边不是同一次发布，
                  检查一下是不是装到了旧的安装包，或者浏览器缓存了旧界面。
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        open={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        title="恢复数据"
        subtitle={restoreTarget?.filename}
        footer={
          <>
            <button className="btn" onClick={() => setRestoreTarget(null)}>
              取消
            </button>
            <button
              className="btn btn-danger"
              disabled={restoreText !== "RESTORE" || busy}
              onClick={async () => {
                if (!restoreTarget) return;
                setBusy(true);
                try {
                  const res = await post<{ message: string; pre_restore_backup: string }>(
                    "/system/backups/restore",
                    { filename: restoreTarget.filename, confirm: "RESTORE" }
                  );
                  toast(res.message);
                  setRestoreTarget(null);
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认恢复
            </button>
          </>
        }
      >
        <div className="col gap-14" style={{ gap: 14 }}>
          <div
            className="row gap-8"
            style={{
              fontSize: 12.5,
              color: "var(--danger)",
              background: "var(--danger-soft)",
              padding: "10px 12px",
              borderRadius: "var(--radius-xs)",
              alignItems: "flex-start",
            }}
          >
            <Icon name="alert" size={14} style={{ marginTop: 1, flex: "0 0 auto" }} />
            <div style={{ lineHeight: 1.6 }}>
              恢复会用备份包<strong>覆盖当前数据库与附件</strong>。系统会自动先创建一份
              「恢复前备份」，但仍建议你确认当前数据可以丢弃。
            </div>
          </div>
          <div className="field">
            <label className="label">
              输入 <span className="mono">RESTORE</span> 以确认
            </label>
            <input
              className="input mono"
              value={restoreText}
              onChange={(e) => setRestoreText(e.target.value)}
              placeholder="RESTORE"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={getMode() === "remote" ? "删除备份文件？" : "删除这条备份记录？"}
        message={
          getMode() === "remote"
            ? `${deleteTarget?.filename} 将从服务器磁盘移除，无法恢复。`
            : `${deleteTarget?.filename} 会从列表里移除。\n文件本身在创建时就下载到了系统下载目录，浏览器访问不到它——要彻底删掉，请自己去下载目录删除。`
        }
        confirmText="删除"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          // onClose 会在这一行之后立刻把 deleteTarget 置空，先把值取出来。
          const target = deleteTarget;
          if (!target) return;
          try {
            await del(`/system/backups/${encodeURIComponent(target.filename)}`);
            toast(getMode() === "remote" ? "备份已删除" : "已从列表移除");
            setBackups((prev) => prev.filter((x) => x.id !== target.id));
          } catch (err) {
            toast((err as Error).message || "删除失败", "error");
          } finally {
            await loadBackups();
          }
        }}
      />

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="批量导入物品"
        subtitle="从 Excel 复制成 CSV，或直接粘贴表格内容"
        size="wide"
        footer={
          <>
            <button className="btn" onClick={() => setImportOpen(false)}>
              取消
            </button>
            <button className="btn" onClick={() => runImport(true)} disabled={busy}>
              <Icon name="eye" size={14} />
              预检
            </button>
            <button
              className="btn btn-primary"
              onClick={() => runImport(false)}
              disabled={busy || !importPreview}
            >
              {busy ? <Spinner /> : <Icon name="upload" size={14} />}
              确认导入
            </button>
          </>
        }
      >
        <div className="col gap-12">
          <div className="field">
            <label className="label">CSV 内容</label>
            <textarea
              className="textarea mono"
              style={{ minHeight: 180, fontSize: 11.5 }}
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportPreview(null);
              }}
              placeholder={`名称,分类,位置,品牌,型号,价格,购买日期,保修截止\n戴森吸尘器,家电,储物间,Dyson,V12,3699,2024-05-01,2026-05-01\n小米路由器,数码,客厅,Xiaomi,AX3000,299,2023-11-11,2024-11-11`}
            />
          </div>
          {importPreview && (
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: 12,
                background: "var(--surface-2)",
              }}
            >
              <div className="row gap-12 mb-8" style={{ fontSize: 12.5 }}>
                <span>
                  可导入 <b>{importPreview.created}</b> 行
                </span>
                <span className="faint">跳过 {importPreview.skipped}</span>
                {importPreview.errors.length > 0 && (
                  <span style={{ color: "var(--danger)" }}>
                    {importPreview.errors.length} 行有问题
                  </span>
                )}
              </div>
              {importPreview.new_categories.length > 0 && (
                <div className="tiny faint mb-8">
                  将新建分类：{importPreview.new_categories.join("、")}
                </div>
              )}
              {importPreview.new_locations.length > 0 && (
                <div className="tiny faint mb-8">
                  将新建位置：{importPreview.new_locations.join("、")}
                </div>
              )}
              <div style={{ maxHeight: 150, overflowY: "auto" }}>
                {importPreview.preview.map((p) => (
                  <div key={p.row} className="tiny muted" style={{ padding: "2px 0" }}>
                    第 {p.row} 行 · {p.code} · {p.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
