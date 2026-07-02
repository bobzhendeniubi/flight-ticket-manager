/**
 * 余额与认款 —— 代理预存余额 + 认款（充值）通道。
 *
 * AGENT 视图：当前余额、应付款渠道（专属码优先，否则公司统一码）、
 *   提交认款申请（金额 + 备注 + 1-3 张付款凭证），下方看自己的申请状态列表。
 * ADMIN/STAFF 视图：待审核认款队列（确认到账金额可修正 / 驳回需填原因）、
 *   最近已处理列表、手动调整余额（线下对账修正用，扣减不能击穿 0）。
 *
 * 后端契约见 admin-web/src/lib/api.ts 末尾「代理认款 / 收款码绑代理」区块
 * （agentRechargeApi.*，对应 backend /agent-recharges 模块）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  agentRechargeApi,
  api,
  ApiError,
  AGENT_RECHARGE_STATUS_LABEL,
  PAYMENT_CHANNEL_KIND_LABEL,
  type AgentListItem,
  type AgentRechargeRequest,
  type AgentRechargeStatus,
  type PaymentChannel,
  type PaymentChannelKind,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

// ── 凭证图片压缩（与 sales-web PaymentPanel 的算法一致，目标体积调小到 ~1.5MB/张） ──
const MAX_PROOF_BYTES = 6 * 1024 * 1024;
const COMPRESS_TARGET_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1800;
const MAX_PROOF_COUNT = 3;

async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败，请重试'));
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败，请换一张'));
    img.src = src;
  });
}

async function compressDataUrl(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length <= COMPRESS_TARGET_BYTES) return out;
  }
  return canvas.toDataURL('image/jpeg', 0.45);
}

async function fileToProofDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请上传图片格式的付款凭证（如截图 JPG / PNG）');
  }
  const raw = await readAsDataUrl(file);
  if (raw.length <= COMPRESS_TARGET_BYTES) return raw;
  const compressed = await compressDataUrl(raw);
  if (compressed.length > MAX_PROOF_BYTES) {
    throw new Error('图片过大且压缩后仍超出限制，请换一张更小的截图');
  }
  return compressed;
}

function fmtCny(v: string | number): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
}

const STATUS_BADGE: Record<AgentRechargeStatus, string> = {
  PENDING: 'badge-warning',
  CONFIRMED: 'badge-success',
  REJECTED: 'badge-danger',
};

export function AgentBalancePage() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const isStaff = user?.role === 'ADMIN' || user?.role === 'STAFF';
  const isAgent = user?.role === 'AGENT';

  return (
    <div className="space-y-4">
      <section>
        <h1 className="page-title">余额与认款</h1>
        <p className="page-sub">
          {isAgent
            ? '查看预存余额、上传付款凭证提交认款，财务核实到账后自动加进余额。'
            : '审核代理认款申请，确认到账后自动加入代理预存余额；支持线下对账手动修正。'}
        </p>
      </section>

      {isAgent && <AgentSelfView token={token} />}
      {isStaff && <StaffReviewView token={token} />}
      {!isAgent && !isStaff && (
        <div className="card text-ink-muted">无权限访问此页面。</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// AGENT 自己的视图：余额 + 应付款渠道 + 认款表单 + 自己的申请列表
// ═══════════════════════════════════════════════════════════════
function AgentSelfView({ token }: { token: string }) {
  const currentUserId = useAuth((s) => s.user?.id);
  const [agent, setAgent] = useState<{ prepaymentBalance: string } | null>(null);
  const [channels, setChannels] = useState<{ channels: PaymentChannel[]; source: 'DEDICATED' | 'COMPANY' } | null>(null);
  const [requests, setRequests] = useState<AgentRechargeRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const [agentsRes, channelsRes, reqRes] = await Promise.all([
        api.listAgents(token),
        agentRechargeApi.myPaymentChannels(token),
        agentRechargeApi.listAgentRecharges(token, { pageSize: 50 }),
      ]);
      // listAgents 对 AGENT 角色只返回自己 + 所有后代；按 userId 精确匹配出自己那条记录取余额
      const self = agentsRes.agents.find((a) => a.userId === currentUserId);
      if (self) setAgent({ prepaymentBalance: self.prepaymentBalance });
      setChannels(channelsRes);
      setRequests(reqRes.requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [token, currentUserId]);

  useEffect(() => { reload(); }, [reload]);

  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-2">
        <div className="stat-card">
          <p className="stat-label">当前预存余额</p>
          <p className="stat-value">{agent ? `¥${fmtCny(agent.prepaymentBalance)}` : '—'}</p>
          <p className="mt-0.5 text-xs text-ink-muted">用于订单尾款抵扣；余额不足需先认款</p>
        </div>
        <ChannelCard channels={channels} />
      </section>

      <RechargeForm token={token} onSubmitted={reload} />

      <RequestList title="我的认款记录" requests={requests} />
    </div>
  );
}

function ChannelCard({ channels }: { channels: { channels: PaymentChannel[]; source: 'DEDICATED' | 'COMPANY' } | null }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">收款码</h2>
        {channels && (
          <span className="badge-neutral">
            {channels.source === 'DEDICATED' ? '专属收款码' : '公司统一码'}
          </span>
        )}
      </div>
      {!channels && <p className="mt-2 text-xs text-ink-muted">加载中…</p>}
      {channels && channels.channels.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">暂未配置收款渠道，请联系财务</p>
      )}
      {channels && channels.channels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {channels.channels.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2">
              {c.qrImageUrl ? (
                <img src={c.qrImageUrl} alt={`${c.label} 收款码`} className="h-16 w-16 rounded object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded bg-slate-100 text-[10px] text-ink-muted">
                  无图片
                </div>
              )}
              <div className="text-xs">
                <div className="font-medium text-ink">{PAYMENT_CHANNEL_KIND_LABEL[c.kind as PaymentChannelKind] ?? c.kind}</div>
                <div className="text-ink-soft">{c.label}</div>
                {c.accountText && <div className="mt-0.5 max-w-[180px] text-ink-muted">{c.accountText}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RechargeForm({ token, onSubmitted }: { token: string; onSubmitted: () => void | Promise<void> }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [proofImages, setProofImages] = useState<string[]>([]);
  const [compressing, setCompressing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []).slice(0, MAX_PROOF_COUNT - proofImages.length);
    e.target.value = '';
    if (files.length === 0) return;
    setErr(null);
    setCompressing(true);
    try {
      const compressed: string[] = [];
      for (const f of files) {
        compressed.push(await fileToProofDataUrl(f));
      }
      setProofImages((prev) => [...prev, ...compressed].slice(0, MAX_PROOF_COUNT));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '图片处理失败');
    } finally {
      setCompressing(false);
    }
  }

  function removeImage(idx: number): void {
    setProofImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit(): Promise<void> {
    if (!token || submitting) return;
    if (!amount || amount <= 0) { setErr('请填写申报金额'); return; }
    if (proofImages.length === 0) { setErr('请至少上传 1 张付款凭证'); return; }
    setErr(null);
    setOk(false);
    setSubmitting(true);
    try {
      await agentRechargeApi.createAgentRecharge(token, {
        amountCny: amount,
        note: note.trim() || undefined,
        proofImages,
      });
      setAmount(null);
      setNote('');
      setProofImages([]);
      setOk(true);
      await onSubmitted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card space-y-3">
      <h2 className="text-sm font-semibold text-ink">提交认款申请</h2>
      <p className="text-xs text-ink-muted">付款后在此申报金额并上传凭证，财务核实到账后自动加入余额。</p>

      {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {ok && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">提交成功，等待财务审核</div>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">申报金额（¥）</span>
          <NumberInput className="input nums" value={amount} onChange={setAmount} min={0} placeholder="0.00" />
        </label>
        <label className="block">
          <span className="label">备注（选填）</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="如：两笔货款合并" />
        </label>
      </div>

      <div>
        <span className="label">付款凭证（1-3 张）</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {proofImages.map((img, idx) => (
            <div key={idx} className="relative">
              <img src={img} alt={`凭证 ${idx + 1}`} className="h-16 w-16 rounded border border-slate-300 object-cover" />
              <button
                type="button"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-xs text-white"
                onClick={() => removeImage(idx)}
              >
                ×
              </button>
            </div>
          ))}
          {proofImages.length < MAX_PROOF_COUNT && (
            <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-slate-300 text-xs text-ink-soft hover:bg-slate-50">
              {compressing ? '处理中…' : '+ 上传'}
              <input type="file" accept="image/*" multiple className="hidden" onChange={onFiles} disabled={compressing} />
            </label>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn-primary disabled:opacity-50" onClick={submit} disabled={submitting || compressing}>
          {submitting ? '提交中…' : '提交认款申请'}
        </button>
      </div>
    </section>
  );
}

function RequestList({ title, requests, showAgentName = false }: { title: string; requests: AgentRechargeRequest[] | null; showAgentName?: boolean }) {
  return (
    <section className="card p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              {showAgentName && <th className="text-left">代理</th>}
              <th className="text-left">申报金额</th>
              <th className="text-left">到账金额</th>
              <th className="text-left">备注</th>
              <th className="text-left">凭证</th>
              <th className="text-center">状态</th>
              <th className="text-left">审核备注</th>
              <th className="text-left">提交时间</th>
            </tr>
          </thead>
          <tbody>
            {requests === null && (
              <tr><td colSpan={showAgentName ? 8 : 7} className="py-6 text-center text-sm text-ink-muted">加载中…</td></tr>
            )}
            {requests && requests.length === 0 && (
              <tr><td colSpan={showAgentName ? 8 : 7} className="py-6 text-center text-sm text-ink-muted">暂无记录</td></tr>
            )}
            {requests?.map((r) => (
              <tr key={r.id}>
                {showAgentName && <td className="font-medium text-ink">{r.agentName ?? r.agentId}</td>}
                <td className="nums">¥{fmtCny(r.amountCny)}</td>
                <td className="nums">{r.confirmedAmountCny ? `¥${fmtCny(r.confirmedAmountCny)}` : '—'}</td>
                <td className="max-w-[160px] truncate text-ink-soft" title={r.note ?? ''}>{r.note || '—'}</td>
                <td>
                  <div className="flex gap-1">
                    {r.proofImages.map((img, i) => (
                      <a key={i} href={img} target="_blank" rel="noreferrer">
                        <img src={img} alt={`凭证 ${i + 1}`} className="h-8 w-8 rounded border border-slate-200 object-cover" />
                      </a>
                    ))}
                  </div>
                </td>
                <td className="text-center">
                  <span className={STATUS_BADGE[r.status]}>{AGENT_RECHARGE_STATUS_LABEL[r.status]}</span>
                </td>
                <td className="max-w-[160px] truncate text-ink-soft" title={r.reviewNote ?? ''}>{r.reviewNote || '—'}</td>
                <td className="text-xs text-ink-muted">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// ADMIN/STAFF 视图：待审核队列 + 已处理列表 + 手动调整
// ═══════════════════════════════════════════════════════════════
function StaffReviewView({ token }: { token: string }) {
  const [pending, setPending] = useState<AgentRechargeRequest[] | null>(null);
  const [processed, setProcessed] = useState<AgentRechargeRequest[] | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const [pendingRes, allRes, agentsRes] = await Promise.all([
        agentRechargeApi.listAgentRecharges(token, { status: 'PENDING', pageSize: 100 }),
        agentRechargeApi.listAgentRecharges(token, { pageSize: 50 }),
        api.listAgents(token),
      ]);
      setPending(pendingRes.requests);
      setProcessed(allRes.requests.filter((r) => r.status !== 'PENDING'));
      setAgents(agentsRes.agents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败');
    }
  }, [token]);

  useEffect(() => { reload(); }, [reload]);

  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;

  return (
    <div className="space-y-4">
      <PendingQueue requests={pending} token={token} onChanged={reload} />
      <RequestList title="最近已处理" requests={processed} showAgentName />
      <ManualAdjustForm token={token} agents={agents} onAdjusted={reload} />
    </div>
  );
}

function PendingQueue({ requests, token, onChanged }: { requests: AgentRechargeRequest[] | null; token: string; onChanged: () => void | Promise<void> }) {
  return (
    <section className="card p-0">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">待审核认款</h2>
        {requests && <span className="badge-warning">{requests.length} 条待处理</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th className="text-left">代理</th>
              <th className="text-left">申报金额</th>
              <th className="text-left">备注</th>
              <th className="text-left">凭证</th>
              <th className="text-left">提交时间</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {requests === null && (
              <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-muted">加载中…</td></tr>
            )}
            {requests && requests.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-muted">暂无待审核申请</td></tr>
            )}
            {requests?.map((r) => (
              <PendingRow key={r.id} request={r} token={token} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PendingRow({ request, token, onChanged }: { request: AgentRechargeRequest; token: string; onChanged: () => void | Promise<void> }) {
  const [action, setAction] = useState<'none' | 'confirm' | 'reject'>('none');
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(Number(request.amountCny));
  const [reviewNote, setReviewNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doConfirm(): Promise<void> {
    if (!token || submitting) return;
    setErr(null);
    setSubmitting(true);
    try {
      await agentRechargeApi.confirmAgentRecharge(token, request.id, {
        confirmedAmountCny: confirmedAmount ?? undefined,
        reviewNote: reviewNote.trim() || undefined,
      });
      setAction('none');
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '确认失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function doReject(): Promise<void> {
    if (!token || submitting) return;
    if (!reviewNote.trim()) { setErr('请填写驳回原因'); return; }
    setErr(null);
    setSubmitting(true);
    try {
      await agentRechargeApi.rejectAgentRecharge(token, request.id, { reviewNote: reviewNote.trim() });
      setAction('none');
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '驳回失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <tr>
        <td className="font-medium text-ink">{request.agentName ?? request.agentId}</td>
        <td className="nums">¥{fmtCny(request.amountCny)}</td>
        <td className="max-w-[160px] truncate text-ink-soft" title={request.note ?? ''}>{request.note || '—'}</td>
        <td>
          <div className="flex gap-1">
            {request.proofImages.map((img, i) => (
              <a key={i} href={img} target="_blank" rel="noreferrer">
                <img src={img} alt={`凭证 ${i + 1}`} className="h-8 w-8 rounded border border-slate-200 object-cover" />
              </a>
            ))}
          </div>
        </td>
        <td className="text-xs text-ink-muted">{new Date(request.createdAt).toLocaleString('zh-CN')}</td>
        <td className="text-right">
          <div className="flex justify-end gap-1.5 text-xs font-medium">
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setAction(action === 'confirm' ? 'none' : 'confirm')}>确认</button>
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50" onClick={() => setAction(action === 'reject' ? 'none' : 'reject')}>驳回</button>
          </div>
        </td>
      </tr>
      {action !== 'none' && (
        <tr>
          <td colSpan={6} className="bg-slate-50 px-4 py-3">
            {err && <div className="mb-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
            {action === 'confirm' && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="label text-xs">到账金额（¥，默认按申报）</span>
                  <NumberInput className="input nums w-32" value={confirmedAmount} onChange={setConfirmedAmount} min={0} />
                </label>
                <label className="block flex-1 min-w-[160px]">
                  <span className="label text-xs">核实备注（选填）</span>
                  <input className="input" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} maxLength={500} />
                </label>
                <button type="button" className="btn-primary text-sm disabled:opacity-50" onClick={doConfirm} disabled={submitting}>
                  {submitting ? '确认中…' : '确认到账'}
                </button>
                <button type="button" className="btn-secondary text-sm" onClick={() => setAction('none')} disabled={submitting}>取消</button>
              </div>
            )}
            {action === 'reject' && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="block flex-1 min-w-[200px]">
                  <span className="label text-xs">驳回原因 *</span>
                  <input className="input" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} maxLength={500} placeholder="必填" />
                </label>
                <button type="button" className="btn-danger text-sm disabled:opacity-50" onClick={doReject} disabled={submitting}>
                  {submitting ? '驳回中…' : '确认驳回'}
                </button>
                <button type="button" className="btn-secondary text-sm" onClick={() => setAction('none')} disabled={submitting}>取消</button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ManualAdjustForm({ token, agents, onAdjusted }: { token: string; agents: AgentListItem[]; onAdjusted: () => void | Promise<void> }) {
  const [agentId, setAgentId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!token || submitting) return;
    if (!agentId) { setErr('请选择代理'); return; }
    if (!amount) { setErr('请填写调整金额（正数加/负数扣）'); return; }
    if (!reason.trim()) { setErr('请填写调整原因'); return; }
    setErr(null);
    setOk(null);
    setSubmitting(true);
    try {
      const result = await agentRechargeApi.manualAdjustAgentBalance(token, { agentId, amount, reason: reason.trim() });
      setOk(`调整成功，最新余额 ¥${fmtCny(result.balanceAfter)}`);
      setAmount(null);
      setReason('');
      await onAdjusted();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '调整失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card space-y-3">
      <h2 className="text-sm font-semibold text-ink">手动调整余额</h2>
      <p className="text-xs text-ink-muted">线下对账差异修正用；正数=加余额，负数=扣余额（扣减后不能为负）。每次调整都会写入审计日志。</p>

      {err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {ok && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">代理</span>
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">选择代理</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.companyName || a.contactName}（¥{fmtCny(a.prepaymentBalance)}）</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">调整金额（¥，可负数）</span>
          <NumberInput className="input nums" value={amount} onChange={setAmount} allowNegative placeholder="正数加 / 负数扣" />
        </label>
        <label className="block">
          <span className="label">调整原因 *</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="如：线下对账差异" />
        </label>
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn-primary disabled:opacity-50" onClick={submit} disabled={submitting}>
          {submitting ? '提交中…' : '提交调整'}
        </button>
      </div>
    </section>
  );
}
