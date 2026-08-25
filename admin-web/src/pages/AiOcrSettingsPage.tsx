/**
 * AI 识别设置（ADMIN only）
 *
 * 配置护照 OCR 所用的 AI 引擎（当前支持阿里云 DashScope Qwen-VL 系列）。
 * 字段：API Key、接口地址 baseUrl、模型 ID、启用开关。
 * 操作：「保存」调 PUT /settings/ai-ocr；「测试连接」调 POST /settings/ai-ocr/test。
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type AiOcrConfig, type AiOcrConfigInput } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';

export function AiOcrSettingsPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [config, setConfig] = useState<AiOcrConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // 表单字段
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);

  // 操作状态
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 加载当前配置
  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setLoadErr(null);
    api.getAiOcrConfig(token)
      .then((c) => {
        setConfig(c);
        setBaseUrl(c.baseUrl ?? '');
        setModel(c.model ?? '');
        setEnabled(c.enabled);
      })
      .catch((err: unknown) => {
        setLoadErr(err instanceof ApiError ? err.message : '加载配置失败');
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSave() {
    if (!token || saving) return;
    setSaving(true);
    setSaveMsg(null);
    setTestMsg(null);

    const body: AiOcrConfigInput = { enabled };
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    if (model.trim()) body.model = model.trim();

    try {
      const updated = await api.updateAiOcrConfig(token, body);
      setConfig(updated);
      setBaseUrl(updated.baseUrl ?? '');
      setModel(updated.model ?? '');
      setEnabled(updated.enabled);
      setApiKey(''); // 保存后清除明文输入框
      setSaveMsg({ type: 'ok', text: '保存成功' });
    } catch (err: unknown) {
      setSaveMsg({ type: 'err', text: err instanceof ApiError ? err.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!token || testing) return;
    setTesting(true);
    setTestMsg(null);
    setSaveMsg(null);

    try {
      const res = await api.testAiOcrConfig(token);
      setTestMsg({ ok: res.ok, text: res.message });
    } catch (err: unknown) {
      setTestMsg({ ok: false, text: err instanceof ApiError ? err.message : '测试请求失败' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-ink-muted">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        加载中…
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
        {loadErr}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div>
        <h1 className="text-xl font-semibold text-ink">AI 识别设置</h1>
        <p className="mt-1 text-sm text-ink-muted">
          配置护照 OCR 所用的 AI 引擎。当前支持阿里云 DashScope Qwen-VL 系列；未配置或停用时，录单护照识别不可用（点击识别会直接提示错误）。
        </p>
      </div>

      <div className="max-w-xl rounded-lg border border-slate-200 bg-surface p-6 shadow-sm">
        {/* 当前状态摘要 */}
        <div className="mb-5 flex items-center gap-3 rounded-md border border-slate-200 bg-canvas px-4 py-3 text-sm">
          <span className="font-medium text-ink">当前状态：</span>
          {config?.apiKeySet ? (
            <span className="text-emerald-600">
              已配置 API Key
              {config.apiKeyMasked ? (
                <span className="ml-1 font-mono text-xs text-ink-muted">（{config.apiKeyMasked}）</span>
              ) : null}
            </span>
          ) : (
            <span className="text-amber-600">未配置 API Key（护照识别不可用）</span>
          )}
          <span
            className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${
              config?.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
            }`}
          >
            {config?.enabled ? '已启用' : '已停用'}
          </span>
        </div>

        <div className="space-y-4">
          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-ink">
              API Key
              <span className="ml-1 text-xs font-normal text-ink-muted">（留空则保留现有 Key）</span>
            </label>
            <input
              type="password"
              autoComplete="new-password"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder={
                config?.apiKeySet
                  ? '●●●●●●●●（已设置，留空保留）'
                  : '粘贴 DashScope API Key（sk-...）'
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {/* 接口地址 */}
          <div>
            <label className="block text-sm font-medium text-ink">
              接口地址 Base URL
              <span className="ml-1 text-xs font-normal text-ink-muted">（留空保留当前值；国际版 sk-ws- 密钥须配国际版地址）</span>
            </label>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* 模型 ID */}
          <div>
            <label className="block text-sm font-medium text-ink">模型 ID</label>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              placeholder="qwen3-vl-plus"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-muted">
              填 DashScope 里的确切模型 ID，例如{' '}
              <code className="rounded bg-slate-100 px-1">qwen3-vl-plus</code>
              、<code className="rounded bg-slate-100 px-1">qwen-vl-max-latest</code>
            </p>
          </div>

          {/* 启用开关 */}
          <div className="flex items-center justify-between rounded-md border border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-ink">启用 AI 识别</p>
              <p className="text-xs text-ink-muted">关闭后录单护照识别不可用，点击识别会直接提示错误</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                enabled ? 'bg-brand' : 'bg-slate-300'
              }`}
              onClick={() => setEnabled((v) => !v)}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary text-sm disabled:opacity-50"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="btn-secondary text-sm disabled:opacity-50"
            disabled={testing || !config?.apiKeySet}
            title={!config?.apiKeySet ? '请先保存 API Key 后再测试' : undefined}
            onClick={() => void handleTest()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>

        {/* 保存结果 */}
        {saveMsg && (
          <div
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              saveMsg.type === 'ok'
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            <Icon name={saveMsg.type === 'ok' ? 'check' : 'close'} className="mr-1 inline-block align-text-bottom" />
            {saveMsg.text}
          </div>
        )}

        {/* 测试结果 */}
        {testMsg && (
          <div
            className={`mt-3 rounded-md px-3 py-2 text-sm ${
              testMsg.ok
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            <Icon name={testMsg.ok ? 'check' : 'alert'} className="mr-1 inline-block align-text-bottom" />
            {testMsg.text}
          </div>
        )}
      </div>

      {/* 说明卡片 */}
      <div className="max-w-xl rounded-md border border-slate-200 bg-canvas p-4 text-xs text-ink-muted space-y-1.5">
        <p className="font-medium text-ink-soft">使用说明</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            API Key 来自阿里云 DashScope 控制台，格式为 <code>sk-...</code>；Key 保存后只显示脱敏形式，不可反查明文。
          </li>
          <li>
            模型 ID 须与 DashScope 中的确切名称一致（区分大小写），默认{' '}
            <code>qwen3-vl-plus</code>。
          </li>
          <li>
            「测试连接」发一张纯白 1×1 像素图到 AI 接口，验证 Key 与模型是否有效，消耗极少 token。
          </li>
          <li>
            停用 AI 识别后，录单界面点击识别会直接提示「AI 识别未配置」，不再有本地识别兜底——护照信息需手工录入。
          </li>
        </ul>
      </div>
    </div>
  );
}
