import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { del, get, patch, post } from "../api/client";
import type { Category } from "../api/types";
import { Icon } from "../components/icons";
import { ConfirmDialog, Empty, Modal, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";

const ICON_CHOICES = [
  "tv", "laptop", "sofa", "chef-hat", "wrench", "shirt", "bike",
  "heart-pulse", "file-text", "baby", "box", "tag", "home", "package",
];

const COLOR_CHOICES = [
  "#f97316", "#6366f1", "#a855f7", "#ef4444", "#f59e0b",
  "#ec4899", "#10b981", "#14b8a6", "#3b82f6", "#8b5cf6", "#64748b", "#0d6b5f",
];

interface Draft {
  id?: string;
  name: string;
  color: string;
  icon: string;
}

export function CategoriesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [items, setItems] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Category | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await get<{ items: Category[] }>("/categories");
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    try {
      if (draft.id) {
        await patch(`/categories/${draft.id}`, {
          name: draft.name.trim(),
          color: draft.color,
          icon: draft.icon,
        });
        toast("分类已更新");
      } else {
        await post("/categories", {
          name: draft.name.trim(),
          color: draft.color,
          icon: draft.icon,
        });
        toast("分类已创建");
      }
      setDraft(null);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const total = items.reduce((a, b) => a + (b.item_count || 0), 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">分类</h1>
          <div className="sub">
            {items.length} 个分类 · 覆盖 {total} 件物品
          </div>
        </div>
        {can("item.update") && (
          <button
            className="btn btn-primary"
            onClick={() => setDraft({ name: "", color: COLOR_CHOICES[0], icon: "box" })}
          >
            <Icon name="plus" size={15} />
            新增分类
          </button>
        )}
      </div>

      {loading && (
        <div className="item-grid">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div className="card" key={i}>
              <div className="skeleton" style={{ height: 60 }} />
            </div>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="card">
          <Empty
            icon="tag"
            title="还没有分类"
            desc="用分类把物品分组，比如家电、数码、工具；点右上角「新增分类」开始"
          />
        </div>
      )}

      <div className="item-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
        {items.map((c) => (
          <div
            key={c.id}
            className="card card-hover"
            style={{ padding: 0, overflow: "hidden", cursor: "pointer" }}
            onClick={() => nav(`/items?category=${c.id}`)}
          >
            <div style={{ height: 4, background: c.color }} />
            <div style={{ padding: "14px 15px 15px" }}>
              <div className="row-between">
                <div
                  className="cat-icon"
                  style={{ "--cat": c.color } as CSSProperties}
                >
                  <Icon name={c.icon} size={17} />
                </div>
                {can("item.update") && (
                  <div className="row gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      style={{ width: 26, height: 26 }}
                      onClick={() =>
                        setDraft({ id: c.id, name: c.name, color: c.color, icon: c.icon })
                      }
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      style={{ width: 26, height: 26 }}
                      onClick={() => setConfirm(c)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 12 }}>{c.name}</div>
              <div className="tiny faint" style={{ marginTop: 3 }}>
                {c.item_count ?? 0} 件物品
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? "编辑分类" : "新增分类"}
        footer={
          <>
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={save}>
              保存
            </button>
          </>
        }
      >
        {draft && (
          <div className="col gap-16">
            <div className="field">
              <label className="label">
                名称 <span className="req">*</span>
              </label>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如：家电"
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label">图标</label>
              <div className="row wrap gap-6">
                {ICON_CHOICES.map((ic) => (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setDraft({ ...draft, icon: ic })}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "var(--radius-xs)",
                      border: `1.5px solid ${
                        draft.icon === ic ? draft.color : "var(--border)"
                      }`,
                      background: draft.icon === ic ? `${draft.color}14` : "var(--surface)",
                      color: draft.icon === ic ? draft.color : "var(--text-2)",
                      display: "grid",
                      placeItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name={ic} size={16} />
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">颜色</label>
              <div className="row wrap gap-8">
                {COLOR_CHOICES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setDraft({ ...draft, color: c })}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "var(--radius-xs)",
                      background: c,
                      border: draft.color === c ? "2.5px solid var(--text)" : "2px solid transparent",
                      cursor: "pointer",
                      boxShadow: "0 0 0 1px rgba(0,0,0,.04)",
                    }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <div
              className="row gap-10"
              style={{
                padding: 12,
                borderRadius: "var(--radius-sm)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="cat-icon" style={{ "--cat": draft.color } as CSSProperties}>
                <Icon name={draft.icon} size={16} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{draft.name || "分类名称"}</div>
                <div className="tiny faint">预览效果</div>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="删除分类？"
        message={
          (confirm?.item_count ?? 0) > 0
            ? `「${confirm?.name}」下还有 ${confirm?.item_count} 件物品，需要先把它们移到其它分类。`
            : `「${confirm?.name}」将被删除，此操作会记入审计日志。`
        }
        confirmText="删除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await del(`/categories/${confirm.id}`);
            toast("已删除");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </div>
  );
}
