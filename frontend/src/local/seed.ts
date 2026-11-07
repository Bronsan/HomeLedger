/**
 * First-run data.
 *
 * A brand new device must be usable before it has ever seen a server: no
 * empty-state dead end, no "please pair first". So the first launch mints a
 * local family, a local owner and the same taxonomy the backend seeds, which
 * means a device that later joins an existing family merges into a familiar
 * shape rather than a blank one.
 */

import { LocalStore, Row, nowIso, uuid } from "./store";

export const DEFAULT_CATEGORIES: [string, string, string][] = [
  ["家电", "tv", "#f97316"],
  ["数码", "laptop", "#6366f1"],
  ["家具", "sofa", "#a855f7"],
  ["厨房", "chef-hat", "#ef4444"],
  ["工具", "wrench", "#f59e0b"],
  ["衣物", "shirt", "#ec4899"],
  ["运动户外", "bike", "#10b981"],
  ["药品健康", "heart-pulse", "#14b8a6"],
  ["文件证件", "file-text", "#3b82f6"],
  ["儿童用品", "baby", "#8b5cf6"],
  ["其他", "box", "#64748b"],
];

export const DEFAULT_LOCATIONS: [string, string, string][] = [
  ["客厅", "room", "sofa"],
  ["主卧", "room", "bed"],
  ["次卧", "room", "bed"],
  ["厨房", "room", "chef-hat"],
  ["卫生间", "room", "droplets"],
  ["书房", "room", "book"],
  ["储物间", "room", "archive"],
  ["阳台", "room", "sun"],
];

export const ALL_PERMISSIONS = [
  "item.view",
  "item.create",
  "item.update",
  "item.archive",
  "item.delete",
  "item.loan",
  "doc.view",
  "doc.upload",
  "doc.download",
  "doc.delete",
  "maintenance.view",
  "maintenance.create",
  "maintenance.complete",
  "maintenance.update",
  "member.view",
  "member.invite",
  "member.update",
  "member.disable",
  "system.backup",
  "system.restore",
  "system.export",
  "system.deploy",
  "system.audit",
];

const READ_ONLY = ["item.view", "doc.view", "doc.download", "maintenance.view", "member.view"];

export const ROLE_PRESETS: { value: string; label: string; rank: number; permissions: string[] }[] = [
  { value: "owner", label: "所有者", rank: 50, permissions: ALL_PERMISSIONS },
  { value: "admin", label: "管理员", rank: 40, permissions: ALL_PERMISSIONS.filter((p) => p !== "system.deploy") },
  {
    value: "member",
    label: "成员",
    rank: 30,
    permissions: [
      "item.view", "item.create", "item.update", "item.archive", "item.loan",
      "doc.view", "doc.upload", "doc.download", "doc.delete",
      "maintenance.view", "maintenance.create", "maintenance.complete", "maintenance.update",
      "member.view", "system.export",
    ],
  },
  { value: "viewer", label: "只读", rank: 20, permissions: READ_ONLY },
  { value: "guest", label: "访客", rank: 10, permissions: ["item.view"] },
];

export const PERMISSION_LABELS: Record<string, string> = {
  "item.view": "查看物品",
  "item.create": "新增物品",
  "item.update": "编辑物品",
  "item.archive": "归档物品",
  "item.delete": "删除物品",
  "item.loan": "借出与归还",
  "doc.view": "查看附件",
  "doc.upload": "上传附件",
  "doc.download": "下载附件",
  "doc.delete": "删除附件",
  "maintenance.view": "查看维护",
  "maintenance.create": "新建维护",
  "maintenance.complete": "完成维护",
  "maintenance.update": "编辑维护",
  "member.view": "查看成员",
  "member.invite": "邀请成员",
  "member.update": "修改成员",
  "member.disable": "停用成员",
  "system.backup": "备份数据",
  "system.restore": "恢复数据",
  "system.export": "导出数据",
  "system.deploy": "部署设置",
  "system.audit": "查看审计",
};

export const PERMISSION_GROUPS = [
  { name: "物品", keys: ["item.view", "item.create", "item.update", "item.archive", "item.delete", "item.loan"] },
  { name: "文档", keys: ["doc.view", "doc.upload", "doc.download", "doc.delete"] },
  { name: "维护", keys: ["maintenance.view", "maintenance.create", "maintenance.complete", "maintenance.update"] },
  { name: "成员", keys: ["member.view", "member.invite", "member.update", "member.disable"] },
  { name: "系统", keys: ["system.backup", "system.restore", "system.export", "system.deploy", "system.audit"] },
];

function code(seq: number): string {
  return `HL-${String(seq).padStart(6, "0")}`;
}

/** Seeds a local family on a device that has never run before. */
export function seedLocalFamily(store: LocalStore, familyName = "我的家"): void {
  const familyId = uuid();
  const userId = uuid();
  const now = nowIso();
  const name = familyName.trim() || "我的家";

  store.write("users", {
    id: userId,
    email: "me@local",
    display_name: "我",
    avatar_color: "#0d6b5f",
    is_active: true,
    locale: "zh-CN",
    created_at: now,
    last_login_at: now,
    family_id: familyId,
  });

  store.write("families", {
    id: familyId,
    name,
    invite_code: "",
    deployment_mode: "local",
    settings: {},
    created_by: userId,
    created_at: now,
    family_id: familyId,
  });

  store.write("memberships", {
    id: uuid(),
    family_id: familyId,
    user_id: userId,
    role: "owner",
    nickname: "",
    status: "active",
    permission_overrides: {},
    joined_at: now,
  });

  DEFAULT_CATEGORIES.forEach(([catName, icon, color], i) => {
    store.write("categories", {
      id: uuid(),
      family_id: familyId,
      parent_id: null,
      name: catName,
      icon,
      color,
      sort_order: i * 10,
      created_at: now,
    });
  });

  DEFAULT_LOCATIONS.forEach(([locName, kind, icon], i) => {
    store.write("locations", {
      id: uuid(),
      family_id: familyId,
      parent_id: null,
      name: locName,
      kind,
      icon,
      note: "",
      sort_order: i * 10,
      created_at: now,
    });
  });

  store.patchMeta({
    family_id: familyId,
    family_name: name,
    user_id: userId,
    user_name: "我",
    seeded: true,
    created_at: now,
  });
}

/** Next free asset code. Scans instead of trusting a counter: two devices can
 * both have created rows offline and the counter would collide after merge. */
export function nextAssetCode(store: LocalStore): string {
  let max = 0;
  for (const row of store.all("items")) {
    const m = /^HL-(\d+)$/.exec(String(row.code || ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return code(max + 1);
}

export function familyRows(store: LocalStore): Row[] {
  return store.all("families");
}

export function currentFamily(store: LocalStore): Row | null {
  return store.get("families", store.meta.family_id);
}
