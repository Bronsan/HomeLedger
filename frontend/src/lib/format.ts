export const STATUS_META: Record<
  string,
  { label: string; cls: string; icon: string }
> = {
  in_use: { label: "在用", cls: "ok", icon: "check-circle" },
  stored: { label: "存放", cls: "", icon: "box" },
  lent: { label: "借出", cls: "info", icon: "arrow-up-right" },
  repair: { label: "维修中", cls: "warn", icon: "wrench" },
  lost: { label: "丢失", cls: "danger", icon: "alert" },
  disposed: { label: "已处理", cls: "", icon: "archive" },
  archived: { label: "已归档", cls: "", icon: "archive" },
};

export const CONDITION_LABEL: Record<string, string> = {
  new: "全新",
  good: "良好",
  fair: "一般",
  poor: "较差",
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  routine: "日常保养",
  repair: "维修",
  inspection: "检查",
  warranty: "保修",
  replacement: "更换耗材",
};

export const PRIORITY_META: Record<string, { label: string; cls: string }> = {
  low: { label: "低", cls: "" },
  normal: { label: "普通", cls: "" },
  high: { label: "高", cls: "warn" },
  urgent: { label: "紧急", cls: "danger" },
};

export const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  photo: "照片",
  invoice: "发票",
  manual: "说明书",
  receipt: "小票",
  warranty: "保修卡",
  contract: "合同",
  other: "其他",
};

export function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${fmtDate(value)} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function relativeTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return "—";
  const diff = Date.now() - d;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, string][] = [
    [1000 * 60, "分钟"],
    [1000 * 3600, "小时"],
    [1000 * 86400, "天"],
    [1000 * 86400 * 30, "个月"],
    [1000 * 86400 * 365, "年"],
  ];
  if (abs < 60_000) return future ? "即将" : "刚刚";
  let out = "";
  if (abs < 3_600_000) out = `${Math.round(abs / 60000)} 分钟`;
  else if (abs < 86_400_000) out = `${Math.round(abs / 3_600_000)} 小时`;
  else if (abs < 2_592_000_000) out = `${Math.round(abs / 86_400_000)} 天`;
  else if (abs < 31_536_000_000) out = `${Math.round(abs / 2_592_000_000)} 个月`;
  else out = `${Math.round(abs / 31_536_000_000)} 年`;
  void units;
  return future ? `${out}后` : `${out}前`;
}

export function dueLabel(days: number | null | undefined): { text: string; cls: string } {
  if (days === null || days === undefined) return { text: "无期限", cls: "" };
  if (days < 0) return { text: `逾期 ${Math.abs(days)} 天`, cls: "due-over" };
  if (days === 0) return { text: "今天到期", cls: "due-soon" };
  if (days <= 7) return { text: `${days} 天后`, cls: "due-soon" };
  if (days <= 60) return { text: `${days} 天后`, cls: "" };
  return { text: `${days} 天后`, cls: "" };
}

export function fmtMoney(value?: number | null, currency = "CNY"): string {
  if (value === null || value === undefined) return "—";
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return `${symbol}${value.toLocaleString("zh-CN", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtCompact(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return value.toLocaleString("zh-CN");
}

export function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function initials(name: string): string {
  return (name || "?").trim().slice(0, 1).toUpperCase();
}

const PALETTE = ["#0d6b5f", "#b45309", "#6d28d9", "#be123c", "#0369a1", "#4d7c0f", "#9333ea"];

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}
