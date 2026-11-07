/**
 * 主题色 / 背景的共享定义。
 *
 * 配色按六种色彩公式分组（单色、邻近、互补、三原、分裂互补、四原），
 * 每套方案除了主色，还带两束环境光颜色：`--accent-glow-a/b` 会在
 * glass.css 的背景层里和主色一起出现，所以换方案时背景不是只换一个色相，
 * 而是按公式一起换。
 *
 * 持久化：hl_accent + html[data-accent]，背景是 hl_bg + html[data-bg]。
 * 种子色通过内联 CSS 变量下发（而不是给每一档写一条 CSS 规则），新增
 * 方案只需要改这一个文件；旧的 8 个 key 保持兼容，已选过的用户不受影响。
 */

export type FormulaKey = "mono" | "analogous" | "complementary" | "triadic" | "split" | "tetradic";

export interface Formula {
  key: FormulaKey;
  label: string;
  hint: string;
}

export const FORMULAS: Formula[] = [
  { key: "mono", label: "单色搭配", hint: "同一色相，只调饱和与明暗" },
  { key: "analogous", label: "邻近色", hint: "色环相邻，自然有层次" },
  { key: "complementary", label: "互补色", hint: "正对色环，对比最强" },
  { key: "triadic", label: "三原色", hint: "等边三角，三色互撞" },
  { key: "split", label: "分裂互补", hint: "取互补两侧，强烈但更稳" },
  { key: "tetradic", label: "四原色", hint: "矩形四色，冷暖有张力" },
];

export interface Accent {
  key: string;
  label: string;
  /** 浅色主题的种子色（菜单里的色点用它）。 */
  dot: string;
  /** 暗色主题的种子色；缺省时由 dot 自动提亮。 */
  dark?: string;
}

/** 一套完整配色：主色 + 两束按公式选出的环境光。 */
export interface Palette extends Accent {
  formula: FormulaKey;
  /** 浅色主题背景里的第一束环境光（暗色下会再提亮）。 */
  glowA: string;
  /** 第二束环境光。 */
  glowB: string;
}

/**
 * 25 套方案（含默认的「松墨绿」）。
 * 旧的 8 个 key（blue/indigo/violet/pink/red/orange/cyan/green）原样保留。
 */
export const PALETTES: Palette[] = [
  // 单色：一个色相，靠饱和度和明度拉开层次
  { key: "", label: "松墨绿", formula: "mono", dot: "#2c6b5c", dark: "#86c9b2", glowA: "#8fbfae", glowB: "#8ebfd4" },
  { key: "forest", label: "林深", formula: "mono", dot: "#3f7a5a", glowA: "#79a88d", glowB: "#2f5e47" },
  { key: "ocean", label: "海渊", formula: "mono", dot: "#2f5f8f", glowA: "#7fa8c9", glowB: "#234a70" },
  { key: "plum", label: "黛紫", formula: "mono", dot: "#6b4f8a", glowA: "#a88fc0", glowB: "#4f3a6b" },
  { key: "clay", label: "赭石", formula: "mono", dot: "#9a5b3f", glowA: "#c99a7a", glowB: "#7a4630" },

  // 邻近色：主色两侧各取一个邻居
  { key: "blue", label: "远空蓝", formula: "analogous", dot: "#3b82f6", dark: "#60a5fa", glowA: "#22d3ee", glowB: "#6366f1" },
  { key: "indigo", label: "雾靛", formula: "analogous", dot: "#6366f1", dark: "#818cf8", glowA: "#3b82f6", glowB: "#8b5cf6" },
  { key: "violet", label: "鸢尾紫", formula: "analogous", dot: "#8b5cf6", dark: "#a78bfa", glowA: "#6366f1", glowB: "#ec4899" },
  { key: "pink", label: "樱粉", formula: "analogous", dot: "#ec4899", dark: "#f472b6", glowA: "#8b5cf6", glowB: "#e11d48" },

  // 互补色：主色与正对面的色相
  { key: "cyan", label: "浅濑青 × 暖橙", formula: "complementary", dot: "#06b6d4", dark: "#22d3ee", glowA: "#f97316", glowB: "#0891b2" },
  { key: "red", label: "绯红 × 新绿", formula: "complementary", dot: "#e11d48", dark: "#fb7185", glowA: "#22c55e", glowB: "#be123c" },
  { key: "orange", label: "暖橙 × 浅濑", formula: "complementary", dot: "#f97316", dark: "#fb923c", glowA: "#06b6d4", glowB: "#ea580c" },
  { key: "violet-gold", label: "紫 × 金", formula: "complementary", dot: "#7a4fa8", glowA: "#c9a23d", glowB: "#5b3a80" },

  // 三原色：色环上等边三角形的三个顶点
  { key: "green", label: "新叶 × 紫橙", formula: "triadic", dot: "#22c55e", dark: "#4ade80", glowA: "#8b5cf6", glowB: "#f97316" },
  { key: "tri-primary", label: "三原色", formula: "triadic", dot: "#b0442f", glowA: "#3f5fa8", glowB: "#c9a23d" },
  { key: "tri-cyan", label: "青品橙", formula: "triadic", dot: "#2f7fa8", glowA: "#a83a8a", glowB: "#c9773d" },
  { key: "tri-navy", label: "藏蓝玫金", formula: "triadic", dot: "#3f4f8a", glowA: "#b04a6b", glowB: "#c9a23d" },

  // 分裂互补：主色 + 互补色两侧的邻居
  { key: "split-blue", label: "蓝 × 霞", formula: "split", dot: "#3f6fa8", glowA: "#b04a3f", glowB: "#c98a3d" },
  { key: "split-green", label: "绿 × 莓", formula: "split", dot: "#4a7a3f", glowA: "#b04a6b", glowB: "#8a5ab0" },
  { key: "split-teal", label: "青 × 玫", formula: "split", dot: "#2f7a7a", glowA: "#b0476b", glowB: "#c97a3d" },
  { key: "split-violet", label: "紫 × 柠", formula: "split", dot: "#7a4fa8", glowA: "#8aa83f", glowB: "#c9a23d" },

  // 四原色：色环上的矩形四角
  { key: "quad-earth", label: "四方土", formula: "tetradic", dot: "#8a5a3f", glowA: "#4a6a8a", glowB: "#5a7a4a" },
  { key: "quad-garden", label: "四方园", formula: "tetradic", dot: "#4a7a5a", glowA: "#a85a6b", glowB: "#c9a23d" },
  { key: "quad-dusk", label: "四方暮", formula: "tetradic", dot: "#4a5a8a", glowA: "#c97a3d", glowB: "#3f8a8a" },
  { key: "quad-berry", label: "四方莓", formula: "tetradic", dot: "#8a4a6a", glowA: "#4a8a5a", glowB: "#4a6a9a" },
];

/** 桌面菜单只放旧的 8 档常用色，其余去设置页选。 */
const QUICK_KEYS = ["blue", "indigo", "violet", "pink", "red", "orange", "cyan", "green"];

export const ACCENTS: Accent[] = QUICK_KEYS.map((key) => {
  const p = PALETTES.find((x) => x.key === key)!;
  return { key: p.key, label: p.label, dot: p.dot, dark: p.dark };
});

/** 当前选中的主题色；"" 表示用默认的松墨绿。 */
export function currentAccent(): string {
  return localStorage.getItem("hl_accent") || "";
}

/** 把任意 #rrggbb 往白色方向抬 amount（0–1），用于没有手写暗色种子的新方案。 */
function lift(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * 应用一档配色；空串 = 恢复默认。
 * `persist=false` 供首屏恢复使用，避免重复写 localStorage。
 */
export function applyAccent(key: string, persist = true): void {
  const root = document.documentElement;
  const palette = key ? PALETTES.find((p) => p.key === key) : undefined;

  if (!palette) {
    // 未知/已下线的 key 一并清掉，避免每次启动都带着一个失效值。
    localStorage.removeItem("hl_accent");
    delete root.dataset.accent;
    for (const v of ["--accent-seed", "--accent-seed-dark", "--accent-glow-a", "--accent-glow-b"]) {
      root.style.removeProperty(v);
    }
    return;
  }

  if (persist) localStorage.setItem("hl_accent", key);
  root.dataset.accent = palette.key;
  root.style.setProperty("--accent-seed", palette.dot);
  root.style.setProperty("--accent-seed-dark", palette.dark ?? lift(palette.dot, 0.34));
  root.style.setProperty("--accent-glow-a", palette.glowA);
  root.style.setProperty("--accent-glow-b", palette.glowB);
}

/* ------------------------------- 背景 ---------------------------------- */

export interface BgStyle {
  key: string;
  label: string;
}

/** 背景纹理/环境光预设；"" 是皮肤原本的「晨雾」。 */
export const BACKGROUNDS: BgStyle[] = [
  { key: "", label: "晨雾" },
  { key: "plain", label: "素净" },
  { key: "paper", label: "方格纸" },
  { key: "drift", label: "斜阳" },
  { key: "dots", label: "网点" },
  { key: "weave", label: "细纹" },
];

export function currentBg(): string {
  return localStorage.getItem("hl_bg") || "";
}

export function applyBg(key: string, persist = true): void {
  const root = document.documentElement;
  const known = BACKGROUNDS.some((b) => b.key === key);
  if (!key || !known) {
    localStorage.removeItem("hl_bg");
    delete root.dataset.bg;
    return;
  }
  if (persist) localStorage.setItem("hl_bg", key);
  root.dataset.bg = key;
}
