import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import { authedUrl } from "../api/client";
import { useAuth } from "../hooks/auth";
import { BrandMark } from "./BrandMark";
import { APP_VERSION, BUILD_ID } from "../lib/build";
import { ACCENTS, applyAccent, currentAccent } from "../lib/theme";
import { applyThemeChoice } from "../lib/theme-transition";
import { Icon } from "./icons";
import { Avatar, Modal, useToast } from "./ui";
import {
  canCloseWindow,
  canOpenDataDir,
  canOpenLogs,
  canWindowControls,
  closeWindow,
  minimizeWindow,
  openDataDir,
  openLogs,
  shellInfo,
  toggleMaximizeWindow,
} from "../lib/shell";

/**
 * 左上角功能栏（桌面端）。
 *
 * 只做**一级导航之外**的事：文件操作、视图切换、关于与帮助。物品 / 维护 /
 * 设置这些都在左侧栏里，菜单里再放一遍等于给同一件事做两个入口，
 * 用户还得判断该点哪个。
 *
 * 之所以在应用内画而不是用 Tauri 的原生菜单：同一份前端产物也要在浏览器里
 * 跑，原生菜单在那边根本不存在。画在页面里，三种形态用的是同一套代码。
 */

/** Kazumi 式种子色板与开关逻辑挪进了 lib/theme.ts：设置页的外观卡（手机壳
 *  没有菜单栏）也用同一份列表，两处不会各改各的。 */

interface Item {
  label?: string;
  accel?: string;
  run?: () => void;
  separator?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** 自定义主题色板：菜单项左侧的色点（CSS 颜色值） */
  swatch?: string;
}

interface Menu {
  key: string;
  label: string;
  items: Item[];
}

export function AppMenuBar({
  navCollapsed,
  onToggleNav,
  onOpenNotifs,
  unread = 0,
}: {
  navCollapsed?: boolean;
  onToggleNav?: () => void;
  /** 右侧动作区（通知/账号）由宿主提供——桌面壳专属 */
  onOpenNotifs?: () => void;
  unread?: number;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [acctOpen, setAcctOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const [info, setInfo] = useState<{ version?: string; dataDir?: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const acctRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void shellInfo().then((v) => setInfo(v));
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const theme = () => localStorage.getItem("hl_theme") || "light";
  // 自定义主题色（Kazumi 式种子色板）：点色点即时换装，不用关菜单
  const [accentOpen, setAccentOpen] = useState(false);
  const accent = currentAccent;
  const setAccent = applyAccent;
  const setTheme = (t: "light" | "dark" | "system") => {
    applyThemeChoice(t, () => {
      // 菜单收起与换色一起进入过渡的新快照，避免过渡结束后菜单才消失。
      flushSync(() => setOpen(null));
    });
  };

  const menus: Menu[] = [
    {
      key: "file",
      label: "文件",
      items: [
        { label: "新建物品", accel: "Ctrl+N", run: () => nav("/items/new") },
        { label: "打印标签…", accel: "Ctrl+P", run: () => nav("/labels") },
        { separator: true },
        { label: "导入 / 导出 / 备份…", run: () => nav("/settings?tab=data") },
        {
          label: "导出全部物品（CSV）",
          run: () => {
            window.open(authedUrl("/items/export.csv"), "_blank", "noopener");
            setOpen(null);
          },
        },
      ],
    },
    {
      key: "edit",
      label: "编辑",
      items: [
        {
          label: "查找物品…",
          accel: "Ctrl+K",
          run: () => {
            setOpen(null);
            window.dispatchEvent(new CustomEvent("hl:open-cmdk"));
          },
        },
        { label: "按编号 / 名称查询", run: () => nav("/scan") },
      ],
    },
    {
      key: "view",
      label: "视图",
      items: [
        { label: "浅色", checked: theme() === "light", run: () => setTheme("light") },
        { label: "深色", checked: theme() === "dark", run: () => setTheme("dark") },
        {
          label: "跟随系统",
          checked: theme() === "system",
          run: () => setTheme("system"),
        },
        {
          label: "自定义",
          checked: Boolean(accent()),
          run: () => setAccentOpen((v) => !v),
        },
        ...(accentOpen
          ? ([
              { separator: true },
              { label: "主题色", disabled: true },
              ...ACCENTS.map((a) => ({
                label: a.label,
                swatch: a.dot,
                checked: accent() === a.key,
                run: () => setAccent(a.key),
              })),
              {
                label: "恢复默认（松石绿）",
                checked: accent() === "",
                run: () => setAccent(""),
              },
              {
                label: "更多配色与背景…",
                run: () => {
                  setOpen(null);
                  nav("/settings?tab=account");
                },
              },
            ] as Item[])
          : []),
        { separator: true },
        { label: "重新加载界面", accel: "Ctrl+R", run: () => location.reload() },
      ],
    },
    {
      key: "help",
      label: "帮助",
      items: [
        {
          label: "打开数据目录",
          disabled: !canOpenDataDir(),
          run: () => {
            openDataDir();
            setOpen(null);
          },
        },
        {
          label: "查看运行日志",
          disabled: !canOpenLogs(),
          run: () => {
            openLogs();
            setOpen(null);
          },
        },
        { separator: true },
        {
          label: "快捷键",
          run: () => {
            setOpen(null);
            toast("Ctrl+K 查找 · Ctrl+N 新建 · Ctrl+P 打印标签");
          },
        },
      ],
    },
    {
      key: "about",
      label: "关于",
      items: [
        {
          label: "关于 HomeLedger",
          run: () => {
            setOpen(null);
            setAbout(true);
          },
        },
        {
          label: "关闭窗口",
          accel: "Ctrl+W",
          disabled: !canCloseWindow(),
          run: () => closeWindow(),
        },
        { separator: true },
        {
          label: "退出登录",
          run: () => {
            setOpen(null);
            logout();
            nav("/login");
          },
        },
      ],
    },
  ];

  return (
    <>
      <div className="appbar" ref={root}>
        {/* 原生标题栏已经写了应用名（ADR-025 桌面加载带边框的壳），
            这里再写一遍就是同一屏两个名字。品牌块只留一个小图标作视觉锚点，
            data-tauri-drag-region 必须保留——菜单按钮左侧的拖拽区就靠它。 */}
        {/* 侧边栏收起/展开——顶栏左侧唯一控件（1.0.9：品牌元素已全部让位） */}
        {onToggleNav && (
          <button
            className="appbar-navbtn"
            title={navCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={navCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!navCollapsed}
            onClick={onToggleNav}
          >
            <Icon name="panel-left" size={15} />
          </button>
        )}

        <div className="appbar-menus">
          {menus.map((m) => (
            <div className="appbar-menu" key={m.key}>
              <button
                className={`appbar-btn ${open === m.key ? "on" : ""}`}
                onClick={() => setOpen((v) => (v === m.key ? null : m.key))}
                onMouseEnter={() => open && setOpen(m.key)}
              >
                {m.label}
              </button>
              {open === m.key && (
                <div className="appbar-drop">
                  {m.items.map((it, i) =>
                    it.separator ? (
                      <div className="divider" key={`s${i}`} style={{ margin: "5px 0" }} />
                    ) : (
                      <button
                        key={it.label}
                        className="appbar-item"
                        disabled={it.disabled}
                        onClick={() => {
                          if (it.disabled) return;
                          it.run?.();
                          setOpen(null);
                        }}
                      >
                        <span className="tick">
                          {it.checked ? <Icon name="check" size={12} /> : null}
                          {!it.checked && it.swatch && (
                            <span className="swatch" style={{ background: it.swatch }} />
                          )}
                        </span>
                        <span className="grow">{it.label}</span>
                        {it.accel && <span className="accel">{it.accel}</span>}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="appbar-drag" data-tauri-drag-region />

        {/* 右侧动作区：通知/账号。搜索和新增都不搬到这里——
            搜索只留侧栏「查询」（手机是底部扫码键），新增只留各页页头；
            命令面板仍可用 Ctrl+K 或「编辑 → 查找物品…」打开。 */}
        {onOpenNotifs && (
          <div className="appbar-actions">
            <button
              className="appbar-navbtn"
              title="通知"
              aria-label="通知"
              onClick={onOpenNotifs}
            >
              <Icon name="bell" size={15} />
              {unread > 0 && <span className="dot" />}
            </button>
            <div style={{ position: "relative" }} ref={acctRef}>
              <button
                className="appbar-acctbtn"
                onClick={() => setAcctOpen((v) => !v)}
                aria-label="账号菜单"
                title={user?.display_name}
              >
                <Avatar name={user?.display_name || "?"} color={user?.avatar_color} src={user?.avatar_url} />
              </button>
              {acctOpen && (
                <div
                  className="card"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    width: 208,
                    padding: 6,
                    boxShadow: "var(--shadow-lg)",
                    zIndex: 70,
                  }}
                >
                  <div style={{ padding: "8px 10px 10px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.display_name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-3)" }} className="truncate">
                      {user?.email}
                    </div>
                  </div>
                  <div className="divider" style={{ margin: "0 0 6px" }} />
                  <div
                    className="nav-item"
                    onClick={() => {
                      nav("/settings");
                      setAcctOpen(false);
                    }}
                    style={{ fontSize: 12.5 }}
                  >
                    <Icon name="settings" size={15} />
                    账号与设置
                  </div>
                  <div
                    className="nav-item"
                    style={{ fontSize: 12.5, color: "var(--danger)" }}
                    onClick={() => {
                      logout();
                      nav("/login");
                    }}
                  >
                    <Icon name="log-out" size={15} />
                    退出登录
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 无边框窗口（decorations:false）的自绘窗口控制——原生标题栏整个
            去掉后，最小化/最大化/关闭得有人接手。 */}
        {canWindowControls() && (
          <div className="appbar-win">
            <button className="appbar-wbtn" title="最小化" aria-label="最小化窗口" onClick={minimizeWindow}>
              <Icon name="minus" size={14} />
            </button>
            <button
              className="appbar-wbtn"
              title="最大化/还原"
              aria-label="最大化或还原窗口"
              onClick={toggleMaximizeWindow}
            >
              <Icon name="stop" size={11} />
            </button>
            <button
              className="appbar-wbtn appbar-wclose"
              title="关闭窗口（最小化到托盘）"
              aria-label="关闭窗口"
              onClick={closeWindow}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </div>

      <Modal
        open={about}
        onClose={() => setAbout(false)}
        title="关于 HomeLedger"
        footer={
          <button className="btn btn-primary" onClick={() => setAbout(false)}>
            知道了
          </button>
        }
      >
        <div className="col gap-10">
          <div className="row gap-10">
            <BrandMark />
            <div>
              <div style={{ fontSize: 15, fontWeight: 650 }}>HomeLedger</div>
              <div className="tiny faint">家庭物品全生命周期管理</div>
            </div>
          </div>
          <div className="divider" />
          <Row label="版本" value={info?.version || APP_VERSION} />
          <Row label="界面构建" value={BUILD_ID} />
          <Row label="数据目录" value={info?.dataDir || "—"} mono />
          <Row label="当前账号" value={user?.email || "—"} />
          <div className="tiny faint">
            物品数据默认只保存在这台设备上。连接账号服务器时，服务器只保存邮箱、
            密码哈希、显示名和家庭成员关系，不采集手机号、住址、定位、通讯录或
            使用行为。要跨设备共享，在「设置 → 同步」里主动开启加密同步；敏感字段
            与照片在离开设备之前就已加密。
          </div>
        </div>
      </Modal>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row-between" style={{ fontSize: 12.5 }}>
      <span className="muted">{label}</span>
      <span
        className={mono ? "mono" : ""}
        style={{ maxWidth: "70%", textAlign: "right", wordBreak: "break-all" }}
      >
        {value}
      </span>
    </div>
  );
}
