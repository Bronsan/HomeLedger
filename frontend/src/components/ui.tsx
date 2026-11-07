import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { authedUrl } from "../api/client";
import { Icon } from "./icons";

/* ------------------------------- toast ------------------------------- */
type Toast = { id: number; text: string; kind: "success" | "error" | "info"; leaving?: boolean };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
const TOAST_EXIT_MS = 180;
const TOAST_LIFE_MS = 3200;

/** 减少动态偏好下动画几乎瞬完，别再让透明遮罩多拦截 180ms 点击。 */
function exitDelay(ms: number) {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : ms;
}

/**
 * 校验失败时轻轻晃一下出错的字段。
 *
 * 用 Web Animations API 而不是 CSS 类：连点两次提交时新的动画会覆盖旧的，
 * 不用先移除类再等重排。只动 transform；减少动态偏好下完全不动，
 * 字段下方的文字说明仍然在。
 */
export function shakeElement(el: HTMLElement | null) {
  if (!el || typeof el.animate !== "function") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-5px)" },
      { transform: "translateX(4px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 320, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" }
  );
}

/**
 * 单条提示自己管生命周期：悬停时暂停倒计时，移开继续。
 *
 * 3.2s 对短消息够用，但用户正要读（或只是把指针停在那儿）时不该读一半就没了；
 * Radix Toast 也是这么做的。剩余时间用底边细线画出来，悬停时线一起停住，
 * 否则「暂停」是个看不见的状态。
 */
function ToastItem({ toast, onExpire }: { toast: Toast; onExpire: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(TOAST_LIFE_MS);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const arm = useCallback(() => {
    startedAt.current = performance.now();
    timer.current = window.setTimeout(() => onExpire(toast.id), remaining.current);
  }, [onExpire, toast.id]);

  useEffect(() => {
    if (toast.leaving) return;
    arm();
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [arm, toast.leaving]);

  const pause = () => {
    if (toast.leaving || paused) return;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    const elapsed = startedAt.current ? performance.now() - startedAt.current : 0;
    // 悬停到最后一刻才移开也别让它立刻消失，留一点反应时间。
    remaining.current = Math.max(120, remaining.current - elapsed);
    setPaused(true);
  };

  const resume = () => {
    if (!paused || toast.leaving) return;
    setPaused(false);
    arm();
  };

  return (
    <div
      data-id={toast.id}
      className={`toast ${toast.kind}${toast.leaving ? " is-leaving" : ""}${paused ? " is-paused" : ""}`}
      role={toast.kind === "error" ? "alert" : "status"}
      onPointerEnter={pause}
      onPointerLeave={resume}
    >
      <Icon
        name={toast.kind === "error" ? "x-circle" : toast.kind === "info" ? "info" : "check-circle"}
        size={15}
      />
      <span>{toast.text}</span>
      <span
        className="toast-timer"
        aria-hidden="true"
        style={{
          animationDuration: `${TOAST_LIFE_MS}ms`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const counter = useRef(0);
  const stackRef = useRef<HTMLDivElement>(null);
  const prevRects = useRef<Map<number, DOMRect>>(new Map());

  // 新 toast 追加在底部，栈底固定，已有 toast 会瞬间向上让位。用 FLIP 把这段
  // 位移补平：先记下每条 toast 提交前的位置，提交后对存活项从旧位置滑回新位置。
  // 退场中的那条有自己的动画，不参与，避免两个 transform 动画互相覆盖。
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const next = new Map<number, DOMRect>();
    stack.querySelectorAll<HTMLElement>(".toast[data-id]").forEach((el) => {
      const id = Number(el.dataset.id);
      if (Number.isFinite(id)) next.set(id, el.getBoundingClientRect());
    });
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) {
      next.forEach((rect, id) => {
        const prev = prevRects.current.get(id);
        if (!prev) return;
        const el = stack.querySelector<HTMLElement>(`.toast[data-id="${id}"]`);
        if (!el || el.classList.contains("is-leaving")) return;
        const dy = prev.top - rect.top;
        if (Math.abs(dy) < 1) return;
        el.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
          { duration: 220, easing: "cubic-bezier(0.22, 0.8, 0.25, 1)" }
        );
      });
    }
    prevRects.current = next;
  }, [items]);

  const expire = useCallback((id: number) => {
    // 先标记离场让动画播完，再从列表移除；否则元素瞬间消失，退场动画没机会跑。
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, exitDelay(TOAST_EXIT_MS));
  }, []);

  const push = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = ++counter.current;
    setItems((prev) => [...prev, { id, text, kind }]);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toast-stack" ref={stackRef}>
          {items.map((t) => (
            <ToastItem key={t.id} toast={t} onExpire={expire} />
          ))}
        </div>,
        document.body
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/**
 * 让「关闭」也播完再卸载。
 *
 * 组件在 open=false 的瞬间 return null，退场动画根本没有机会播放；这里在
 * open 变 false 后先保持挂载并标记 closing，等 CSS 动画结束再真正移除。
 * 关闭过程中重新打开会清掉计时器，不会出现「关了又自己消失」。
 */
export function usePresence(open: boolean, exitMs: number) {
  const [closing, setClosing] = useState(false);
  const [exited, setExited] = useState(!open);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setClosing(false);
      setExited(false);
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setClosing(false);
      setExited(true);
    }, exitDelay(exitMs));
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  // 打开必须和 open 同一次渲染就可见，不能再等一个 effect；exited 只负责
  // 关闭动画播完后把元素真正摘掉。否则「点删除 → 立刻查确认框」会查不到。
  return { mounted: open || !exited, closing };
}

/* ------------------------------- modal ------------------------------- */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "normal",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "normal" | "wide" | "xwide";
}) {
  const { mounted, closing } = usePresence(open, 180);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 退场期间也保持滚动锁定，避免遮罩还在淡出、底下的页面已经跟着滚。
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  if (!mounted) return null;
  const base = size === "wide" ? "modal wide" : size === "xwide" ? "modal xwide" : "modal";
  const cls = closing ? `${base} is-closing` : base;
  return createPortal(
    <div
      className={`overlay${closing ? " is-closing" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={cls} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <div className="grow">
              <h3>{title}</h3>
              {subtitle && <div className="sub">{subtitle}</div>}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">
              <Icon name="x" size={17} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------- drawer ------------------------------- */
export function Drawer({
  open,
  onClose,
  title,
  children,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const { mounted, closing } = usePresence(open, 200);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;
  return createPortal(
    <>
      <div className={`drawer-overlay${closing ? " is-closing" : ""}`} onClick={onClose} />
      <aside className={`drawer${closing ? " is-closing" : ""}`} style={width ? { width } : undefined}>
        <div className="drawer-head">
          <div className="h3">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={17} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body
  );
}

/* ------------------------------- bits ------------------------------- */
export function Empty({
  icon = "package",
  title,
  desc,
  action,
}: {
  icon?: string;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={25} />
      </div>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action && <div className="mt-12">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="loader" size={size} className="spin" />;
}

export function Skeleton({ w = "100%", h = 14, r = 6 }: { w?: string | number; h?: number; r?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r }} />;
}

export function Avatar({
  name,
  color,
  size = "md",
  src,
}: {
  name: string;
  color?: string;
  size?: "sm" | "md" | "lg";
  /** 自定义头像图：相对路径（远程，自动带 token）或 data URL（本机） */
  src?: string | null;
}) {
  const cls = size === "sm" ? "avatar sm" : size === "lg" ? "avatar lg" : "avatar";
  const initial = (name || "?").trim().slice(0, 1).toUpperCase();
  const url = !src
    ? null
    : src.startsWith("data:")
      ? src
      : src.startsWith("/")
        ? authedUrl(src)
        : src;
  if (url) {
    return (
      <div className={`${cls} has-img`} title={name}>
        <img src={url} alt={name} />
      </div>
    );
  }
  return (
    <div className={cls} style={{ background: color || "var(--brand)" }} title={name}>
      {initial}
    </div>
  );
}

export function Pagination({
  page,
  pages,
  total,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const nums: number[] = [];
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  for (let i = start; i <= Math.min(pages, start + 4); i++) nums.push(i);
  return (
    <div className="pagination">
      <span>
        共 <b className="num">{total}</b> 条
      </span>
      <div className="pages">
        <button className="page-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <Icon name="chevron-left" size={13} />
        </button>
        {nums.map((n) => (
          <button
            key={n}
            className={`page-btn ${n === page ? "active" : ""}`}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
        <button className="page-btn" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <Icon name="chevron-right" size={13} />
        </button>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--text-2)", whiteSpace: "pre-line" }}>
        {message}
      </div>
    </Modal>
  );
}

/**
 * 应用内的 confirm()。
 *
 * 原生 `window.confirm` 在 WebView 里有两个问题：一是样式由系统决定，
 * 会突然弹出一个和产品无关的对话框；二是部分 WebView 根本没实现它——
 * 点击后什么都不发生，函数直接返回 false。而「清空本机数据库」「断开
 * 同步」这些不可逆操作，全都拦在它后面。
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm("确定吗？"))) return;
 *   return <>{confirmDialog}…</>;
 */
export function useConfirm() {
  const [pending, setPending] = useState<{
    message: ReactNode;
    title: string;
    confirmText: string;
    danger: boolean;
    closing?: boolean;
    resolve: (ok: boolean) => void;
  } | null>(null);

  // 关闭时不能立刻 setPending(null)：ConfirmDialog 会跟着卸载，Modal 的退场
  // 动画来不及播。这里先把 open 置 false 让动画跑，220ms 后再真正移除；
  // closing 同时充当幂等锁——确认按钮会先 onConfirm 再 onClose，不能结算两次。
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const finish = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    if (!current || current.closing) return;
    current.resolve(ok);
    const next = { ...current, closing: true };
    pendingRef.current = next;
    setPending(next);
    window.setTimeout(() => {
      // 期间可能又弹了新的确认框，别把新的那个清掉。
      setPending((cur) => (cur === next ? null : cur));
    }, exitDelay(220));
  }, []);

  const confirm = useCallback(
    (
      message: ReactNode,
      opts?: { title?: string; confirmText?: string; danger?: boolean }
    ) =>
      new Promise<boolean>((resolve) => {
        setPending({
          message,
          title: opts?.title || "确认操作",
          confirmText: opts?.confirmText || "确定",
          danger: opts?.danger ?? true,
          resolve,
        });
      }),
    []
  );

  const dialog = pending ? (
    <ConfirmDialog
      open={!pending.closing}
      title={pending.title}
      message={pending.message}
      confirmText={pending.confirmText}
      danger={pending.danger}
      onConfirm={() => finish(true)}
      onClose={() => finish(false)}
    />
  ) : null;

  return [confirm, dialog] as const;
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { key: T; label: string; count?: number }[];
}) {
  const strip = useRef<HTMLDivElement>(null);
  /* 选中态由一块滑动的底板表示，而不是每个标签各画各的。底板的位置和宽度
     从当前激活的那个标签量出来（包含 count 徽标）；皮肤层决定它是一条
     下划线还是一颗药丸。 */
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  // 首帧直接从 0 长到目标宽度会像一段加载动画；先在无过渡状态摆好，再开启滑动。
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const measure = useCallback(() => {
    const box = strip.current;
    const active = box?.querySelector<HTMLElement>(".tab.active");
    if (!box || !active) return;
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    // 量出来没变就返回原对象，避免 ResizeObserver 触发无休止的重渲染。
    setIndicator((prev) => (prev && prev.x === x && prev.w === w ? prev : { x, w }));
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [value, measure]);

  useEffect(() => {
    const box = strip.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const active = box.querySelector<HTMLElement>(".tab.active");
    if (active) ro.observe(active);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [value, measure]);

  // 标签多到装不下时（手机 390px 放 6 个），条本身可以横滑，但默认视野外的
  // 标签没有任何提示。切到某个标签后把它滚进来，至少"当前在哪"永远看得见；
  // 已经在视野内就不动，否则每点一次整条都会抖一下。
  useEffect(() => {
    const box = strip.current;
    const active = box?.querySelector<HTMLElement>(".tab.active");
    if (!box || !active) return;
    const left = active.offsetLeft;
    if (left < box.scrollLeft || left + active.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollTo({ left: Math.max(left - 12, 0), behavior: "smooth" });
    }
  }, [value]);

  return (
    <div className={`tabs${indicator ? " has-indicator" : ""}`} ref={strip}>
      <span
        className={`tabs-indicator${ready ? "" : " is-instant"}`}
        aria-hidden="true"
        style={
          indicator
            ? { transform: `translateX(${indicator.x}px)`, width: indicator.w }
            : undefined
        }
      />
      {items.map((it) => (
        <div
          key={it.key}
          className={`tab ${value === it.key ? "active" : ""}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
          {it.count !== undefined && <span className="count">{it.count}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * 小分段控件（网格/列表、浅色/深色/跟随系统）。
 *
 * 和 Tabs 同一套量测手法：从 `.pill.active` 量出位置与宽度，用一块底板
 * 滑过去，而不是让每个按钮各自硬切背景。子按钮保持原样，外层只多一块
 * `aria-hidden` 的指示器，所以键盘、读屏和现有选择器都不受影响。
 */
export function PillGroup({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  // 上一个量到的位置。layout effect 每次提交都会跑，若只用 setState 的
  // 函数式更新去「值没变就返回旧对象」，React 仍会为这次 setState 再渲染
  // 一轮，下一轮又 setState——在 layout effect 里就形成无限循环
  // （Maximum update depth）。这里先用 ref 挡住，值没变就完全不调用 setState。
  const lastRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const measure = useCallback(() => {
    const box = boxRef.current;
    const active = box?.querySelector<HTMLElement>(".pill.active");
    if (!box || !active) return;
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    const prev = lastRef.current;
    if (prev && prev.x === x && prev.w === w) return;
    lastRef.current = { x, w };
    setIndicator({ x, w });
  }, []);

  // 没有 deps：父组件切换选中项时会带着新的 children 重渲染，每次提交后量一次。
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div
      className={`pill-group${indicator ? " has-indicator" : ""}${className ? ` ${className}` : ""}`}
      ref={boxRef}
    >
      <span
        className={`pill-indicator${ready ? "" : " is-instant"}`}
        aria-hidden="true"
        style={
          indicator
            ? { transform: `translateX(${indicator.x}px)`, width: indicator.w }
            : undefined
        }
      />
      {children}
    </div>
  );
}

/**
 * 跟着选中项滑动的底块，用于纵向/横向的导航列表。
 *
 * 放在列表容器里当第一个子元素：它量出当前 `.active` 项相对容器的偏移，
 * 自己滑过去，并把容器的 `has-indicator` 打开——由皮肤 CSS 决定底块长什么样、
 * 并让选中项本身让出背景，避免两层高亮叠在一起。`activeKey` 变化时重测。
 *
 * 量测用 offset 几何而不是 getBoundingClientRect：入场缩放动画会把 rect
 * 一起缩小，量出来的底块会偏小、偏上（第 8 轮的教训）。
 */
export function SlidingIndicator({
  activeKey,
  className,
}: {
  activeKey: string;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(
    null
  );
  const [ready, setReady] = useState(false);
  const lastRef = useRef<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const measure = useCallback(() => {
    const el = ref.current;
    const box = el?.parentElement;
    // 侧栏的导航项外面包着 .nav-group，所以不能限定直接子元素。
    const active = box?.querySelector<HTMLElement>(".active");
    if (!box || !active) return;
    const next = {
      top: active.offsetTop,
      left: active.offsetLeft,
      width: active.offsetWidth,
      height: active.offsetHeight,
    };
    const prev = lastRef.current;
    if (
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.height === next.height
    ) {
      return;
    }
    lastRef.current = next;
    setRect(next);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [activeKey, measure]);

  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    box.classList.toggle("has-indicator", !!rect);
  }, [rect]);

  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    Array.from(box.children).forEach((child) => {
      if (child !== ref.current) ro.observe(child);
    });
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <span
      ref={ref}
      className={`${className}${ready ? "" : " is-instant"}`}
      aria-hidden="true"
      style={
        rect
          ? {
              transform: `translate(${rect.left}px, ${rect.top}px)`,
              width: rect.width,
              height: rect.height,
            }
          : { opacity: 0 }
      }
    />
  );
}

/* --------------------------- nested switch ---------------------------- */
export interface SwitchOption {
  key: string;
  label: string;
}

/**
 * 带滑动指示器的两级互斥选择器。
 *
 * 结构照搬参考实现「主选项 + 内嵌次级菜单」的模型：选中第一个主选项时，
 * 次级菜单从主选项标签下方展开，外层指示器停在左半边，内层指示器在
 * 次级选项之间滑动；切到第二个主选项时菜单收回，但次级选择会被记住。
 *
 * 与参考实现的差别只在视觉与框架接入：
 * - 用 CSS 自定义属性（--hl-index / --hl-sub-index）驱动指示器，而不是
 *   :checked ~ 选择器；指示器始终挂载，快速来回切换时动画从当前位置继续。
 * - 原生 radio 保留在 DOM 里（透明覆盖在每一段上），所以 Tab、方向键、
 *   Space 和读屏语义都由浏览器提供；次级 radio 在主选项收回时 disabled，
 *   不会进入 Tab 顺序。
 * - 动效与几何放在 styles.css，颜色全部走项目现有的 brand/surface token。
 */
export function NestedSwitch({
  primary,
  secondary,
  primaryValue,
  secondaryValue,
  onPrimaryChange,
  onSecondaryChange,
  ariaLabel,
  secondaryLabel,
}: {
  /** 两个互斥的主选项；第一个展开后显示次级选项。 */
  primary: readonly [SwitchOption, SwitchOption];
  /** 只在第一个主选项下成立的次级选项。 */
  secondary: readonly SwitchOption[];
  primaryValue: string;
  secondaryValue: string;
  onPrimaryChange: (key: string) => void;
  onSecondaryChange: (key: string) => void;
  /** 主选项组的无障碍名称。 */
  ariaLabel: string;
  /** 次级选项组的无障碍名称。 */
  secondaryLabel: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const primaryName = `hl-switch-${uid}-primary`;
  const secondaryName = `hl-switch-${uid}-secondary`;
  const [first, second] = primary;
  const open = primaryValue === first.key;
  const subIndex = Math.max(
    0,
    secondary.findIndex((o) => o.key === secondaryValue)
  );
  const style = {
    "--hl-index": open ? 0 : 1,
    "--hl-sub-index": subIndex,
    "--hl-count": Math.max(1, secondary.length),
  } as CSSProperties;

  return (
    <div className={`hl-switch${open ? " is-open" : ""}`} style={style}>
      <div className="hl-switch-track">
        <span className="hl-switch-indicator" aria-hidden="true" />
        <div className="hl-switch-body" role="group" aria-label={ariaLabel}>
          <div className="hl-switch-slot">
            <label className="hl-switch-primary hl-switch-owner">
              <input
                type="radio"
                className="hl-switch-input"
                name={primaryName}
                checked={open}
                aria-label={first.label}
                onChange={() => onPrimaryChange(first.key)}
              />
              <span className="hl-switch-primary-label" aria-hidden="true">
                {first.label}
              </span>
            </label>

            <div className="hl-switch-sub" role="group" aria-label={secondaryLabel}>
              {secondary.map((o) => (
                <label
                  className={`hl-switch-option${
                    secondaryValue === o.key ? " is-active" : ""
                  }`}
                  key={o.key}
                >
                  <input
                    type="radio"
                    className="hl-switch-input"
                    name={secondaryName}
                    checked={secondaryValue === o.key}
                    disabled={!open}
                    aria-label={o.label}
                    onChange={() => onSecondaryChange(o.key)}
                  />
                  <span aria-hidden="true">{o.label}</span>
                </label>
              ))}
              <span className="hl-switch-sub-indicator" aria-hidden="true" />
            </div>
          </div>

          <label className={`hl-switch-primary${open ? "" : " is-active"}`}>
            <input
              type="radio"
              className="hl-switch-input"
              name={primaryName}
              checked={!open}
              aria-label={second.label}
              onChange={() => onPrimaryChange(second.key)}
            />
            <span className="hl-switch-primary-label" aria-hidden="true">
              {second.label}
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- select ------------------------------- */
/**
 * 自绘下拉。
 *
 * 原生 <select> 在安卓上展开的是一张系统单选列表——全屏白底、系统字体、
 * 跟这个产品毫无关系。在 iOS 上则是底部滚轮。它不只是一个"更朴素的控件"，
 * 它是另一个应用的界面，突然盖在"新增物品"上面。所以这里自己画。
 *
 * 两种呈现，同一份数据与键盘行为：
 * - ≤860px：底部抽屉，圆角/阴影与 Modal 同一套，48px 行高，让开安全区；
 * - 桌面：锚定触发器的浮层，下方放不下就向上翻，最高 340px 滚动。
 *
 * 键盘：↑↓ 移动、Enter 选中、Esc 关闭并回到触发器。列表超过 10 项时出现
 * 搜索框——分类有十几个，位置树可能几十个，靠滚动找太慢。
 */
export type SelectOption = {
  value: string;
  label: string;
  /** 右侧次要说明，如「可录入与修改物品」。只用于展示与搜索。 */
  hint?: string;
  /** 分类色点。 */
  dot?: string;
  /** 树形层级，用于位置一类的嵌套数据。 */
  depth?: number;
  disabled?: boolean;
};

type PanelPos = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxH: number;
  /** 触发器中心在面板内的横向位置：缩放入场/退场从这里长出来。 */
  originX: number;
  /** 面板开在触发器上方（下方放不下时翻转）。 */
  up: boolean;
};

export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  title,
  disabled,
  searchable,
  className = "",
  style,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  searchable?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<PanelPos | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  /* 关闭时先播完退场再卸载：面板从触发器的位置缩回去，而不是瞬间消失。
     抽屉略慢一点，和 sheet-up 的时长对齐。 */
  const { mounted, closing } = usePresence(open, sheet ? 200 : 150);

  const selected = options.find((o) => o.value === value) ?? null;
  const withSearch = searchable ?? options.length > 10;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.hint ? o.hint.toLowerCase().includes(q) : false)
    );
  }, [options, query]);

  const scrollTo = useCallback((idx: number) => {
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const close = useCallback((restoreFocus?: boolean) => {
    setOpen(false);
    /* 搜索词留到下次打开时再清（openPicker 会清）。关闭动画期间还挂着面板，
       这时清空会让列表在淡出的 150ms 里突然从筛选结果跳回全量。 */
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openPicker = useCallback(() => {
    if (disabled) return;
    setSheet(window.matchMedia("(max-width: 860px)").matches);
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setPos(null);
    setOpen(true);
  }, [disabled, options, value]);

  const pick = useCallback(
    (o: SelectOption) => {
      if (o.disabled) return;
      onChange(o.value);
      close(true);
    },
    [onChange, close]
  );

  /* 桌面浮层定位：贴着触发器，下方空间不够就翻到上方。 */
  useLayoutEffect(() => {
    if (!open || sheet) return;
    const el = triggerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const gap = 6;
      const below = window.innerHeight - r.bottom - gap - 12;
      const above = r.top - gap - 12;
      const up = below < 200 && above > below;
      const width = Math.max(r.width, 208);
      const left = Math.max(10, Math.min(r.left, window.innerWidth - width - 10));
      const maxH = Math.max(150, Math.min(up ? above : below, 340));
      /* 缩放原点对准触发器中心：面板像是从这颗按钮里长出来的。
         贴边被夹住时把原点收进面板内，避免整块从屏幕外飞入。 */
      const originX = Math.max(
        14,
        Math.min(r.left + r.width / 2 - left, width - 14)
      );
      setPos(
        up
          ? { left, width, bottom: window.innerHeight - r.top + gap, maxH, originX, up: true }
          : { left, width, top: r.bottom + gap, maxH, originX, up: false }
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, sheet]);

  /* 打开后把焦点放进面板（而不是搜索框——手机会立刻弹出键盘）。 */
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (!sheet && withSearch && filtered.length > 8) searchRef.current?.focus();
      else panelRef.current?.focus({ preventScroll: true });
      scrollTo(active);
    });
    return () => cancelAnimationFrame(raf);
    // 只在打开的那一刻执行；后续 active 变化由键盘处理主动滚动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  /* 外部点击关闭。捕获阶段，避免被内层 stopPropagation 吃掉。 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, close]);

  /* 抽屉打开时锁住页面滚动，退场动画期间也继续锁着。 */
  useEffect(() => {
    if (!mounted || !sheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, sheet]);

  /* 手机上点搜索框，键盘会把抽屉的下半截盖住。visualViewport 是唯一
     能拿到键盘高度的东西——innerHeight 不会因为键盘而改变。 */
  useEffect(() => {
    if (!open || !sheet) return;
    const el = panelRef.current;
    const vv = window.visualViewport;
    if (!el || !vv) return;
    const apply = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.bottom = `${covered}px`;
      el.style.maxHeight = covered > 0 ? `${Math.round(vv.height * 0.74)}px` : "";
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      el.style.bottom = "";
      el.style.maxHeight = "";
    };
  }, [open, sheet]);

  /* 键盘。捕获阶段拦下 Esc，否则外层 Modal 会跟着一起关。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (!filtered.length) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let i = active;
        for (let n = 0; n < filtered.length; n++) {
          i = (i + dir + filtered.length) % filtered.length;
          if (!filtered[i].disabled) break;
        }
        setActive(i);
        scrollTo(i);
        return;
      }
      if (e.key === "Enter") {
        const o = filtered[active];
        if (!o || o.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        pick(o);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, filtered, active, pick, close, scrollTo]);

  const panelStyle: CSSProperties = sheet
    ? {}
    : pos
      ? ({
          left: pos.left,
          width: pos.width,
          top: pos.top,
          bottom: pos.bottom,
          maxHeight: pos.maxH,
          transformOrigin: `${pos.originX}px ${pos.up ? "bottom" : "top"}`,
          /* 进场从触发器方向来、退场回触发器方向去（向上翻时方向相反）。 */
          "--sel-enter-y": pos.up ? "4px" : "-4px",
          "--sel-exit-y": pos.up ? "3px" : "-3px",
        } as CSSProperties)
      : { left: 0, top: 0, width: 208, visibility: "hidden" };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`input ui-select ${className}`}
        style={style}
        disabled={disabled}
        data-field={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        /* 读屏念「分类：厨房」而不是干巴巴一个「分类」。aria-label 会盖掉
           按钮里的可见文本，所以把当前值一起写进来。 */
        aria-label={
          ariaLabel ? `${ariaLabel}：${selected ? selected.label : placeholder}` : undefined
        }
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <span className={`ui-select-value ${selected ? "" : "is-placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" size={13} className="ui-select-chev" />
      </button>

      {mounted &&
        createPortal(
          <>
            {sheet && (
              <div
                className={`ui-select-scrim${closing ? " is-closing" : ""}`}
                onPointerDown={() => close()}
                aria-hidden="true"
              />
            )}
            <div
              ref={panelRef}
              tabIndex={-1}
              role="listbox"
              aria-label={title || ariaLabel || placeholder}
              aria-activedescendant={
                filtered[active] ? `${listId}-${active}` : undefined
              }
              className={`ui-select-panel${sheet ? " sheet" : ""}${
                closing ? " is-closing" : ""
              }`}
              style={panelStyle}
            >
              {sheet && (
                <div className="ui-select-head">
                  <div className="ui-select-title">{title || placeholder}</div>
                  <button className="icon-btn" onClick={() => close(true)} aria-label="关闭">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              )}
              {withSearch && (
                <div className="ui-select-search">
                  <Icon name="search" size={14} />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索…"
                    aria-label="搜索选项"
                    inputMode="search"
                  />
                </div>
              )}
              <div className="ui-select-list" ref={listRef}>
                {filtered.length === 0 && (
                  <div className="ui-select-empty">没有匹配的选项</div>
                )}
                {filtered.map((o, i) => (
                  <div
                    key={o.value || "__none"}
                    id={`${listId}-${i}`}
                    data-idx={i}
                    data-active={i === active}
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled || undefined}
                    className={`ui-select-opt ${o.value === value ? "is-selected" : ""} ${
                      o.disabled ? "is-disabled" : ""
                    }`}
                    style={o.depth ? { paddingLeft: 12 + o.depth * 14 } : undefined}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    {o.dot && <i className="ui-select-dot" style={{ background: o.dot }} />}
                    <span className="ui-select-opt-label">{o.label}</span>
                    {o.hint && <span className="ui-select-opt-hint">{o.hint}</span>}
                    {o.value === value && (
                      <Icon name="check" size={14} className="ui-select-check" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>,
          document.body
        )}
    </>
  );
}

/* 剪贴板 API 在非安全上下文（局域网 http）和旧 WebView 上可能不存在，
   退回 execCommand，保证「复制」这个动作在这些环境里仍然可用。 */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒或非安全上下文，走兜底 */
  }
  return legacyCopy(text);
}

/**
 * 会自己报喜的复制按钮。
 *
 * 原先复制完只在屏幕底部弹一条 toast——视线在按钮上，确认却在别处。
 * 这里把确认放回按钮本身：图标换成对勾、文案换成「已复制」，1.6s 后复原；
 * 失败则换成叉和「复制失败」。三份文案叠在同一个网格单元里，宽度取最长的
 * 那份，状态切换不会推挤旁边的按钮。
 */
export function CopyButton({
  value,
  label = "复制",
  copiedLabel = "已复制",
  className = "",
  disabled,
  title,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    if (disabled) return;
    const ok = await copyText(value);
    setStatus(ok ? "copied" : "error");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), 1600);
  };

  return (
    <button
      type="button"
      className={`btn btn-sm copy-btn ${className}`}
      data-status={status}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
    >
      <span className="copy-btn-ic" aria-hidden="true">
        <Icon name="copy" size={13} className="copy-ic copy-ic-copy" />
        <svg
          className="copy-ic copy-ic-check"
          viewBox="0 0 14 14"
          width={13}
          height={13}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.8 7.4 5.6 10.2 11.2 4" pathLength={1} />
        </svg>
        <Icon name="x" size={13} className="copy-ic copy-ic-error" />
      </span>
      <span className="copy-btn-label" aria-hidden="true">
        <span className="copy-label is-idle">{label}</span>
        <span className="copy-label is-copied">{copiedLabel}</span>
        <span className="copy-label is-error">复制失败</span>
      </span>
      <span className="sr-only" role="status">
        {status === "copied" ? copiedLabel : status === "error" ? "复制失败" : ""}
      </span>
    </button>
  );
}

/**
 * 按钮里会换的文案：空闲文案与加载文案叠在同一个网格单元里，
 * 按钮宽度取较长的那份。切换时按钮不会把旁边的元素推来推去；
 * 非当前文案对读屏隐藏，可访问名称始终只有正在显示的那一句。
 */
export function ButtonLabel({
  busy,
  idle,
  busyLabel,
}: {
  busy: boolean;
  idle: ReactNode;
  busyLabel: ReactNode;
}) {
  return (
    <span className="button-label">
      <span className={busy ? "is-off" : undefined} aria-hidden={busy || undefined}>
        {idle}
      </span>
      <span className={busy ? undefined : "is-off"} aria-hidden={!busy || undefined}>
        {busyLabel}
      </span>
    </span>
  );
}

/**
 * 数字入场：从当前屏幕上显示的值滚到目标值，而不是瞬间跳过去。
 *
 * 首屏从 0 开始；数据刷新时从正在显示的值继续，不会先跳回 0——
 * 这一点和 Apple 的「从当前值开始动画」是同一条原则。缓动用 ease-out
 * 三次方，步长越大滚得稍久；`prefers-reduced-motion` 下直接显示结果。
 */
export function AnimatedNumber({
  value,
  format = (n) => String(n),
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const [shown, setShown] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? value
      : 0
  );
  const shownRef = useRef(shown);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const from = shownRef.current;
    if (from === value) return;
    const delta = value - from;
    const duration = Math.min(620, 320 + Math.abs(delta) * 3);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + delta * eased);
      shownRef.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{format(shown)}</>;
}
