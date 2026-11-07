import { useCallback, useEffect, useState } from "react";
import { get, qs } from "../api/client";
import type { AuditEntry, Page } from "../api/types";
import { Icon } from "../components/icons";
import { Empty, Pagination, Skeleton } from "../components/ui";
import { fmtDateTime, relativeTime } from "../lib/format";

const ACTION_GROUPS = [
  { key: "", label: "全部" },
  { key: "item", label: "物品" },
  { key: "member", label: "成员" },
  { key: "family", label: "家庭" },
  { key: "maintenance", label: "维护" },
  { key: "attachment", label: "文件" },
  { key: "system", label: "系统" },
];

const ACTION_LABEL: Record<string, string> = {
  "item.create": "新增物品",
  "item.update": "修改物品",
  "item.delete": "删除物品",
  "item.delete.hard": "永久删除",
  "item.archive": "归档物品",
  "item.restore": "恢复物品",
  "item.import": "批量导入",
  "item.bulk_create": "批量新增",
  "item.acl": "调整可见范围",
  "member.invite": "邀请成员",
  "member.update": "修改权限",
  "member.remove": "移除成员",
  "family.create": "创建家庭",
  "family.join": "加入家庭",
  "family.update": "更新家庭",
  "family.rotate_invite": "重置邀请码",
  "maintenance.create": "创建维护",
  "maintenance.update": "修改维护",
  "maintenance.complete": "完成维护",
  "maintenance.delete": "删除维护",
  "attachment.upload": "上传文件",
  "attachment.delete": "删除文件",
  "system.backup": "创建备份",
  "system.backup.delete": "删除备份",
  "auth.register": "注册账号",
  "location.create": "新增位置",
  "location.update": "修改位置",
  "location.delete": "删除位置",
  "category.create": "新增分类",
  "category.update": "修改分类",
  "category.delete": "删除分类",
  "loan.create": "登记借出",
  "loan.return": "登记归还",
};

const ACTION_ICON: Record<string, string> = {
  create: "plus",
  update: "edit",
  delete: "trash",
  complete: "check",
  backup: "database",
  upload: "upload",
  join: "users",
};

function iconFor(action: string): string {
  const suffix = action.split(".").pop() || "";
  return ACTION_ICON[suffix] || "activity";
}

export function AuditPage() {
  const [data, setData] = useState<Page<AuditEntry> | null>(null);
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<Page<AuditEntry>>(
        `/audit${qs({ action: group || undefined, page, page_size: 30 })}`
      );
      setData(res);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [group, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">操作记录</h1>
          <div className="sub">
            谁在什么时候改了什么，全部可追溯 · 仅追加，不可修改
          </div>
        </div>
      </div>

      <div className="filter-bar" style={{ paddingTop: 0 }}>
        {ACTION_GROUPS.map((g) => (
          <button
            key={g.key}
            className={`chip ${group === g.key ? "active" : ""}`}
            onClick={() => {
              setGroup(g.key);
              setPage(1);
            }}
          >
            {g.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="card">
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      )}

      {!loading && data && data.items.length === 0 && (
        <div className="card">
          <Empty
            icon="history"
            title="还没有操作记录"
            desc="录入、修改、删除、权限调整等关键操作都会自动记录在这里"
          />
        </div>
      )}

      {!loading && data && data.items.length > 0 && (
        <div className="card card-flush">
          {data.items.map((a) => (
            <div key={a.id}>
              <div
                className="maint-row"
                onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                style={{ alignItems: "flex-start" }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "var(--radius-xs)",
                    background:
                      a.action.includes("delete")
                        ? "var(--danger-soft)"
                        : a.action.includes("create")
                        ? "var(--brand-soft)"
                        : "var(--surface-hover)",
                    color: a.action.includes("delete")
                      ? "var(--danger)"
                      : a.action.includes("create")
                      ? "var(--brand)"
                      : "var(--text-2)",
                    display: "grid",
                    placeItems: "center",
                    flex: "0 0 auto",
                  }}
                >
                  <Icon name={iconFor(a.action)} size={13} />
                </div>
                <div className="maint-main">
                  <div className="maint-title" style={{ fontWeight: 500 }}>
                    <b style={{ fontWeight: 600 }}>{a.actor_name}</b>
                    <span className="faint" style={{ fontWeight: 400 }}>
                      {ACTION_LABEL[a.action] || a.action}
                    </span>
                    {a.entity_type && (
                      <span className="badge" style={{ fontWeight: 400 }}>
                        {a.entity_type}
                      </span>
                    )}
                  </div>
                  <div className="maint-sub">
                    <span>{a.summary}</span>
                  </div>
                </div>
                <div className="col" style={{ alignItems: "flex-end", gap: 2 }}>
                  <div className="tiny muted num">{relativeTime(a.created_at)}</div>
                  <div className="tiny faint num">{fmtDateTime(a.created_at)}</div>
                </div>
                <Icon
                  name={expanded === a.id ? "chevron-up" : "chevron-down"}
                  size={14}
                  style={{ color: "var(--text-3)", marginTop: 6 }}
                />
              </div>
              {expanded === a.id && (
                <div
                  style={{
                    padding: "0 18px 14px 60px",
                    fontSize: 12,
                    color: "var(--text-2)",
                  }}
                >
                  <div className="row gap-16 wrap" style={{ marginBottom: 8 }}>
                    <span>
                      实体 ID：<span className="mono">{a.entity_id.slice(0, 12) || "—"}</span>
                    </span>
                  </div>
                  {(a.before || a.after) && (
                    <pre
                      className="mono"
                      style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-xs)",
                        padding: 10,
                        overflowX: "auto",
                        fontSize: 11,
                        lineHeight: 1.6,
                        margin: 0,
                        maxHeight: 220,
                      }}
                    >
                      {JSON.stringify({ before: a.before, after: a.after }, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && data.pages > 1 && (
        <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
      )}
    </div>
  );
}
