import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api/client";
import type { Item, Loan, Page } from "../api/types";
import { Icon } from "../components/icons";
import { Empty, Modal, Select, useToast } from "../components/ui";
import { fmtDate } from "../lib/format";
import { useAuth } from "../hooks/auth";

/**
 * 借还管理。
 *
 * API 和本地 handler 一直都在（1.0.x 起首页的 open_loans 计数就有数据），
 * 缺的只是这一页：借出去的东西没有地方看"都在谁手上"，逾期只能靠碰运气
 * 想起来。列表默认只看未还的；逾期在前，到期日一到就自己变红——
 * 和批次一样，状态是算出来的，不落库。
 */

const EMPTY_DRAFT = {
  item_id: "",
  borrower_name: "",
  borrower_contact: "",
  due_at: "",
  note: "",
};

export function LoansPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"open" | "returned">("open");
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // open_only=false 才拿全量；逾期/未还在前端按 is_open/overdue 分，
      // 切筛选不用再请求。
      const [loanPage, itemPage] = await Promise.all([
        get<{ items: Loan[] }>("/loans?open_only=false"),
        get<Page<Item>>("/items?page_size=200&sort=code"),
      ]);
      setLoans(loanPage.items);
      setItems(itemPage.items);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = loans.filter((l) => l.is_open);
  const returned = loans.filter((l) => !l.is_open);
  const visible = filter === "open" ? open : returned;
  const overdue = open.filter((l) => l.overdue);

  // 已借出的物品不能再借一次（后端会 409），表单里直接不列出来。
  const lendable = items.filter((it) => it.status !== "lent");

  const submit = async () => {
    if (!draft.item_id) {
      toast("选择要借出的物品", "error");
      return;
    }
    if (!draft.borrower_name.trim()) {
      toast("填写借给谁", "error");
      return;
    }
    setSaving(true);
    try {
      await post("/loans", {
        item_id: draft.item_id,
        borrower_name: draft.borrower_name.trim(),
        borrower_contact: draft.borrower_contact.trim(),
        due_at: draft.due_at || null,
        note: draft.note.trim(),
      });
      toast("已登记借出");
      setDraftOpen(false);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const giveBack = async (l: Loan) => {
    try {
      await post(`/loans/${l.id}/return`, {});
      toast(`「${l.item_name || "物品"}」已归还`);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="loans-page">
      <div className="page-head">
        <div>
          <h1 className="h1">借还</h1>
          <div className="sub">
            {open.length > 0
              ? `${open.length} 件在外面${overdue.length ? `，其中 ${overdue.length} 件已逾期` : ""}`
              : "没有东西在外头"}
          </div>
        </div>
        {can("item.loan") && (
          <button className="btn btn-primary" onClick={() => setDraftOpen(true)}>
            <Icon name="plus" size={15} />
            登记借出
          </button>
        )}
      </div>

      <div className="filter-bar">
        {(
          [
            ["open", `未还 ${open.length}`],
            ["returned", `已归还 ${returned.length}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`chip ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}
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
        {!loading && visible.length === 0 && (
          <Empty
            icon="inbox"
            title={filter === "open" ? "没有未归还的物品" : "还没有归还记录"}
            desc={
              filter === "open"
                ? "把东西借给家人朋友时，点右上角「登记借出」记一笔；到期日到了首页会提醒"
                : "归还之后记录会保留在这里"
            }
          />
        )}
        {!loading &&
          visible.map((l) => (
            <div className="maint-row" key={l.id}>
              <div
                className="maint-check"
                style={
                  l.is_open
                    ? { borderColor: "var(--amber)", background: "var(--amber-soft)" }
                    : { borderColor: "var(--brand)", background: "var(--brand-soft)" }
                }
              >
                <Icon name={l.is_open ? "clock" : "check"} size={10} />
              </div>
              <div
                className="maint-main"
                onClick={() => l.item_id && nav(`/items/${l.item_id}`)}
              >
                <div className="maint-title">
                  {l.item_name || "已删除的物品"}
                  {l.overdue && <span className="badge danger">已逾期</span>}
                  {!l.overdue && l.is_open && l.due_at && (
                    <span className="badge">{fmtDate(l.due_at)} 前归还</span>
                  )}
                </div>
                <div className="maint-sub">
                  <span>
                    借给 {l.borrower_name}
                    {l.borrower_contact ? `（${l.borrower_contact}）` : ""}
                  </span>
                  <span className="dot-sep">·</span>
                  <span>借出于 {fmtDate(l.lent_at)}</span>
                  {l.item_code && (
                    <>
                      <span className="dot-sep">·</span>
                      <span className="mono">{l.item_code}</span>
                    </>
                  )}
                </div>
              </div>
              {l.is_open && can("item.loan") && (
                <button className="btn btn-sm" onClick={() => void giveBack(l)}>
                  归还
                </button>
              )}
            </div>
          ))}
      </div>

      <Modal
        open={draftOpen}
        onClose={() => setDraftOpen(false)}
        title="登记借出"
        footer={
          <>
            <button className="btn" onClick={() => setDraftOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
              登记
            </button>
          </>
        }
      >
        <div className="col gap-12">
          <div className="field">
            <label className="label">物品</label>
            <Select
              value={draft.item_id}
              onChange={(v) => setDraft({ ...draft, item_id: v })}
              placeholder="选择要借出的物品"
              ariaLabel="选择要借出的物品"
              searchable
              options={lendable.map((it) => ({
                value: it.id,
                label: `${it.name}（${it.code}）`,
              }))}
            />
            <div className="hint">已处于借出状态的物品不会出现在这里</div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label className="label">借给谁</label>
              <input
                className="input"
                value={draft.borrower_name}
                onChange={(e) => setDraft({ ...draft, borrower_name: e.target.value })}
                placeholder="姓名或称呼"
                maxLength={120}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label">联系方式（选填）</label>
              <input
                className="input"
                value={draft.borrower_contact}
                onChange={(e) => setDraft({ ...draft, borrower_contact: e.target.value })}
                placeholder="电话 / 微信"
              />
            </div>
            <div className="field">
              <label className="label">约定归还日（选填）</label>
              <input
                className="input"
                type="date"
                value={draft.due_at}
                onChange={(e) => setDraft({ ...draft, due_at: e.target.value })}
              />
              <div className="hint">过了这一天还没还，列表和首页都会标红</div>
            </div>
            <div className="field">
              <label className="label">备注（选填）</label>
              <input
                className="input"
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                placeholder="例如：连同充电器一起借出"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
