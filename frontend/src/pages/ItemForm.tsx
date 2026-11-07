import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, get } from "../api/client";
import type { Category, ItemDetail, Location, Member } from "../api/types";
import { Icon } from "../components/icons";
import { Select, Spinner, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";

interface FormState {
  name: string;
  description: string;
  category_id: string;
  location_id: string;
  quantity: string;
  unit: string;
  min_stock: string;
  status: string;
  condition: string;
  brand: string;
  model: string;
  serial_number: string;
  barcode: string;
  purchase_date: string;
  purchase_price: string;
  purchase_from: string;
  warranty_until: string;
  expected_life_months: string;
  owner_user_id: string;
  custodian_user_id: string;
  tags: string;
}

const EMPTY: FormState = {
  name: "",
  description: "",
  category_id: "",
  location_id: "",
  quantity: "1",
  unit: "件",
  min_stock: "",
  status: "in_use",
  condition: "good",
  brand: "",
  model: "",
  serial_number: "",
  barcode: "",
  purchase_date: "",
  purchase_price: "",
  purchase_from: "",
  warranty_until: "",
  expected_life_months: "",
  owner_user_id: "",
  custodian_user_id: "",
  tags: "",
};

const UNITS = ["件", "台", "个", "套", "双", "盒", "瓶", "本", "张"];

export function ItemFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const nav = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [params] = useSearchParams();

  const [form, setForm] = useState<FormState>({
    ...EMPTY,
    barcode: params.get("barcode") || "",
    name: params.get("name") || "",
    brand: params.get("brand") || "",
    model: params.get("model") || "",
    purchase_price: params.get("price") || "",
    owner_user_id: user?.id || "",
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [cfields, setCfields] = useState<Array<{ k: string; v: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    get<{ items: Category[] }>("/categories").then((r) => setCategories(r.items)).catch(() => {});
    get<{ items: Location[] }>("/locations").then((r) => setLocations(r.items)).catch(() => {});
    get<{ items: Member[] }>("/families/current/members")
      .then((r) => setMembers(r.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    get<{ item: ItemDetail }>(`/items/${id}`)
      .then(({ item }) => {
        setForm({
          name: item.name,
          description: item.description || "",
          category_id: item.category_id || "",
          location_id: item.location_id || "",
          quantity: String(item.quantity),
          unit: item.unit,
          min_stock: item.min_stock === null || item.min_stock === undefined ? "" : String(item.min_stock),
          status: item.status,
          condition: item.condition,
          brand: item.brand || "",
          model: item.model || "",
          serial_number: item.serial_number || "",
          barcode: item.barcode || "",
          purchase_date: item.purchase_date || "",
          purchase_price: item.purchase_price != null ? String(item.purchase_price) : "",
          purchase_from: item.purchase_from || "",
          warranty_until: item.warranty_until || "",
          expected_life_months: item.expected_life_months
            ? String(item.expected_life_months)
            : "",
          owner_user_id: item.owner_user_id || "",
          custodian_user_id: item.custodian_user_id || "",
          tags: (item.tags || []).join(", "),
        });
        setVersion(item.version);
        setCfields(
          Object.entries(item.custom_fields || {}).map(([k, v]) => ({ k, v: String(v ?? "") }))
        );
      })
      .catch(() => {
        toast("物品不存在", "error");
        nav("/items");
      })
      .finally(() => setLoading(false));
  }, [id, isEdit, nav, toast]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError("请填写物品名称");
      return;
    }
    setSaving(true);
    setError("");
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description,
      category_id: form.category_id || null,
      location_id: form.location_id || null,
      quantity: Number(form.quantity) || 1,
      unit: form.unit || "件",
      // 留空 = 不提醒；填了才下发阈值
      min_stock: form.min_stock.trim() === "" ? null : Number(form.min_stock),
      status: form.status,
      condition: form.condition,
      brand: form.brand,
      model: form.model,
      serial_number: form.serial_number,
      barcode: form.barcode,
      purchase_date: form.purchase_date || null,
      purchase_price: form.purchase_price ? Number(form.purchase_price) : null,
      purchase_from: form.purchase_from,
      warranty_until: form.warranty_until || null,
      expected_life_months: form.expected_life_months
        ? Number(form.expected_life_months)
        : null,
      owner_user_id: form.owner_user_id || null,
      custodian_user_id: form.custodian_user_id || null,
      tags: form.tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean),
      // 同名键后者覆盖前者（和对象字面量一致），空键丢弃
      custom_fields: Object.fromEntries(
        cfields
          .map((r) => ({ k: r.k.trim(), v: r.v.trim() }))
          .filter((r) => r.k)
          .map((r) => [r.k, r.v])
      ),
    };
    try {
      let itemId = id;
      if (isEdit) {
        const res = await api<{ item: { id: string } }>(`/items/${id}`, {
          method: "PATCH",
          body: { ...payload, version },
        });
        itemId = res.item.id;
        toast("已保存");
      } else {
        const res = await api<{ item: { id: string } }>("/items", {
          method: "POST",
          body: payload,
        });
        itemId = res.item.id;
        toast("物品已创建");
      }
      if (pendingFiles.length > 0 && itemId) {
        for (let i = 0; i < pendingFiles.length; i++) {
          const fd = new FormData();
          fd.append("file", pendingFiles[i]);
          fd.append("item_id", itemId);
          fd.append("kind", i === 0 ? "photo" : "other");
          fd.append("set_cover", String(i === 0));
          try {
            await api("/attachments", { form: fd });
          } catch {
            /* ignore individual upload failure */
          }
        }
      }
      nav(`/items/${itemId}`);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 300 }} />
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <div>
          <h1 className="h1">{isEdit ? "编辑物品" : "新增物品"}</h1>
          <div className="sub">
            {isEdit
              ? "修改后会记录到时间线，并同步给所有家庭成员"
              : "带 * 的为必填项。只有名称是必须的，其它可以以后再补。"}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => nav(-1)}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <Spinner /> : <Icon name="check" size={15} />}
            {isEdit ? "保存修改" : "创建物品"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="row gap-8 mb-16"
          style={{
            fontSize: 12.5,
            color: "var(--danger)",
            background: "var(--danger-soft)",
            padding: "10px 12px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          <Icon name="alert" size={14} />
          {error}
        </div>
      )}

      <div className="dash-main" style={{ gridTemplateColumns: "1.6fr 1fr", marginTop: 0 }}>
        <div className="col gap-16">
          <div className="card">
            <div className="form-section-title">
              <Icon name="package" size={15} />
              基本信息
            </div>
            <div className="col gap-16">
              <div className="field">
                <label className="label">
                  物品名称 <span className="req">*</span>
                </label>
                <input
                  className="input"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="例如：戴森 V12 无线吸尘器"
                  autoFocus
                  required
                />
              </div>

              <div className="form-grid">
                <div className="field">
                  <label className="label">分类</label>
                  <Select
                    value={form.category_id}
                    onChange={(v) => set("category_id", v)}
                    placeholder="未分类"
                    title="选择分类"
                    ariaLabel="分类"
                    options={[
                      { value: "", label: "未分类" },
                      ...categories.map((c) => ({
                        value: c.id,
                        label: c.name,
                        dot: c.color,
                      })),
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="label">存放位置</label>
                  <Select
                    value={form.location_id}
                    onChange={(v) => set("location_id", v)}
                    placeholder="未分配"
                    title="选择存放位置"
                    ariaLabel="存放位置"
                    options={[
                      { value: "", label: "未分配" },
                      ...locations.map((l) => ({ value: l.id, label: l.path || l.name })),
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="label">状态</label>
                  <Select
                    value={form.status}
                    onChange={(v) => set("status", v)}
                    title="选择状态"
                    ariaLabel="状态"
                    options={[
                      { value: "in_use", label: "在用" },
                      { value: "stored", label: "存放" },
                      { value: "lent", label: "借出" },
                      { value: "repair", label: "维修中" },
                      { value: "lost", label: "丢失" },
                      { value: "disposed", label: "已处理" },
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="label">成色</label>
                  <Select
                    value={form.condition}
                    onChange={(v) => set("condition", v)}
                    title="选择成色"
                    ariaLabel="成色"
                    options={[
                      { value: "new", label: "全新" },
                      { value: "good", label: "良好" },
                      { value: "fair", label: "一般" },
                      { value: "poor", label: "较差" },
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="label">数量</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.5"
                    value={form.quantity}
                    onChange={(e) => set("quantity", e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="label">单位</label>
                  <Select
                    value={form.unit}
                    onChange={(v) => set("unit", v)}
                    title="选择单位"
                    ariaLabel="单位"
                    options={UNITS.map((u) => ({ value: u, label: u }))}
                  />
                </div>
                <div className="field">
                  <label className="label">低库存阈值</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.5"
                    value={form.min_stock}
                    onChange={(e) => set("min_stock", e.target.value)}
                    placeholder="不提醒"
                  />
                  <div className="hint">数量不高于它时首页会提醒补货；留空则不提醒</div>
                </div>
              </div>

              <div className="field">
                <label className="label">备注</label>
                <textarea
                  className="textarea"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="使用习惯、注意事项、放在哪一层…"
                />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">
              <Icon name="tag" size={15} />
              型号与识别
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="label">品牌</label>
                <input
                  className="input"
                  value={form.brand}
                  onChange={(e) => set("brand", e.target.value)}
                  placeholder="Dyson"
                />
              </div>
              <div className="field">
                <label className="label">型号</label>
                <input
                  className="input"
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                  placeholder="V12 Detect Slim"
                />
              </div>
              <div className="field">
                <label className="label">序列号</label>
                <input
                  className="input mono"
                  value={form.serial_number}
                  onChange={(e) => set("serial_number", e.target.value)}
                  placeholder="机身或包装上的 SN"
                />
              </div>
              <div className="field">
                <label className="label">
                  商品条码
                  <span className="hint">EAN/UPC，非物品编号</span>
                </label>
                <input
                  className="input mono"
                  value={form.barcode}
                  onChange={(e) => set("barcode", e.target.value)}
                  placeholder="扫码或手动输入"
                />
              </div>
            </div>
            <div className="hint mt-12" style={{ display: "flex", gap: 6 }}>
              <Icon name="info" size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
              商品条码只对应"型号"，同一个条码可能有多件实物；HomeLedger
              会自动为这件实物生成唯一编号（如 HL-000123）用于贴标签。
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">
              <Icon name="trending-up" size={15} />
              购置与保修
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="label">购入日期</label>
                <input
                  className="input"
                  type="date"
                  value={form.purchase_date}
                  onChange={(e) => set("purchase_date", e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label">购入价格（元）</label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchase_price}
                  onChange={(e) => set("purchase_price", e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label className="label">购买渠道</label>
                <input
                  className="input"
                  value={form.purchase_from}
                  onChange={(e) => set("purchase_from", e.target.value)}
                  placeholder="京东 / 线下门店 / 朋友转让"
                />
              </div>
              <div className="field">
                <label className="label">保修截止</label>
                <input
                  className="input"
                  type="date"
                  value={form.warranty_until}
                  onChange={(e) => set("warranty_until", e.target.value)}
                />
              </div>
              <div className="field">
                <label className="label">预计使用年限（月）</label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={form.expected_life_months}
                  onChange={(e) => set("expected_life_months", e.target.value)}
                  placeholder="例如 60"
                />
                <div className="hint">用于估算更换时间，可留空</div>
              </div>
              <div className="field">
                <label className="label">标签</label>
                <input
                  className="input"
                  value={form.tags}
                  onChange={(e) => set("tags", e.target.value)}
                  placeholder="贵重, 常用, 可外借"
                />
                <div className="hint">用逗号分隔</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="form-section-title">
              <Icon name="list" size={15} />
              自定义字段
            </div>
            {cfields.length === 0 && (
              <div className="hint mb-12">
                想记保险单号、发票位置、滤芯型号这类型号表没有的字段？在这里加，详情页会照常展示。
              </div>
            )}
            <div className="col gap-8">
              {cfields.map((row, i) => (
                <div key={i} className="row gap-8" style={{ alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ flex: "0 0 34%" }}
                    value={row.k}
                    onChange={(e) =>
                      setCfields((rows) => rows.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))
                    }
                    placeholder="字段名，如 保险单号"
                  />
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={row.v}
                    onChange={(e) =>
                      setCfields((rows) => rows.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))
                    }
                    placeholder="值"
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="删除该字段"
                    aria-label={`删除字段 ${row.k || i + 1}`}
                    onClick={() => setCfields((rows) => rows.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost mt-12"
              onClick={() => setCfields((rows) => [...rows, { k: "", v: "" }])}
            >
              <Icon name="plus" size={13} />
              添加字段
            </button>
          </div>
        </div>

        <div className="col gap-16">
          <div className="card">
            <div className="card-title mb-12">
              <Icon name="image" size={15} />
              照片与附件
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf"
              style={{ display: "none" }}
              onChange={(e) => setPendingFiles(Array.from(e.target.files || []))}
            />
            <div
              className="upload-tile"
              style={{ aspectRatio: "16/9", borderRadius: "var(--radius-sm)" }}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="upload" size={20} />
              <span>{pendingFiles.length > 0 ? `已选择 ${pendingFiles.length} 个文件` : "选择照片或 PDF"}</span>
              <span className="tiny">保存后自动上传</span>
            </div>
            {pendingFiles.length > 0 && (
              <div className="col gap-4 mt-10">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="row gap-6 tiny muted">
                    <Icon name="file" size={12} />
                    <span className="truncate">{f.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title mb-12">
              <Icon name="users" size={15} />
              归属
            </div>
            <div className="col gap-12">
              <div className="field">
                <label className="label">所有人</label>
                <Select
                  value={form.owner_user_id}
                  onChange={(v) => set("owner_user_id", v)}
                  placeholder="未指定"
                  title="选择所有人"
                  ariaLabel="所有人"
                  options={[
                    { value: "", label: "未指定" },
                    ...members.map((m) => ({
                      value: m.user_id,
                      label: (m.nickname || m.display_name) + (m.user_id === user?.id ? "（我）" : ""),
                    })),
                  ]}
                />
              </div>
              <div className="field">
                <label className="label">保管人</label>
                <Select
                  value={form.custodian_user_id}
                  onChange={(v) => set("custodian_user_id", v)}
                  placeholder="同所有人"
                  title="选择保管人"
                  ariaLabel="保管人"
                  options={[
                    { value: "", label: "同所有人" },
                    ...members.map((m) => ({
                      value: m.user_id,
                      label: m.nickname || m.display_name,
                    })),
                  ]}
                />
              </div>
            </div>
          </div>

          <div
            className="card"
            style={{ background: "var(--brand-soft)", borderColor: "var(--brand-soft-2)" }}
          >
            <div className="row gap-8" style={{ alignItems: "flex-start" }}>
              <Icon name="qr" size={16} style={{ color: "var(--brand)", marginTop: 2 }} />
              <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--brand)" }}>
                <b>保存后自动生成二维码</b>
                <br />
                在物品详情页可以打印 A4 标签贴纸，全家扫码即可查看这件物品的全部档案。
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
