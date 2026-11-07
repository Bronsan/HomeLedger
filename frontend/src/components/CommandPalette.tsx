import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get } from "../api/client";
import type { Page, Item } from "../api/types";
import { Icon } from "./icons";
import { usePresence } from "./ui";

interface Cmd {
  key: string;
  label: string;
  sub?: string;
  icon: string;
  run: () => void;
  section: string;
}

interface Highlight {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [ready, setReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open, 160);

  const staticCmds: Cmd[] = [
    { key: "n1", label: "概览", icon: "home", section: "前往", run: () => nav("/") },
    { key: "n2", label: "全部物品", icon: "package", section: "前往", run: () => nav("/items") },
    { key: "n3", label: "扫码查找", icon: "scan", section: "前往", run: () => nav("/scan") },
    { key: "n4", label: "维护计划", icon: "wrench", section: "前往", run: () => nav("/maintenance") },
    { key: "n5", label: "位置管理", icon: "map-pin", section: "前往", run: () => nav("/locations") },
    { key: "n6", label: "分类管理", icon: "tag", section: "前往", run: () => nav("/categories") },
    { key: "n7", label: "家庭成员", icon: "users", section: "前往", run: () => nav("/members") },
    { key: "n8", label: "设置", icon: "settings", section: "前往", run: () => nav("/settings") },
    {
      key: "a1",
      label: "新增物品",
      sub: "N",
      icon: "plus",
      section: "操作",
      run: () => nav("/items/new"),
    },
    {
      key: "a2",
      label: "打印标签",
      icon: "printer",
      section: "操作",
      run: () => nav("/labels"),
    },
    {
      key: "a3",
      label: "导出 CSV",
      icon: "download",
      section: "操作",
      run: () => window.open("/api/v1/items/export.csv", "_blank"),
    },
  ];

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setReady(false);
    const raf = requestAnimationFrame(() => setReady(true));
    const focus = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(focus);
    };
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await get<Page<Item>>(
          `/items?q=${encodeURIComponent(q.trim())}&page_size=5`,
          controller.signal
        );
        setResults(res.items);
        setSel(0);
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, open]);

  const cmds: Cmd[] = [
    ...results.map((r) => ({
      key: r.id,
      label: r.name,
      sub: r.code,
      icon: "package",
      section: "物品",
      run: () => nav(`/items/${r.id}`),
    })),
    ...staticCmds.filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase())),
  ];

  // 过滤结果可能比当前选中项还短；渲染时就夹紧，避免出现「选中第 8 项但列表只剩 3 项」的一帧。
  const activeIndex = Math.min(sel, Math.max(0, cmds.length - 1));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cmdKey = cmds.map((c) => c.key).join("|");

  // 过滤后列表变短时，选中项可能落到列表之外；夹回最后一项。
  useEffect(() => {
    setSel((s) => (s < cmds.length ? s : Math.max(0, cmds.length - 1)));
  }, [cmds.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, cmds.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      }
      if (e.key === "Home") {
        e.preventDefault();
        setSel(0);
      }
      if (e.key === "End") {
        e.preventDefault();
        setSel(Math.max(0, cmds.length - 1));
      }
      if (e.key === "Enter" && cmds[activeIndex]) {
        cmds[activeIndex].run();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, cmds, activeIndex, onClose]);

  // 选中底板的位置从当前选中行量出来，横跨整个列表宽度；
  // 取 offset 系列而不是 getBoundingClientRect：面板进场时外层还在 scale，
  // rect 会把动画中的缩放算进去，底板就会量小一点、落错位置。
  // offsetTop 是内容坐标，放在滚动容器里天然跟着列表一起滚。
  useLayoutEffect(() => {
    if (!mounted) return;
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(".cmdk-item.sel");
    if (!list || !active) {
      setHighlight(null);
      return;
    }
    const next = {
      top: active.offsetTop,
      left: active.offsetLeft,
      width: active.offsetWidth,
      height: active.offsetHeight,
    };
    setHighlight((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.height === next.height
        ? prev
        : next
    );
  }, [mounted, sel, cmdKey]);

  // 键盘移动选中项时把它滚进视野；列表本身不滚动页面。
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(".cmdk-item.sel");
    if (!list || !active) return;
    const pad = 6;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < list.scrollTop + pad) {
      list.scrollTop = Math.max(0, top - pad);
    } else if (bottom > list.scrollTop + list.clientHeight - pad) {
      list.scrollTop = bottom - list.clientHeight + pad;
    }
  }, [sel, cmdKey, open]);

  if (!mounted) return null;

  let lastSection = "";
  return (
    <div
      className={`cmdk-overlay${closing ? " is-closing" : ""}`}
      onMouseDown={(e) => !closing && e.target === e.currentTarget && onClose()}
    >
      <div
        className={`cmdk${closing ? " is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div className="cmdk-input-row">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索物品、跳转页面、执行操作…"
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={cmds[activeIndex] ? `cmdk-opt-${cmds[activeIndex].key}` : undefined}
          />
          <kbd>ESC</kbd>
        </div>
        <div
          className={`cmdk-list${highlight ? " has-indicator" : ""}`}
          id="cmdk-list"
          role="listbox"
          aria-label="命令"
          ref={listRef}
        >
          <span
            className={`cmdk-indicator${ready ? "" : " is-instant"}`}
            aria-hidden="true"
            style={
              highlight
                ? {
                    transform: `translate(${highlight.left}px, ${highlight.top}px)`,
                    width: highlight.width,
                    height: highlight.height,
                  }
                : { opacity: 0 }
            }
          />
          {cmds.length === 0 && (
            <div
              role="presentation"
              style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}
            >
              没有匹配结果
            </div>
          )}
          {cmds.map((c, i) => {
            const showSection = c.section !== lastSection;
            lastSection = c.section;
            return (
              <div key={c.key} role="presentation">
                {showSection && (
                  <div className="cmdk-section" role="presentation">
                    {c.section}
                  </div>
                )}
                <div
                  id={`cmdk-opt-${c.key}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`cmdk-item ${i === activeIndex ? "sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    c.run();
                    onClose();
                  }}
                >
                  <div className="ic">
                    <Icon name={c.icon} size={13} />
                  </div>
                  <span className="truncate">{c.label}</span>
                  {c.sub && <span className="sub">{c.sub}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
