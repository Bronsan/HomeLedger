export type Role = "owner" | "admin" | "member" | "viewer" | "guest";

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_color: string;
  /** 自定义头像；相对路径（远程）或 data URL（本机）。null = 用色块 */
  avatar_url: string | null;
  is_active: boolean;
  /** Instance-level operator. Household roles never grant this. */
  is_instance_admin?: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

export interface Family {
  id: string;
  name: string;
  invite_code: string;
  invite_expires_at: string | null;
  deployment_mode: string;
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  my_role?: Role;
  my_nickname?: string;
  my_overrides?: { grant?: string[]; deny?: string[] };
  member_count?: number;
  my_permissions?: string[];
}

export interface DeploymentInfo {
  mode: "local" | "gateway" | "cloud";
  label: string;
  tagline: string;
  description: string;
  capabilities: Record<string, boolean>;
  warnings: string[];
  checklist: { key: string; label: string; done: boolean }[];
  database: string;
  storage: string;
  data_dir: string;
  install_id: string;
  version: string;
}

export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  item_count?: number;
}

export interface Location {
  id: string;
  parent_id: string | null;
  name: string;
  kind: "room" | "furniture" | "container" | "zone";
  icon: string;
  note: string;
  sort_order: number;
  item_count?: number;
  path?: string;
  children?: Location[];
}

export interface Attachment {
  id: string;
  item_id: string | null;
  kind: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
  thumbnail_url: string | null;
  is_image: boolean;
}

export interface Item {
  id: string;
  code: string;
  name: string;
  description: string;
  category_id: string | null;
  category: Category | null;
  location_id: string | null;
  location: Location | null;
  location_path: string | null;
  quantity: number;
  unit: string;
  /** 低库存提醒阈值；null = 不提醒。 */
  min_stock: number | null;
  status: ItemStatus;
  condition: "new" | "good" | "fair" | "poor";
  brand: string;
  model: string;
  serial_number: string;
  barcode: string;
  barcode_type: string;
  purchase_date: string | null;
  purchase_price: number | null;
  currency: string;
  purchase_from: string;
  warranty_until: string | null;
  warranty_state: "none" | "active" | "expiring" | "expired";
  expected_life_months: number | null;
  owner_user_id: string | null;
  owner: { id: string; display_name: string; avatar_color: string } | null;
  custodian_user_id: string | null;
  custodian: { id: string; display_name: string; avatar_color: string } | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  cover_url: string | null;
  open_tasks: number;
  next_due_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /** 软删除时间；null = 未删除。只有回收站的「已删除」视图会返回非 null。 */
  deleted_at: string | null;
}

export type ItemStatus =
  | "in_use"
  | "stored"
  | "lent"
  | "repair"
  | "lost"
  | "disposed"
  | "archived";

/**
 * 一个批次（同一物品、同一生产/到期日的一批）。
 *
 * `expiry_state` 和 `days_left` 由服务端（或本机 serialize.ts）按当天日期算出，
 * 不是数据库里的列——存下来的状态过了午夜就是错的，还要靠定时任务去修。
 */
export interface ItemBatch {
  id: string;
  item_id: string;
  batch_no: string;
  quantity: number;
  /** 空字符串表示沿用物品单位，由界面回填。 */
  unit: string;
  produced_on: string | null;
  expires_on: string | null;
  location_id: string | null;
  location_path: string | null;
  supplier: string;
  note: string;
  expiry_state: "none" | "fresh" | "expiring" | "expired";
  days_left: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ItemDetail extends Item {
  components: {
    id: string;
    name: string;
    component_type: string;
    serial_number: string;
    quantity: number;
    installed_at: string | null;
    note: string;
  }[];
  batches: ItemBatch[];
  attachments: Attachment[];
  maintenance: {
    id: string;
    title: string;
    task_type: string;
    status: string;
    next_due_at: string | null;
    interval_days: number | null;
    priority: string;
  }[];
  events: ItemEvent[];
  loans: Loan[];
  acl: { id: string; user_id: string; permission: string; user: { display_name: string; email: string } }[];
  qr_url: string;
  label_url: string;
}

export interface ItemEvent {
  id: string;
  item_id: string;
  event_type: string;
  summary: string;
  payload: Record<string, unknown>;
  actor_name: string;
  created_at: string;
}

export interface Loan {
  id: string;
  item_id: string;
  item_name: string | null;
  item_code: string | null;
  borrower_name: string;
  borrower_contact: string;
  lent_at: string;
  due_at: string | null;
  returned_at: string | null;
  is_open: boolean;
  overdue: boolean;
  note: string;
}

export interface MaintenanceTask {
  id: string;
  item_id: string;
  item_name: string | null;
  item_code: string | null;
  title: string;
  task_type: string;
  interval_days: number | null;
  next_due_at: string | null;
  last_completed_at: string | null;
  assignee_id: string | null;
  assignee: { id: string; display_name: string; avatar_color: string } | null;
  status: "pending" | "done" | "skipped";
  priority: "low" | "normal" | "high" | "urgent";
  notes: string;
  estimated_cost: number | null;
  overdue: boolean;
  due_in_days: number | null;
  created_at: string;
}

export interface Member {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  nickname: string;
  avatar_color: string;
  avatar_url: string | null;
  role: Role;
  status: "active" | "suspended";
  permission_overrides: { grant?: string[]; deny?: string[] };
  joined_at: string;
  last_login_at: string | null;
}

export interface AuditEntry {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string;
  created_at: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: string;
  read_at: string | null;
  created_at: string;
}

export interface Dashboard {
  total_items: number;
  archived_items: number;
  total_value: number;
  by_status: Record<string, number>;
  by_category: { name: string; color: string; count: number }[];
  by_location: { name: string; count: number }[];
  warranty_expiring: number;
  warranty_expired: number;
  overdue_tasks: number;
  upcoming_tasks: number;
  open_loans: number;
  /** 借出未还且已过约定归还日的数量（首页告警条用）。 */
  overdue_loans: number;
  /** 数量已低于 min_stock 阈值的在库物品数。 */
  low_stock: number;
  /** 低库存明细（缺口最大的在前，最多 8 条），与临期批次卡同一模式。 */
  low_stock_list: {
    id: string;
    name: string;
    code: string;
    quantity: number;
    min_stock: number;
    unit: string;
  }[];
  unread_notifications: number;
  storage_bytes: number;
  /** 30 天内到期（含今天）的批次数。 */
  expiring_batches: number;
  /** 已经过期的批次数。 */
  expired_batches: number;
  /** 临期 + 过期批次，按到期日升序，最多 6 条。 */
  expiring_list: (ItemBatch & { item_name: string; item_code: string; item_unit: string })[];
  recent_items: {
    id: string;
    name: string;
    code: string;
    status: string;
    created_at: string;
    cover: string | null;
  }[];
  recent_events: {
    id: string;
    item_id: string;
    event_type: string;
    summary: string;
    actor_name: string;
    created_at: string;
  }[];
  purchase_trend: { month: string; amount: number; count: number }[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface PermissionMeta {
  roles: { value: Role; label: string; rank: number; permissions: string[] }[];
  groups: { name: string; items: { key: string; label: string }[] }[];
  all: string[];
}

export interface Backup {
  id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  kind: string;
  status: string;
  note: string;
  includes_files: boolean;
  created_by: string;
  created_at: string;
}
