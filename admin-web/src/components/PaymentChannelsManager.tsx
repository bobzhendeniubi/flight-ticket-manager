/**
 * 收款渠道管理（统一收款码 + 账号信息）—— ADMIN/STAFF。
 *
 * 列表 + 新增/编辑/删除收款渠道（微信 / 支付宝 / 银行）。
 * 每个渠道：分组(kind)、名称(label)、收款码图(data:image base64 ≤6MB)、
 * 账号文字(accountText)、备注(note)、是否启用(isActive)、排序(sortOrder)。
 *
 * 后端契约见 admin-web/src/lib/api.ts：listPaymentChannels / createPaymentChannel /
 * updatePaymentChannel / deletePaymentChannel（serializePaymentChannel 完整形态）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  PAYMENT_CHANNEL_KIND_LABEL,
  type AgentListItem,
  type CreatePaymentChannelWithAgentInput,
  type PaymentChannelKind,
  type PaymentChannelWithAgent,
  type UpdatePaymentChannelWithAgentInput,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from './Icon';
import { NumberInput } from './NumberInput';
import { ProofImageViewer } from './ProofImageViewer';
import { useConfirm } from './ConfirmDialog';

const KIND_OPTIONS: PaymentChannelKind[] = ['WECHAT', 'ALIPAY', 'BANK'];

// 二维码图最大 6MB（与后端 dataUrlImageSchema 对齐）
const MAX_QR_BYTES = 6 * 1024 * 1024;

type ChannelDraft = {
  kind: PaymentChannelKind;
  label: string;
  qrImageUrl: string | null;
  accountText: string;
  note: string;
  isActive: boolean;
  sortOrder: number | null;
  // 专属代理（部分代理有专用收款码）：'' = 公司统一码，对所有人展示
  agentId: string;
};

const EMPTY_DRAFT: ChannelDraft = {
  kind: 'WECHAT',
  label: '',
  qrImageUrl: null,
  accountText: '',
  note: '',
  isActive: true,
  sortOrder: 0,
  agentId: '',
};

function channelToDraft(c: PaymentChannelWithAgent): ChannelDraft {
  return {
    kind: (KIND_OPTIONS.includes(c.kind as PaymentChannelKind) ? c.kind : 'BANK') as PaymentChannelKind,
    label: c.label,
    qrImageUrl: c.qrImageUrl,
    accountText: c.accountText ?? '',
    note: c.note ?? '',
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    agentId: c.agentId ?? '',
  };
}

export function PaymentChannelsManager() {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [channels, setChannels] = useState<PaymentChannelWithAgent[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // null = 不在编辑；'new' = 新增；其它 = 正在编辑的 channel id
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    Promise.all([api.listPaymentChannels(token), api.listAgents(token)])
      .then(([channelsRes, agentsRes]) => {
        setChannels(channelsRes.channels as PaymentChannelWithAgent[]);
        setAgents(agentsRes.agents);
      })
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '加载收款渠道失败'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // 仅在 token 就绪时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function startNew() {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
  }

  function startEdit(c: PaymentChannelWithAgent) {
    setEditing(c.id);
    setDraft(channelToDraft(c));
    setFormErr(null);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
  }

  function onQrFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_QR_BYTES) {
      setFormErr('收款码图过大（>6MB），请压缩后再传');
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setDraft((d) => ({ ...d, qrImageUrl: typeof reader.result === 'string' ? reader.result : null }));
    reader.readAsDataURL(f);
  }

  async function save() {
    if (!token || saving) return;
    const label = draft.label.trim();
    if (!label) {
      setFormErr('请填写渠道名称');
      return;
    }
    setFormErr(null);
    setSaving(true);
    try {
      if (editing === 'new') {
        // 显式标注扩展类型（含 agentId），绕开对象字面量直传时的多余属性检查——
        // 不改 api.ts 中段既有的 CreatePaymentChannelInput（那里被另一并发改动同时编辑）。
        const body: CreatePaymentChannelWithAgentInput = {
          kind: draft.kind,
          label,
          qrImageUrl: draft.qrImageUrl ?? undefined,
          accountText: draft.accountText.trim() || undefined,
          note: draft.note.trim() || undefined,
          isActive: draft.isActive,
          sortOrder: draft.sortOrder ?? 0,
          agentId: draft.agentId || undefined,
        };
        const r = await api.createPaymentChannel(token, body);
        setChannels((prev) => [...prev, r.channel as PaymentChannelWithAgent]);
      } else if (editing) {
        // PATCH：可空字段传 null 清除
        const body: UpdatePaymentChannelWithAgentInput = {
          kind: draft.kind,
          label,
          qrImageUrl: draft.qrImageUrl ?? null,
          accountText: draft.accountText.trim() || null,
          note: draft.note.trim() || null,
          isActive: draft.isActive,
          sortOrder: draft.sortOrder ?? 0,
          agentId: draft.agentId || null,
        };
        const r = await api.updatePaymentChannel(token, editing, body);
        setChannels((prev) => prev.map((c) => (c.id === r.channel.id ? (r.channel as PaymentChannelWithAgent) : c)));
      }
      cancelEdit();
    } catch (e: unknown) {
      setFormErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function remove(c: PaymentChannelWithAgent) {
    if (!token || deletingId || confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({ title: `确认删除收款渠道「${c.label}」？`, tone: 'danger' }))) {
      confirmLockRef.current = false;
      return;
    }
    setErr(null);
    setDeletingId(c.id);
    try {
      await api.deletePaymentChannel(token, c.id);
      setChannels((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setDeletingId(null);
      confirmLockRef.current = false;
    }
  }

  const sorted = [...channels].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'zh-CN'),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">收款渠道</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            统一收款码 + 账号信息；启用的渠道会展示给前台客户付款。
          </p>
        </div>
        {editing === null && (
          <button type="button" className="btn-primary text-sm" onClick={startNew}>
            + 新增渠道
          </button>
        )}
      </div>

      {err && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {editing !== null && (
        <ChannelForm
          draft={draft}
          setDraft={setDraft}
          onQrFile={onQrFile}
          onSave={save}
          onCancel={cancelEdit}
          saving={saving}
          formErr={formErr}
          isNew={editing === 'new'}
          agents={agents}
        />
      )}

      <div className="card p-0">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th>排序</th>
                <th>分组</th>
                <th>名称</th>
                <th>收款码</th>
                <th>账号</th>
                <th>绑定代理</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-ink-muted">
                    暂无收款渠道，点右上「+ 新增渠道」添加。
                  </td>
                </tr>
              )}
              {!loading &&
                sorted.map((c) => (
                  <tr key={c.id}>
                    <td className="nums text-ink-muted">{c.sortOrder}</td>
                    <td>
                      <span className="badge-neutral">
                        {PAYMENT_CHANNEL_KIND_LABEL[c.kind as PaymentChannelKind] ?? c.kind}
                      </span>
                    </td>
                    <td className="font-medium text-ink">{c.label}</td>
                    <td>
                      {c.qrImageUrl ? (
                        <ProofImageViewer
                          src={c.qrImageUrl}
                          alt={`${c.label} 收款码`}
                          thumbClassName="h-10 w-10 rounded border border-slate-200 object-cover"
                        />
                      ) : (
                        <span className="text-xs text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate text-ink-soft" title={c.accountText ?? ''}>
                      {c.accountText || '—'}
                    </td>
                    <td>
                      {c.agentId ? (
                        <span className="badge-info">{c.agentName ?? c.agentId}</span>
                      ) : (
                        <span className="text-xs text-ink-muted">公司统一码</span>
                      )}
                    </td>
                    <td>
                      {c.isActive ? (
                        <span className="badge-success">启用</span>
                      ) : (
                        <span className="badge-neutral">停用</span>
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          onClick={() => startEdit(c)}
                          disabled={editing !== null || deletingId === c.id}
                        >
                          改
                        </button>
                        <button
                          type="button"
                          className="btn-ghost-danger px-2.5 py-1 text-xs disabled:opacity-50"
                          onClick={() => remove(c)}
                          disabled={editing !== null || deletingId === c.id}
                        >
                          {deletingId === c.id ? '删除中…' : '删'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ChannelForm({
  draft,
  setDraft,
  onQrFile,
  onSave,
  onCancel,
  saving,
  formErr,
  isNew,
  agents,
}: {
  draft: ChannelDraft;
  setDraft: React.Dispatch<React.SetStateAction<ChannelDraft>>;
  onQrFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  formErr: string | null;
  isNew: boolean;
  agents: AgentListItem[];
}) {
  return (
    <div className="card space-y-3 border-brand-200 bg-brand-50/40">
      <h3 className="text-sm font-semibold text-ink">{isNew ? '新增收款渠道' : '编辑收款渠道'}</h3>

      {formErr && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {formErr}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">分组</span>
          <select
            className="input"
            value={draft.kind}
            onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as PaymentChannelKind }))}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {PAYMENT_CHANNEL_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">名称</span>
          <input
            className="input"
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
            placeholder="如：公司微信收款 / 对公账户"
            maxLength={120}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="label">绑定代理（选填）</span>
          <select
            className="input"
            value={draft.agentId}
            onChange={(e) => setDraft((d) => ({ ...d, agentId: e.target.value }))}
          >
            <option value="">不绑定（公司统一码，对所有人展示）</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.companyName || a.contactName}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-muted">部分代理有专用收款码；绑定后仅该代理在认款页看到此码，不会对外公开展示。</p>
        </label>

        <label className="block sm:col-span-2">
          <span className="label">账号信息（选填）</span>
          <textarea
            className="input min-h-[60px]"
            value={draft.accountText}
            onChange={(e) => setDraft((d) => ({ ...d, accountText: e.target.value }))}
            placeholder="如：开户行 / 账号 / 户名"
            maxLength={2000}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="label">备注（选填）</span>
          <textarea
            className="input min-h-[48px]"
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            placeholder="对客户的付款说明"
            maxLength={2000}
          />
        </label>

        <div className="block">
          <span className="label">收款码（图片 ≤6MB，选填）</span>
          <div className="mt-1 flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-ink-soft hover:bg-slate-50">
              <Icon name="camera" /> 上传图片
              <input type="file" accept="image/*" className="hidden" onChange={onQrFile} />
            </label>
            {draft.qrImageUrl && (
              <>
                <img
                  src={draft.qrImageUrl}
                  alt="收款码预览"
                  className="h-12 w-12 rounded border border-slate-300 object-cover"
                />
                <button
                  type="button"
                  className="btn-ghost-danger text-xs"
                  onClick={() => setDraft((d) => ({ ...d, qrImageUrl: null }))}
                >
                  移除
                </button>
              </>
            )}
          </div>
        </div>

        <label className="block">
          <span className="label">排序（小在前）</span>
          <NumberInput
            integerOnly
            className="input nums"
            value={draft.sortOrder}
            onChange={(n) => setDraft((d) => ({ ...d, sortOrder: n }))}
            min={0}
            max={100000}
            placeholder="0"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300"
          checked={draft.isActive}
          onChange={(e) => setDraft((d) => ({ ...d, isActive: e.target.checked }))}
        />
        启用（前台可见）
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary text-sm" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="button" className="btn-primary text-sm disabled:opacity-50" onClick={onSave} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
