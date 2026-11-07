export type ThemeChoice = "light" | "dark" | "system";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

type ViewTransitionStarter = (callback: () => void) => unknown;

/** 把主题写进 <html data-theme> 与 localStorage；system 解析成当前系统明暗。 */
function commitTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;
  localStorage.setItem("hl_theme", choice);
}

/**
 * 切换主题，并尽量给整页一次交叉淡入。
 *
 * 支持 View Transitions 的 Chromium/WebView2 会抓取切换前后的两帧、做
 * 180ms 的整页交叉淡化（时长写在 styles.css）；减少动态或不支持该 API
 * 的浏览器保持瞬时切换，行为与以前一致。
 *
 * `beforeCapture` 在浏览器抓取新界面前同步执行——调用方可以在这里用
 * flushSync 把 React 状态（主题按钮选中态、要关掉的菜单）一起提交，
 * 否则这些变化会落在过渡结束之后，出现「先换色、后换高亮」的跳变。
 */
export function applyThemeChoice(choice: ThemeChoice, beforeCapture?: () => void) {
  const start = (
    document as unknown as { startViewTransition?: ViewTransitionStarter }
  ).startViewTransition;
  const reduced = window.matchMedia(REDUCED_MOTION).matches;
  const run = () => {
    commitTheme(choice);
    beforeCapture?.();
  };
  if (!reduced && typeof start === "function") {
    start.call(document, run);
  } else {
    run();
  }
}
