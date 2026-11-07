import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { get, post } from "../api/client";
import type { NotificationItem } from "../api/types";
import { useAuth, ROLE_LABEL } from "../hooks/auth";
import { useLiveRefresh } from "../hooks/live";
import { relativeTime } from "../lib/format";
import { isDesktopShell, prefersManualLookup } from "../lib/platform";
import { AppMenuBar } from "./AppMenuBar";
import { BrandMark } from "./BrandMark";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./icons";
import { Avatar, Drawer, SlidingIndicator, usePresence, useToast } from "./ui";

/**
 * 一级导航。
 *
 * `/scan` 这一项在桌面端叫「查询」：没有摄像头，页面里也只有输入框。
 * 同一个路由两种叫法，是因为它做的事确实不同——手机是"扫一下"，
 * 桌面是"输进去查"。
 */
function navSections(manualLookup: boolean) {
  return [
  { group: "工作台", items: [
    { to: "/", label: "概览", icon: "home", end: true },
    { to: "/items", label: "物品", icon: "package" },
    manualLookup
      ? { to: "/scan", label: "查询", icon: "search" }
      : { to: "/scan", label: "扫码", icon: "scan" },
    { to: "/maintenance", label: "维护", icon: "wrench" },
    { to: "/loans", label: "借还", icon: "inbox" },
  ]},
  { group: "整理", items: [
    { to: "/locations", label: "位置", icon: "map-pin" },
    { to: "/categories", label: "分类", icon: "tag" },
    { to: "/archive", label: "归档", icon: "archive" },
  ]},
  { group: "家庭", items: [
    { to: "/members", label: "成员与权限", icon: "users" },
    { to: "/audit", label: "操作记录", icon: "history" },
    { to: "/settings", label: "设置", icon: "settings" },
  ]},
  ];
}

const TITLES: Record<string, string> = {
  "/": "概览",
  "/items": "物品",
  "/items/new": "新增物品",
  "/scan": "扫码",
  "/maintenance": "维护计划",
  "/locations": "位置",
  "/categories": "分类",
  "/members": "成员与权限",
  "/audit": "操作记录",
  "/settings": "设置",
};

function titleFor(path: string, manualLookup: boolean): string {
  if (path === "/scan") return manualLookup ? "查询" : "扫码";
  if (TITLES[path]) return TITLES[path];
  if (/^\/items\/[^/]+\/edit$/.test(path)) return "编辑物品";
  if (/^\/items\/[^/]+$/.test(path)) return "物品详情";
  return "HomeLedger";
}

/**
 * 顶栏/侧栏里的轻量下拉菜单。
 *
 * 菜单从触发按钮那一角缩放出现，关闭时先播完退场再卸载（usePresence）；
 * Esc 关闭与焦点归还由调用处处理。定位仍用 inline style，因为这个组件
 * 只管「怎么出现/消失」，不管「贴在哪」。
 */
function PopMenu({
  open,
  placement,
  style,
  children,
}: {
  open: boolean;
  placement: "up" | "down";
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { mounted, closing } = usePresence(open, 130);
  if (!mounted) return null;
  return (
    <div className={`card pop-menu ${placement}${closing ? " is-closing" : ""}`} style={style}>
      {children}
    </div>
  );
}

export function AppShell() {
  const { user, family, families, role, logout, switchFamily } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();

  const manualLookup = prefersManualLookup();
  // 桌面壳才画菜单栏：浏览器里没有它要替代的那套原生 chrome。
  const withMenuBar = isDesktopShell();
  // 侧边栏收起状态只在桌面壳里有意义（浏览器端没有顶栏开关，不读不写）
  const [navCollapsed, setNavCollapsed] = useState(
    withMenuBar && localStorage.getItem("hl_nav_collapsed") === "1"
  );
  const toggleNav = () =>
    setNavCollapsed((v) => {
      localStorage.setItem("hl_nav_collapsed", v ? "0" : "1");
      return !v;
    });
  const [scrolled, setScrolled] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [familyMenu, setFamilyMenu] = useState(false);
  // 两个菜单两个 ref。之前它们共用一个 ref，而 React 只保留最后挂上的那个
  // （顶栏头像），于是侧栏家庭菜单里的每一次点击都被判成"点在外部"：
  // mousedown 先把菜单卸载掉，click 根本到不了处理函数——表现就是"点了没反应"。
  const accountRef = useRef<HTMLDivElement>(null);
  const familyRef = useRef<HTMLDivElement>(null);
  const accountBtnRef = useRef<HTMLButtonElement>(null);
  const familyBtnRef = useRef<HTMLButtonElement>(null);

  const refreshNotifs = useCallback(async () => {
    try {
      const res = await get<{ items: NotificationItem[]; unread: number }>(
        "/notifications?limit=40"
      );
      setNotifs(res.items);
      setUnread(res.unread);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshNotifs();
    // 60 秒的轮询留着当兜底：SSE 被反代掐掉、或者推送通道本身出问题时，
    // 未读数最多晚一分钟，而不是永远不动。
    const t = window.setInterval(refreshNotifs, 60_000);
    return () => window.clearInterval(t);
  }, [refreshNotifs]);

  // 常驻组件，所以这条订阅也是常驻的——它顺带保证了应用里永远有一条打开的
  // 事件流，页面切来切去不会反复建连。
  useLiveRefresh(() => void refreshNotifs(), [
    "notification",
    "maintenance",
    "loan",
    "batch",
    "item",
  ]);

  // 菜单栏的「查找」通过事件委托过来，免得把 setCmdk 一路传下去。
  useEffect(() => {
    const open = () => setCmdk(true);
    window.addEventListener("hl:open-cmdk", open);
    return () => window.removeEventListener("hl:open-cmdk", open);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdk((v) => !v);
      }
      if (
        e.key.toLowerCase() === "n" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)
      ) {
        nav("/items/new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 只有点在两个菜单容器之外才关；点菜单内部一律放过。
      if (!accountRef.current?.contains(target)) setMenuOpen(false);
      if (!familyRef.current?.contains(target)) setFamilyMenu(false);
    };
    // Esc 关闭，并把焦点还给打开菜单的那个按钮——键盘用户不该丢掉位置。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) {
        e.preventDefault();
        setMenuOpen(false);
        accountBtnRef.current?.focus();
      }
      if (familyMenu) {
        e.preventDefault();
        setFamilyMenu(false);
        familyBtnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, familyMenu]);

  useEffect(() => {
    setMenuOpen(false);
    setFamilyMenu(false);
  }, [loc.pathname]);

  /** 点开一条通知顺带把它标已读：读了还挂未读角标，等于提醒失灵。 */
  const markOne = async (id: string) => {
    setNotifs((prev) =>
      prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await post("/notifications/read", { ids: [id] });
    } catch {
      /* 本地已乐观更新；失败则等下次刷新纠正 */
    }
  };

  const markAll = async () => {
    await post("/notifications/read", { all: true });
    setNotifs((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    setUnread(0);
    toast("已全部标记为已读");
  };

  return (
    <div className={`shell ${withMenuBar ? "has-appbar" : ""} ${withMenuBar && navCollapsed ? "nav-collapsed" : ""}`}>
      {withMenuBar && (
          <AppMenuBar
            navCollapsed={navCollapsed}
            onToggleNav={toggleNav}
            onOpenNotifs={() => {
              setNotifOpen(true);
              void refreshNotifs();
            }}
            unread={unread}
          />
        )}
      <aside className="sidebar">
        <Link to="/" className="brand">
          <BrandMark />
          <div className="brand-text">
            <span className="brand-name">HomeLedger</span>
            <span className="brand-sub">家庭物品账本</span>
          </div>
        </Link>

        <nav className="sidebar-nav" style={{ flex: 1, overflowY: "auto" }}>
          <SlidingIndicator activeKey={loc.pathname} className="nav-indicator" />
          {navSections(manualLookup).map((section) => (
            <div className="nav-group" key={section.group}>
              <div className="nav-label">{section.group}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.to === "/maintenance" && unread > 0 && (
                    <span className="badge-count">{unread > 99 ? "99+" : unread}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer" ref={familyRef} style={{ position: "relative" }}>
          <button
            className="family-switch"
            ref={familyBtnRef}
            aria-haspopup="true"
            aria-expanded={familyMenu}
            onClick={() => setFamilyMenu((v) => !v)}
          >
            <div className="family-avatar">{(family?.name || "家").slice(0, 1)}</div>
            <div className="family-meta">
              <div className="name truncate">{family?.name || "未加入家庭"}</div>
              <div className="sub">
                {family?.member_count ? `${family.member_count} 位成员` : ROLE_LABEL[role || "member"]}
              </div>
            </div>
            <Icon name="chevron-up" size={13} style={{ color: "var(--rail-text-3)" }} />
          </button>

          <PopMenu
            open={familyMenu}
            placement="up"
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 8,
              padding: 6,
              boxShadow: "var(--shadow-lg)",
              zIndex: 60,
            }}
          >
            {families.map((f) => (
              <button
                key={f.id}
                type="button"
                className="nav-item"
                style={{ fontSize: 12.5 }}
                onClick={async () => {
                  await switchFamily(f.id);
                  setFamilyMenu(false);
                  toast(`已切换到 ${f.name}`);
                }}
              >
                <div className="family-avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                  {f.name.slice(0, 1)}
                </div>
                <span className="truncate">{f.name}</span>
                {f.id === family?.id && (
                  <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--brand)" }} />
                )}
              </button>
            ))}
            <div className="divider" style={{ margin: "6px 0" }} />
            <button
              type="button"
              className="nav-item"
              style={{ fontSize: 12.5 }}
              onClick={() => {
                nav("/settings?tab=family");
                setFamilyMenu(false);
              }}
            >
              <Icon name="plus" size={15} />
              新建或加入家庭
            </button>
          </PopMenu>
        </div>
      </aside>

      <div className="main">
        <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <div className="topbar-title">
            <BrandMark size={26} />
            <h1>{titleFor(loc.pathname, manualLookup)}</h1>
          </div>
          <div className="topbar-actions">
            {/* 搜索只留侧栏「查询」一个入口（手机是底部扫码键），新增只留页头一个。
                顶栏再放图标就会和它们同屏重复；命令面板仍可用 Ctrl/Cmd+K 打开。 */}
            <button
              className="icon-btn"
              onClick={() => {
                setNotifOpen(true);
                void refreshNotifs();
              }}
              title="通知"
              aria-label="通知"
            >
              <Icon name="bell" size={18} />
              {unread > 0 && <span className="dot" />}
            </button>
            <div style={{ position: "relative" }} ref={accountRef}>
              <button
                ref={accountBtnRef}
                onClick={() => setMenuOpen((v) => !v)}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  cursor: "pointer",
                  display: "flex",
                }}
                aria-label="账号菜单"
                aria-haspopup="true"
                aria-expanded={menuOpen}
              >
                <Avatar name={user?.display_name || "?"} color={user?.avatar_color} src={user?.avatar_url} />
              </button>
              <PopMenu
                open={menuOpen}
                placement="down"
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  right: 0,
                  width: 208,
                  padding: 6,
                  boxShadow: "var(--shadow-lg)",
                  zIndex: 60,
                }}
              >
                <div style={{ padding: "8px 10px 10px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.display_name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-3)" }} className="truncate">
                    {user?.email}
                  </div>
                </div>
                <div className="divider" style={{ margin: "0 0 6px" }} />
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => {
                    setMenuOpen(false);
                    nav("/settings");
                  }}
                  style={{ fontSize: 12.5 }}
                >
                  <Icon name="settings" size={15} />
                  账号与设置
                </button>
                <button
                  type="button"
                  className="nav-item"
                  style={{ fontSize: 12.5, color: "var(--danger)" }}
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                    nav("/login");
                  }}
                >
                  <Icon name="log-out" size={15} />
                  退出登录
                </button>
              </PopMenu>
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottomnav">
        <div className="bottomnav-inner">
          <NavLink to="/" end className={({ isActive }) => `bn-item ${isActive ? "active" : ""}`}>
            <Icon name="home" size={21} />
            概览
          </NavLink>
          <NavLink to="/items" className={({ isActive }) => `bn-item ${isActive ? "active" : ""}`}>
            <Icon name="package" size={21} />
            物品
          </NavLink>
          <div className="bn-item bn-fab" onClick={() => nav("/scan")}>
            <span>
              <Icon name="scan" size={21} />
            </span>
          </div>
          <NavLink
            to="/maintenance"
            className={({ isActive }) => `bn-item ${isActive ? "active" : ""}`}
          >
            <Icon name="wrench" size={21} />
            维护
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `bn-item ${isActive ? "active" : ""}`}>
            <Icon name="user" size={21} />
            我的
          </NavLink>
        </div>
      </nav>

      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} />

      <Drawer open={notifOpen} onClose={() => setNotifOpen(false)} title="通知">
        <div className="row-between mb-12">
          <span className="small muted">{unread > 0 ? `${unread} 条未读` : "全部已读"}</span>
          {unread > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={markAll}>
              <Icon name="check" size={13} />
              全部已读
            </button>
          )}
        </div>
        {notifs.length === 0 && (
          <div className="empty" style={{ padding: "40px 10px" }}>
            <div className="empty-icon">
              <Icon name="bell" size={22} />
            </div>
            <h3>暂无通知</h3>
            <p>维护到期、保修提醒和借出逾期会出现在这里</p>
          </div>
        )}
        <div className="col gap-2">
          {notifs.map((n) => (
            <div
              key={n.id}
              onClick={() => {
                if (n.entity_type === "item") nav(`/items/${n.entity_id}`);
                else if (n.entity_type === "maintenance") nav("/maintenance");
                void markOne(n.id);
                setNotifOpen(false);
              }}
              style={{
                padding: "11px 12px",
                borderRadius: "var(--radius-sm)",
                background: n.read_at ? "transparent" : "var(--brand-soft)",
                cursor: "pointer",
                border: "1px solid transparent",
              }}
            >
              <div className="row gap-8" style={{ alignItems: "flex-start" }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "var(--radius-xs)",
                    background: n.read_at ? "var(--surface-hover)" : "var(--surface)",
                    display: "grid",
                    placeItems: "center",
                    flex: "0 0 auto",
                    color: n.read_at ? "var(--text-3)" : "var(--brand)",
                  }}
                >
                  <Icon
                    name={
                      n.type === "maintenance_due"
                        ? "wrench"
                        : n.type === "warranty"
                        ? "shield"
                        : n.type === "loan_overdue"
                        ? "clock"
                        : n.type === "low_stock"
                        ? "package"
                        : n.type === "batch_expiring"
                        ? "tag"
                        : "bell"
                    }
                    size={13}
                  />
                </div>
                <div className="grow">
                  <div style={{ fontSize: 12.5, fontWeight: n.read_at ? 500 : 600 }}>{n.title}</div>
                  {n.body && (
                    <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 2 }}>{n.body}</div>
                  )}
                  <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 3 }}>
                    {relativeTime(n.created_at)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
