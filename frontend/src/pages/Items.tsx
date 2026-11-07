import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { post, assetUrl, get, qs } from "../api/client";
import type { Category, Item, Location, Page } from "../api/types";
import { Icon } from "../components/icons";
import { ConfirmDialog, Empty, Pagination, PillGroup, Select, Skeleton, useConfirm, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useLiveRefresh } from "../hooks/live";
import { STATUS_META, fmtDate, fmtMoney } from "../lib/format";

const STATUS_FILTERS = [
  { key: "", label: "全部状态" },
  { key: "in_use", label: "在用" },
  { key: "stored", label: "存放" },
  { key: "lent", label: "借出" },
  { key: "repair", label: "维修中" },
  { key: "lost", label: "丢失" },
];

const SORTS = [
  // dir: 切到该字段时的默认方向——时间/价格看最新最贵在前，名称/编号
  // 是字典序，升序才符合直觉。
  { key: "updated", label: "最近更新", dir: "desc" },
  { key: "created", label: "录入时间", dir: "desc" },
  { key: "name", label: "名称", dir: "asc" },
  { key: "price", label: "价格", dir: "desc" },
  { key: "warranty", label: "保修期", dir: "desc" },
] as const;

export function ItemsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [categoryId, setCategoryId] = useState(params.get("category") || "");
  const [locationId, setLocationId] = useState(params.get("location") || "");
  const [status, setStatus] = useState(params.get("status") || "");
  const [lowStock, setLowStock] = useState(params.get("low_stock") === "1");
  // 仪表盘「保修提醒」跳进来用：expiring=30 天内到期。手动填 URL 也支持
  // active/expired（后端本来就收），但常规筛选行不放它，保持界面轻。
  const [warranty, setWarranty] = useState(params.get("warranty") || "");
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchLoc, setBatchLoc] = useState("");
  // sort/order 支持从 URL 进入（仪表盘「登记价值」卡跳 /items?sort=price）
  const [sort, setSort] = useState(params.get("sort") || "updated");
  const [order, setOrder] = useState<"asc" | "desc">(
    params.get("order") === "asc" ? "asc" : "desc"
  );
  const [view, setView] = useState<"grid" | "list">(
    (localStorage.getItem("hl_view") as "grid" | "list") || "grid"
  );
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Item> | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 260);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    get<{ items: Category[] }>("/categories").then((r) => setCategories(r.items)).catch(() => {});
    get<{ items: Location[] }>("/locations").then((r) => setLocations(r.items)).catch(() => {});
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await get<Page<Item>>(
        `/items${qs({
          q: debounced || undefined,
          category_id: categoryId || undefined,
          location_id: locationId || undefined,
          status: status || undefined,
          low_stock: lowStock || undefined,
          warranty: warranty || undefined,
          sort,
          order,
          page,
          page_size: 24,
        })}`
      );
      setData(res);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [debounced, categoryId, locationId, status, lowStock, warranty, sort, order, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // 别人新增/改了物品，列表静默刷新——不闪骨架屏，否则每次有人保存这边都跳一下。
  useLiveRefresh(() => void load(true), ["item"]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (categoryId) next.set("category", categoryId);
    if (locationId) next.set("location", locationId);
    if (status) next.set("status", status);
    if (lowStock) next.set("low_stock", "1");
    if (warranty) next.set("warranty", warranty);
    setParams(next, { replace: true });
  }, [categoryId, locationId, status, lowStock, warranty, setParams]);

  useEffect(() => {
    setPage(1);
  }, [debounced, categoryId, locationId, status, lowStock, warranty]);

  const activeLocation = useMemo(
    () => locations.find((l) => l.id === locationId),
    [locations, locationId]
  );

  const toggleView = (v: "grid" | "list") => {
    setView(v);
    localStorage.setItem("hl_view", v);
  };

  const clearFilters = () => {
    setQ("");
    setCategoryId("");
    setLocationId("");
    setStatus("");
    setLowStock(false);
    setWarranty("");
  };

  const hasFilters = Boolean(
    debounced || categoryId || locationId || status || lowStock || warranty
  );

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitBatch = () => {
    setBatchMode(false);
    setSelected(new Set());
    setBatchLoc("");
  };

  /** 批量动作走完统一收口：清选择、刷新列表。 */
  const runBatch = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      exitBatch();
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const batchMove = () =>
    runBatch(
      () => post("/items/batch-update", { ids: [...selected], fields: { location_id: batchLoc || null } }),
      batchLoc ? `已把 ${selected.size} 件物品移到新位置` : `已清空 ${selected.size} 件物品的位置`
    );

  const batchArchive = () =>
    runBatch(async () => {
      // 逐件走现有归档路由：归档的副作用（事件、审计）与单件完全一致
      for (const id of selected) await post(`/items/${id}/archive`);
    }, `已归档 ${selected.size} 件物品`);

  const hasSelection = selected.size > 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">物品</h1>
          <div className="sub">
            {data ? `共 ${data.total} 件` : "正在统计…"}
            {activeLocation && ` · 位于 ${activeLocation.path || activeLocation.name}`}
            {!hasFilters &&
              ` · 按${SORTS.find((s) => s.key === sort)?.label || "最近更新"}${order === "asc" ? "升序" : "降序"}排序`}
          </div>
        </div>
        <div className="page-actions">
          <div className="input-group" style={{ width: 220 }}>
            <Icon name="search" size={16} />
            <input
              className="input"
              style={{ height: 34 }}
              placeholder="筛选名称、品牌、编号…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {can("item.create") && (
            <button className="btn btn-primary" onClick={() => nav("/items/new")}>
              <Icon name="plus" size={15} />
              新增
            </button>
          )}
        </div>
      </div>

      <div className="filter-bar" style={{ paddingTop: 0 }}>
        <div className="chip active" style={{ cursor: "default" }}>
          全部
          <span className="count">{data?.total ?? 0}</span>
        </div>
        <div style={{ width: 1, height: 20, background: "var(--border)", margin: "0 2px" }} />
        <Select
          className="filter-select"
          value={categoryId}
          onChange={setCategoryId}
          placeholder="全部分类"
          title="按分类筛选"
          ariaLabel="按分类筛选"
          options={[
            { value: "", label: "全部分类" },
            ...categories.map((c) => ({
              value: c.id,
              label: c.name,
              hint: String(c.item_count ?? 0),
              dot: c.color,
            })),
          ]}
        />
        <Select
          className="filter-select"
          value={locationId}
          onChange={setLocationId}
          placeholder="全部位置"
          title="按位置筛选"
          ariaLabel="按位置筛选"
          options={[
            { value: "", label: "全部位置" },
            ...locations.map((l) => ({ value: l.id, label: l.path || l.name })),
          ]}
        />
        <Select
          className="filter-select"
          value={status}
          onChange={setStatus}
          title="按状态筛选"
          ariaLabel="按状态筛选"
          options={STATUS_FILTERS.map((s) => ({ value: s.key, label: s.label }))}
        />
        <button
          className={`chip ${lowStock ? "active" : ""}`}
          onClick={() => setLowStock((v) => !v)}
          title="数量已跌破低库存阈值的物品"
        >
          库存不足
        </button>
        {warranty && (
          <button className="chip active" onClick={() => setWarranty("")} title="点击移除该筛选">
            保修 {warranty === "expiring" ? "30 天内到期" : warranty === "active" ? "在保" : "已过保"} ×
          </button>
        )}
        {can("item.update") && (
          <button
            className={`chip ${batchMode ? "active" : ""}`}
            onClick={() => (batchMode ? exitBatch() : setBatchMode(true))}
            title="多选物品后批量移动位置或归档"
          >
            批量管理
          </button>
        )}
        <Select
          className="filter-select"
          value={sort}
          onChange={(v) => {
            setSort(v);
            // 换字段时回到该字段的自然方向：时间/价格新→旧，名称/编号 A→Z
            const def = SORTS.find((s) => s.key === v)?.dir ?? "desc";
            setOrder(def);
          }}
          title="排序方式"
          ariaLabel="排序方式"
          options={SORTS.map((s) => ({ value: s.key, label: `按${s.label}` }))}
        />
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setOrder((o) => (o === "asc" ? "desc" : "asc"))}
          title={order === "asc" ? "升序" : "降序"}
          aria-label={order === "asc" ? "改为降序排序" : "改为升序排序"}
        >
          <Icon name={order === "asc" ? "sort-asc" : "sort-desc"} size={13} />
        </button>
        {hasFilters && (
          <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
            <Icon name="x" size={13} />
            清除筛选
          </button>
        )}
        <div className="spacer" />
        <PillGroup>
          <button
            className={`pill ${view === "grid" ? "active" : ""}`}
            onClick={() => toggleView("grid")}
            title="网格视图"
            aria-pressed={view === "grid"}
          >
            <Icon name="grid" size={13} />
          </button>
          <button
            className={`pill ${view === "list" ? "active" : ""}`}
            onClick={() => toggleView("list")}
            title="列表视图"
            aria-pressed={view === "list"}
          >
            <Icon name="list" size={13} />
          </button>
        </PillGroup>
      </div>

      {loading && (
        <div className="item-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="item-card" key={i} style={{ padding: 0 }}>
              <div className="skeleton" style={{ aspectRatio: "16/10", borderRadius: 0 }} />
              <div style={{ padding: 12 }}>
                <Skeleton w="80%" h={13} />
                <div style={{ height: 8 }} />
                <Skeleton w="50%" h={11} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && data && data.items.length === 0 && (
        <div className="card">
          <Empty
            icon={hasFilters ? "search" : "package"}
            title={hasFilters ? "没有符合条件的物品" : "还没有登记任何物品"}
            desc={
              hasFilters
                ? "换个关键词，或清除筛选条件看看"
                : "从最常用的那一件开始：扫一下商品条码，或者手动填几条信息。"
            }
            action={
              hasFilters ? (
                <button className="btn" onClick={clearFilters}>
                  清除筛选
                </button>
              ) : can("item.create") ? (
                <button className="btn" onClick={() => nav("/scan")}>
                  <Icon name="scan" size={14} />
                  扫码录入
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {!loading && data && data.items.length > 0 && view === "grid" && (
        <div className="item-grid">
          {data.items.map((it) => (
            <div
              className="item-card"
              key={it.id}
              style={{
                position: "relative",
                ...(batchMode && selected.has(it.id)
                  ? { outline: "2px solid var(--brand)", outlineOffset: -2, cursor: "pointer" }
                  : batchMode
                  ? { cursor: "pointer" }
                  : null),
              }}
              onClick={() => (batchMode ? toggleSelected(it.id) : nav(`/items/${it.id}`))}
            >
              {batchMode && (
                <div
                  style={{
                    position: "absolute",
                    top: 8,
                    left: 8,
                    width: 20,
                    height: 20,
                    borderRadius: "var(--radius-xs)",
                    display: "grid",
                    placeItems: "center",
                    zIndex: 2,
                    background: selected.has(it.id) ? "var(--brand)" : "color-mix(in srgb, var(--bg) 80%, transparent)",
                    color: "#fff",
                    border: "1px solid var(--border-strong)",
                  }}
                >
                  {selected.has(it.id) && <Icon name="check" size={12} />}
                </div>
              )}
              <div
                className="item-thumb"
                style={{ "--cat": it.category?.color || "var(--brand)" } as CSSProperties}
              >
                {it.cover_url ? (
                  <img
                    src={assetUrl(it.cover_url)}
                    alt={it.name}
                    loading="lazy"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div
                    className="placeholder"
                    style={{ color: it.category?.color || "var(--text-3)" }}
                  >
                    <Icon name={it.category?.icon || "package"} size={28} />
                  </div>
                )}
                <span className={`badge ${STATUS_META[it.status]?.cls || ""}`}>
                  <span className="dot" />
                  {STATUS_META[it.status]?.label || it.status}
                </span>
              </div>
              <div className="item-body">
                <div className="item-name clamp-2">{it.name}</div>
                <div className="item-meta">
                  <Icon name="map-pin" size={12} />
                  <span className="truncate">{it.location_path || "未分配位置"}</span>
                </div>
                <div className="item-foot">
                  <span className="item-code">{it.code}</span>
                  <div className="row gap-4" style={{ marginLeft: "auto" }}>
                    {it.warranty_state === "expiring" && (
                      <span className="badge warn" style={{ height: 18, fontSize: 10.5 }}>
                        保修将到期
                      </span>
                    )}
                    {it.open_tasks > 0 && (
                      <span className="badge" style={{ height: 18, fontSize: 10.5 }}>
                        <Icon name="wrench" size={10} />
                        {it.open_tasks}
                      </span>
                    )}
                    {it.purchase_price != null && (
                      <span className="tiny faint num">{fmtMoney(it.purchase_price)}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && data && data.items.length > 0 && view === "list" && (
        <div className="card card-flush">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>物品</th>
                  <th>位置</th>
                  <th>状态</th>
                  <th>购入价</th>
                  <th>保修至</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr
                    key={it.id}
                    style={batchMode ? { cursor: "pointer" } : undefined}
                    onClick={() => (batchMode ? toggleSelected(it.id) : nav(`/items/${it.id}`))}
                  >
                    {batchMode && (
                      <td style={{ width: 30 }}>
                        <div
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: "var(--radius-xs)",
                            display: "grid",
                            placeItems: "center",
                            background: selected.has(it.id) ? "var(--brand)" : "transparent",
                            border: "1px solid var(--border-strong)",
                            color: "#fff",
                          }}
                        >
                          {selected.has(it.id) && <Icon name="check" size={11} />}
                        </div>
                      </td>
                    )}
                    <td>
                      <div className="row gap-10">
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: "var(--radius-xs)",
                            background: it.category
                              ? `${it.category.color}16`
                              : "var(--bg-sunken)",
                            overflow: "hidden",
                            flex: "0 0 auto",
                            display: "grid",
                            placeItems: "center",
                            color: it.category?.color || "var(--text-3)",
                          }}
                        >
                          {it.cover_url ? (
                            <img
                              src={assetUrl(it.cover_url)}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <Icon name={it.category?.icon || "package"} size={14} />
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-strong truncate">{it.name}</div>
                          <div className="cell-sub mono">{it.code}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{it.location_path || "—"}</td>
                    <td>
                      <span className={`badge ${STATUS_META[it.status]?.cls || ""}`}>
                        <span className="dot" />
                        {STATUS_META[it.status]?.label || it.status}
                      </span>
                    </td>
                    <td className="num">{it.purchase_price != null ? fmtMoney(it.purchase_price) : "—"}</td>
                    <td className="muted num">{fmtDate(it.warranty_until)}</td>
                    <td className="muted tiny">{fmtDate(it.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {batchMode && (
        <div className="labels-bar">
          <div className="grow">
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {hasSelection ? `已选 ${selected.size} 件` : "点选要批量处理的物品"}
            </div>
            <div className="tiny faint">点卡片或行来多选；动作只作用于选中的物品</div>
          </div>
          {data && data.items.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setSelected((prev) =>
                  prev.size === data.items.length
                    ? new Set()
                    : new Set(data.items.map((it) => it.id))
                )
              }
              title={selected.size === data.items.length ? "取消全选" : "选中本页全部物品"}
            >
              {selected.size === data.items.length ? "取消全选" : "全选本页"}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={exitBatch} disabled={!hasSelection}>
            取消
          </button>
          <Select
            value={batchLoc}
            onChange={setBatchLoc}
            placeholder="移动到位置…"
            style={{ width: 150 }}
            disabled={!hasSelection}
            options={[
              { value: "", label: "无位置" },
              ...locations.map((l) => ({ value: l.id, label: l.path || l.name })),
            ]}
          />
          <button
            className="btn btn-sm"
            disabled={!hasSelection}
            onClick={() => void batchMove()}
          >
            <Icon name="map-pin" size={13} />
            移动
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!hasSelection}
            onClick={() =>
              void confirm(`归档后可在回收站恢复，共 ${selected.size} 件。`, {
                title: "归档选中物品？",
                confirmText: "归档",
              }).then((ok) => {
                if (ok) return batchArchive();
              })
            }
          >
            <Icon name="archive" size={13} />
            归档
          </button>
        </div>
      )}
      {confirmDialog}

      {data && data.pages > 1 && (
        <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
      )}
    </div>
  );
}
