import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AgentListItem, type CreateChildAgentInput } from '../lib/api';
import { useAuth } from '../stores/auth';

const TIER_LABEL = ['', '1级代理（总代）', '2级代理（区代）', '3级代理（门店）', '4级代理', '5级代理'];

export function TeamPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [parentForAdmin, setParentForAdmin] = useState<string>('');

  const reload = useCallback(async () => {
    if (!tokens) return;
    try {
      const res = await api.listAgents(tokens.accessToken);
      setAgents(res.agents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载代理列表失败');
    }
  }, [tokens]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 把代理组织成树
  const tree = useMemo(() => buildTree(agents ?? []), [agents]);

  if (error) {
    return <div className="card border-deal/30 bg-deal-light font-medium text-deal-dark">{error}</div>;
  }
  if (!agents) {
    return <div className="card text-ink-muted">加载中…</div>;
  }

  const title = isAdmin ? '代理管理' : '我的团队';
  const subtitle = isAdmin
    ? '查看并管理全部代理；可任选任意代理创建下级，或创建一个全新的 1 级代理。'
    : '查看您和您发展的所有下级代理。可直接为您自己创建下级账号。';

  return (
    <div className="space-y-5">
      <section className="card animate-fade-up">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
            <p className="section-sub">{subtitle}</p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setParentForAdmin('');
              setShowForm(true);
            }}
          >
            + 创建下级代理
          </button>
        </div>
      </section>

      {showForm && (
        <CreateAgentForm
          onCancel={() => setShowForm(false)}
          onCreated={async () => {
            setShowForm(false);
            await reload();
          }}
          agents={agents}
          isAdmin={isAdmin}
          initialParentId={parentForAdmin}
        />
      )}

      <section>
        {tree.length === 0 ? (
          <div className="card text-ink-muted">暂无代理。</div>
        ) : (
          <ul className="space-y-3">
            {tree.map((node) => (
              <AgentNode
                key={node.id}
                node={node}
                depth={0}
                onAddChild={(parentId) => {
                  setParentForAdmin(parentId);
                  setShowForm(true);
                }}
                canAddChildOf={(agent) => {
                  if (isAdmin) return agent.tier < 5;
                  // AGENT 只能为自己加下级
                  return agent.userId === user?.id && agent.tier < 5;
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── 树形结构 ───────────────────────────────────────────────────────────────

interface AgentNodeData extends AgentListItem {
  children: AgentNodeData[];
}

function buildTree(flat: AgentListItem[]): AgentNodeData[] {
  const byId = new Map<string, AgentNodeData>();
  flat.forEach((a) => byId.set(a.id, { ...a, children: [] }));
  const roots: AgentNodeData[] = [];
  byId.forEach((node) => {
    if (node.parentAgentId && byId.has(node.parentAgentId)) {
      byId.get(node.parentAgentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function AgentNode({
  node,
  depth,
  onAddChild,
  canAddChildOf,
}: {
  node: AgentNodeData;
  depth: number;
  onAddChild: (parentId: string) => void;
  canAddChildOf: (a: AgentListItem) => boolean;
}) {
  return (
    <li>
      <div
        className="card-interactive flex flex-wrap items-start justify-between gap-4 p-4 md:p-5"
        style={{ marginLeft: depth * 24 }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge-soft">
              {TIER_LABEL[node.tier] ?? `${node.tier}级`}
            </span>
            <h3 className="text-lg font-bold text-ink">
              {node.companyName || node.contactName}
            </h3>
            {!node.isActive && (
              <span className="badge-outline">已停用</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-ink-soft">
            <span>联系人：{node.contactName}</span>
            <span>电话：{node.contactPhone}</span>
            <span>邮箱：{node.email ?? '—'}</span>
          </div>
          <div className="mt-1.5 text-xs text-ink-muted">
            下级 <span className="font-medium text-ink-soft nums">{node.childCount}</span> 个 · 订单 <span className="font-medium text-ink-soft nums">{node.orderCount}</span> 笔 · 预付余额 <span className="font-medium text-brand-700 nums">¥{Number(node.prepaymentBalance).toFixed(2)}</span>
            {node.parent && (
              <> · 上级：{node.parent.companyName ?? node.parent.contactName}（{TIER_LABEL[node.parent.tier] ?? ''}）</>
            )}
          </div>
        </div>
        {canAddChildOf(node) && (
          <button type="button" className="btn-secondary text-sm" onClick={() => onAddChild(node.id)}>
            + 添加下级
          </button>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((c) => (
            <AgentNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onAddChild={onAddChild}
              canAddChildOf={canAddChildOf}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ── 创建表单 ─────────────────────────────────────────────────────────────

function CreateAgentForm({
  onCancel,
  onCreated,
  agents,
  isAdmin,
  initialParentId,
}: {
  onCancel: () => void;
  onCreated: () => void;
  agents: AgentListItem[];
  isAdmin: boolean;
  initialParentId?: string;
}) {
  const tokens = useAuth((s) => s.tokens);

  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [form, setForm] = useState<CreateChildAgentInput>({
    email: '',
    password: '',
    displayName: '',
    contactName: '',
    contactPhone: '',
    companyName: '',
    prepaymentBalance: 0,
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parentOptions = useMemo(() => {
    return agents.filter((a) => a.isActive && a.tier < 5);
  }, [agents]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    setSubmitting(true);
    setErr(null);
    try {
      await api.createChildAgent(tokens.accessToken, form, parentId || undefined);
      onCreated();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card animate-fade-up border-brand/30 ring-1 ring-brand/10">
      <div className="flex items-center justify-between">
        <h2 className="section-title text-base">新建下级代理</h2>
        <button type="button" className="text-sm font-medium text-ink-muted transition hover:text-ink" onClick={onCancel}>
          取消
        </button>
      </div>

      <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={onSubmit}>
        {isAdmin && (
          <div className="md:col-span-2">
            <label className="label" htmlFor="parent">上级代理</label>
            <select
              id="parent"
              className="input"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">（不选 = 创建 1 级代理）</option>
              {parentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  [{a.tier}级] {a.companyName || a.contactName} — {a.email}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">
              选择上级后，新代理 tier = 上级 tier + 1；不选则创建一个顶层 1 级代理。
            </p>
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">登录邮箱 *</label>
          <input
            id="email"
            type="email"
            required
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">初始密码 *（≥8 位）</label>
          <input
            id="password"
            type="text"
            required
            minLength={8}
            className="input"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="displayName">显示昵称 *</label>
          <input
            id="displayName"
            required
            className="input"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="companyName">公司名</label>
          <input
            id="companyName"
            className="input"
            value={form.companyName ?? ''}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="contactName">联系人 *</label>
          <input
            id="contactName"
            required
            className="input"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="contactPhone">联系电话 *</label>
          <input
            id="contactPhone"
            required
            className="input"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
          />
        </div>
        <div>
          <label className="label" htmlFor="prepaymentBalance">初始预付余额（CNY）</label>
          <input
            id="prepaymentBalance"
            type="number"
            min={0}
            step={0.01}
            className="input"
            value={form.prepaymentBalance ?? 0}
            onChange={(e) => setForm({ ...form, prepaymentBalance: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="md:col-span-2">
          <label className="label" htmlFor="notes">备注</label>
          <textarea
            id="notes"
            className="input"
            rows={2}
            value={form.notes ?? ''}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>

        {err && (
          <div className="md:col-span-2 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark">{err}</div>
        )}

        <div className="md:col-span-2 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? '创建中…' : '创建代理'}
          </button>
        </div>
      </form>
    </section>
  );
}
