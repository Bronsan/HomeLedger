import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { del, get, post, getMode } from "../api/client";
import type { Item, Page } from "../api/types";
import { Icon } from "../components/icons";
import { ConfirmDialog, Empty, useConfirm, useToast } from "../components/ui";
import { fmtDate } from "../lib/format";
import { useAuth } from "../hooks/auth";

/**
 * 归档（回收站视图）。
 *
 * 归档按钮一直存在，但物品归档后从常规列表消失，UI 里没有任何地方能再
 * 看到它——对误操作的人来说是单向门。后端的 restore 路由和列表的
 * archived 过滤（GET /items?archived=true）都在，这里把它们接到人手上。
 */
export function ArchivePage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [confirm, confirmDialog] = useConfirm();
  const [purging, setPurging] = useState<Item | null>(null);
  const [purgeAll, setPurgeAll] = useState(false);
  // 同步模式下服务器才是数据库：本地墓碑清了还会被拉回来，按钮不给
  const canPurgeAll = getMode() !== "sync";
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  // 归档 = 退役但留着；已删除 = 软删除的墓碑，restore 还够得着
  const [view, setView] = useState<"archived" | "deleted">("archived");

  const load = useCallback(async () => {
    try {
      const q = view === "archived" ? "archived=true" : "deleted=true";
      const page = await get<Page<Item>>(`/items?${q}&page_size=200`);
      setItems(page.items);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast, view]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 彻底删除：记录、附件文件、借出历史全部抹掉，不可恢复。 */
  const purge = async (it: Item) => {
    try {
      await del(`/items/${it.id}?hard=true`);
      toast(`「${it.name}」已彻底删除`);
      setPurging(null);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  /** 清空已删除：跳过有未归还借出的（blocked 里能看到是谁没走）。 */
  const purgeAllDeleted = async () => {
    try {
      const res = await post<{ purged: number; blocked: Array<{ name: string }> }>(
        "/items/purge-deleted"
      );
      if (res.blocked.length > 0) {
        toast(`已清除 ${res.purged} 件；${res.blocked.map((b) => `「${b.name}」`).join("、")}因有未归还借出被跳过`, "error");
      } else {
        toast(res.purged > 0 ? `已彻底删除 ${res.purged} 件物品` : "没有可清除的物品");
      }
      setPurgeAll(false);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const restore = async (it: Item) => {
    try {
      await post(`/items/${it.id}/restore`);
      toast(`「${it.name}」已恢复，回到物品列表`);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="archive-page">
      <div className="page-head">
        <div>
          <h1 className="h1">回收站</h1>
          <div className="sub">
            {view === "archived"
              ? "退役但还没舍得删的物品在这里。恢复后回到物品列表，数据一点不少"
              : "软删除的物品在这层。误删的还能捞回来，彻底删除才会真正抹掉"}
          </div>
        </div>
        {view === "deleted" && canPurgeAll && can("item.delete") && items.length > 0 && (
          <button className="btn" style={{ color: "var(--danger)" }} onClick={() => setPurgeAll(true)}>
            <Icon name="trash" size={14} />
            清空已删除
          </button>
        )}
      </div>

      <div className="filter-bar">
        {(
          [
            ["archived", "归档"],
            ["deleted", "已删除"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`chip ${view === k ? "active" : ""}`}
            onClick={() => setView(k)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card card-flush">
        {loading && (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ height: 120 }} />
          </div>
        )}
        {!loading && items.length === 0 && (
          <Empty
            icon="archive"
            title={view === "archived" ? "没有归档的物品" : "没有已删除的物品"}
            desc={
              view === "archived"
                ? "在物品详情页点「归档」，物品会搬到这里"
                : "在物品详情页点「删除」，物品会先落到这一层"
            }
          />
        )}
        {!loading &&
          items.map((it) => (
            <div className="maint-row" key={it.id}>
              <div
                className="maint-check"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface-hover)" }}
              >
                <Icon name="archive" size={10} />
              </div>
              <div className="maint-main" onClick={() => nav(`/items/${it.id}`)}>
                <div className="maint-title">
                  {it.name}
                  {view === "deleted" && <span className="badge danger">已删除</span>}
                </div>
                <div className="maint-sub">
                  <span className="mono">{it.code}</span>
                  <span className="dot-sep">·</span>
                  <span>
                    {view === "archived"
                      ? `归档于 ${it.archived_at ? fmtDate(it.archived_at) : "—"}`
                      : it.deleted_at
                      ? `删除于 ${fmtDate(it.deleted_at)}`
                      : "已删除"}
                  </span>
                  {it.quantity != null && (
                    <>
                      <span className="dot-sep">·</span>
                      <span>数量 {it.quantity}</span>
                    </>
                  )}
                </div>
              </div>
              {can("item.archive") && (
                <button className="btn btn-sm" onClick={() => void restore(it)}>
                  <Icon name="refresh" size={13} />
                  恢复
                </button>
              )}
              {can("item.delete") && (
                <button
                  className="icon-btn"
                  style={{ color: "var(--danger)" }}
                  title="彻底删除，不可恢复"
                  onClick={() => setPurging(it)}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
      </div>

      <ConfirmDialog
        open={purgeAll}
        title={`清空全部已删除物品（${items.length} 件）？`}
        message="这些物品的记录、附件文件、批次与借出历史会一起消失，二维码立即作废，无法恢复。有未归还借出的物品会被跳过并在结果里说明。"
        confirmText="全部彻底删除"
        danger
        onClose={() => setPurgeAll(false)}
        onConfirm={() => void purgeAllDeleted()}
      />
      <ConfirmDialog
        open={Boolean(purging)}
        title={`彻底删除「${purging?.name}」？`}
        message="物品记录、附件文件、批次与借出历史会一起消失，二维码立即作废，无法恢复。软删除之外的数据只有这一刀会真正抹掉。"
        confirmText="彻底删除"
        danger
        onClose={() => setPurging(null)}
        onConfirm={async () => {
          if (purging) await purge(purging);
        }}
      />
      {confirmDialog}
    </div>
  );
}
