import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { assetUrl, del, get, patch, post } from "../api/client";
import type { Item, Location, Page } from "../api/types";
import { Icon } from "../components/icons";
import { ConfirmDialog, Empty, Modal, Select, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { STATUS_META, relativeTime } from "../lib/format";

const KIND_LABEL: Record<string, string> = {
  room: "房间",
  furniture: "家具",
  container: "收纳容器",
  zone: "区域",
};

const KIND_ICON: Record<string, string> = {
  room: "home",
  furniture: "sofa",
  container: "box",
  zone: "map-pin",
};

interface Draft {
  id?: string;
  name: string;
  parent_id: string;
  kind: string;
  icon: string;
  note: string;
}

const EMPTY: Draft = { name: "", parent_id: "", kind: "container", icon: "box", note: "" };

export function LocationsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [nodes, setNodes] = useState<Location[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Location | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<Location | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await get<{ items: Location[] }>("/locations");
      setNodes(res.items);
      setExpanded((prev) => (prev.size ? prev : new Set(res.items.filter((n) => !n.parent_id).map((n) => n.id))));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setItems([]);
      return;
    }
    get<Page<Item>>(`/items?location_id=${selected.id}&page_size=12`)
      .then((r) => setItems(r.items))
      .catch(() => {});
  }, [selected]);

  const childrenOf = useMemo(() => {
    const map: Record<string, Location[]> = {};
    nodes.forEach((n) => {
      const key = n.parent_id || "__root__";
      (map[key] ||= []).push(n);
    });
    return map;
  }, [nodes]);

  const roots = childrenOf["__root__"] || [];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    try {
      if (draft.id) {
        await patch(`/locations/${draft.id}`, {
          name: draft.name.trim(),
          parent_id: draft.parent_id || null,
          kind: draft.kind,
          note: draft.note,
        });
        toast("位置已更新");
      } else {
        await post("/locations", {
          name: draft.name.trim(),
          parent_id: draft.parent_id || null,
          kind: draft.kind,
          note: draft.note,
        });
        toast("位置已创建");
      }
      setDraft(null);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const renderNode = (node: Location, depth = 0) => {
    const kids = childrenOf[node.id] || [];
    const isOpen = expanded.has(node.id);
    return (
      <div key={node.id}>
        <div
          className="tree-row"
          style={{
            background: selected?.id === node.id ? "var(--brand-soft)" : undefined,
            color: selected?.id === node.id ? "var(--brand)" : undefined,
            paddingLeft: 9 + depth * 4,
          }}
          onClick={() => setSelected(node)}
        >
          <span
            className={`caret ${isOpen ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (kids.length) toggle(node.id);
            }}
            style={{ visibility: kids.length ? "visible" : "hidden" }}
          >
            <Icon name="chevron-right" size={11} />
          </span>
          <span className="ic">
            <Icon name={KIND_ICON[node.kind] || "box"} size={12} />
          </span>
          <span className="nm">{node.name}</span>
          <span className="cnt">{node.item_count ?? 0}</span>
          {can("item.update") && (
            <span className="acts">
              <button
                className="icon-btn"
                style={{ width: 22, height: 22 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft({
                    id: node.id,
                    name: node.name,
                    parent_id: node.parent_id || "",
                    kind: node.kind,
                    icon: node.icon,
                    note: node.note,
                  });
                }}
              >
                <Icon name="edit" size={11} />
              </button>
              <button
                className="icon-btn"
                style={{ width: 22, height: 22 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setDraft({
                    name: "",
                    parent_id: node.id,
                    kind: "container",
                    icon: "box",
                    note: "",
                  });
                }}
              >
                <Icon name="plus" size={11} />
              </button>
            </span>
          )}
        </div>
        {kids.length > 0 && isOpen && (
          <div className="tree-children">{kids.map((k) => renderNode(k, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">位置</h1>
          <div className="sub">从房间到收纳盒，建立你家的空间索引 · 共 {nodes.length} 个位置</div>
        </div>
        {can("item.update") && (
          <button className="btn btn-primary" onClick={() => setDraft({ ...EMPTY })}>
            <Icon name="plus" size={15} />
            新增位置
          </button>
        )}
      </div>

      <div className="dash-main" style={{ gridTemplateColumns: "340px 1fr", marginTop: 0 }}>
        <div className="card" style={{ padding: 10 }}>
          {loading && <div className="skeleton" style={{ height: 200 }} />}
          {!loading && roots.length === 0 && (
            <Empty
              icon="map-pin"
              title="还没有位置"
              desc="先建几个房间，再往里加柜子和收纳盒；点右上角「新增位置」开始"
            />
          )}
          <div className="tree">{roots.map((n) => renderNode(n))}</div>
        </div>

        <div className="col gap-16">
          {selected ? (
            <>
              <div className="card">
                <div className="row-between">
                  <div>
                    <div className="row gap-8">
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: "var(--radius-xs)",
                          background: "var(--brand-soft)",
                          color: "var(--brand)",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        <Icon name={KIND_ICON[selected.kind] || "box"} size={16} />
                      </div>
                      <div>
                        <div className="h2">{selected.name}</div>
                        <div className="tiny faint">
                          {KIND_LABEL[selected.kind]} · {selected.path || selected.name}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="row gap-6">
                    <span className="badge brand">{selected.item_count ?? 0} 件物品</span>
                    {can("item.update") && (
                      <button
                        className="btn btn-sm"
                        onClick={() =>
                          setDraft({
                            id: selected.id,
                            name: selected.name,
                            parent_id: selected.parent_id || "",
                            kind: selected.kind,
                            icon: selected.icon,
                            note: selected.note,
                          })
                        }
                      >
                        <Icon name="edit" size={13} />
                        编辑
                      </button>
                    )}
                    {can("item.archive") && (
                      <button className="btn btn-sm btn-danger" onClick={() => setConfirm(selected)}>
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                </div>
                {selected.note && (
                  <div className="mt-12 small muted" style={{ lineHeight: 1.7 }}>
                    {selected.note}
                  </div>
                )}
              </div>

              <div className="card card-flush">
                <div className="card-head" style={{ padding: "16px 18px 10px", marginBottom: 0 }}>
                  <div className="card-title">
                    <Icon name="package" size={15} />
                    此位置的物品
                  </div>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => nav(`/items?location=${selected.id}`)}
                  >
                    查看全部
                    <Icon name="chevron-right" size={13} />
                  </button>
                </div>
                {items.length === 0 ? (
                  <Empty
                    icon="package"
                    title="这个位置还是空的"
                    desc="添加物品时选择这个位置，它们就会出现在这里"
                  />
                ) : (
                  <div style={{ padding: "0 8px 10px" }}>
                    {items.map((it) => (
                      <div
                        key={it.id}
                        onClick={() => nav(`/items/${it.id}`)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 11,
                          padding: "9px 10px",
                          borderRadius: "var(--radius-xs)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: "var(--radius-xs)",
                            background: "var(--bg-sunken)",
                            overflow: "hidden",
                            display: "grid",
                            placeItems: "center",
                            color: "var(--text-3)",
                            flex: "0 0 auto",
                          }}
                        >
                          {it.cover_url ? (
                            <img
                              src={assetUrl(it.cover_url)}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <Icon name="package" size={14} />
                          )}
                        </div>
                        <div className="grow">
                          <div className="truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                            {it.name}
                          </div>
                          <div className="tiny faint">
                            {it.code} · 更新于 {relativeTime(it.updated_at)}
                          </div>
                        </div>
                        <span className={`badge ${STATUS_META[it.status]?.cls || ""}`}>
                          {STATUS_META[it.status]?.label || it.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <Empty
                icon="map-pin"
                title="选择一个位置"
                desc="左侧点击任意位置，查看它的子位置与存放的物品"
              />
            </div>
          )}
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? "编辑位置" : "新增位置"}
        subtitle="位置可以多层嵌套，例如：储物间 / 货架 A / 第二层"
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
          <div className="col gap-14" style={{ gap: 14 }}>
            <div className="field">
              <label className="label">
                名称 <span className="req">*</span>
              </label>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="例如：储物间、电视柜、第二层抽屉"
                autoFocus
              />
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="label">类型</label>
                <Select
                  value={draft.kind}
                  onChange={(v) => setDraft({ ...draft, kind: v })}
                  title="选择位置类型"
                  ariaLabel="位置类型"
                  options={[
                    { value: "room", label: "房间" },
                    { value: "furniture", label: "家具" },
                    { value: "container", label: "收纳容器" },
                    { value: "zone", label: "区域" },
                  ]}
                />
              </div>
              <div className="field">
                <label className="label">上级位置</label>
                <Select
                  value={draft.parent_id}
                  onChange={(v) => setDraft({ ...draft, parent_id: v })}
                  placeholder="无（顶级）"
                  title="选择上级位置"
                  ariaLabel="上级位置"
                  options={[
                    { value: "", label: "无（顶级）" },
                    ...nodes
                      .filter((n) => n.id !== draft.id)
                      .map((n) => ({ value: n.id, label: n.path || n.name })),
                  ]}
                />
              </div>
            </div>
            <div className="field">
              <label className="label">备注</label>
              <textarea
                className="textarea"
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                placeholder="例如：靠窗一侧，注意防潮"
              />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="删除这个位置？"
        message={
          <>
            位置「{confirm?.name}」将被删除。
            {(confirm?.item_count ?? 0) > 0 ? (
              <b style={{ color: "var(--danger)" }}>
                {" "}
                该位置下还有 {confirm?.item_count} 件物品，需要先移动它们。
              </b>
            ) : (
              " 此操作会记入审计日志。"
            )}
          </>
        }
        confirmText="删除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await del(`/locations/${confirm.id}`);
            toast("已删除");
            setSelected(null);
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </div>
  );
}
