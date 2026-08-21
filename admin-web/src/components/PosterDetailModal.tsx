import { useEffect, useRef, useState } from 'react';
import { type MarketingPosterDetail, type MarketingRenderReport } from '../lib/api';

interface PosterDetailModalProps {
  detail: MarketingPosterDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}

type PosterCopyKind = 'moments' | 'agent' | 'xhs';

type PosterRenderReport = MarketingRenderReport;

function isPosterRenderReport(value: unknown): value is PosterRenderReport {
  return typeof value === 'object' && value !== null && (
    'renderedValues' in value || 'copyRejected' in value || 'error' in value
  );
}

function copyRejectionReason(report: PosterRenderReport | null, kind: PosterCopyKind): string | null {
  const rejection = report?.copyRejected?.find((item) => item.kind === kind);
  return rejection?.reason ?? null;
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 剪贴板权限不可用时走兼容分支。
    }
  }

  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function CopyBlock({
  label,
  value,
  copied,
  disabled,
  disabledReason,
  rejectionReason,
  onCopy,
}: {
  label: string;
  value: string | null;
  copied: boolean;
  disabled: boolean;
  disabledReason: string | null;
  rejectionReason: string | null;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={disabled || !value} title={disabledReason ?? undefined} onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{value || '暂无文案'}</p>
      {disabled && disabledReason && (
        <p className="mt-2 text-xs leading-5 text-amber-800">{disabledReason}</p>
      )}
      {!value && rejectionReason && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-800">
          该段文案未采用：{rejectionReason}
        </p>
      )}
    </div>
  );
}

const FOCUSABLE_SELECTOR = ['button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', 'summary', 'a[href]', '[tabindex]:not([tabindex="-1"])'].join(',');

export function PosterDetailModal({
  detail,
  loading,
  error,
  onClose,
  returnFocusRef,
}: PosterDetailModalProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<{ label: string; value: string } | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setCopiedKey(null);
    setCopyFailure(null);
    setReviewConfirmed(false);
    if (copyTimerRef.current !== null) { window.clearTimeout(copyTimerRef.current); copyTimerRef.current = null; }
  }, [detail?.id]);

  useEffect(() => {
    const active = document.activeElement;
    initialFocusRef.current = active instanceof HTMLElement ? active : null;
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
      const target = returnFocusRef?.current ?? initialFocusRef.current;
      if (target && document.contains(target)) target.focus();
    };
  }, []);

  function handleClose(): void {
    if (copyTimerRef.current !== null) { window.clearTimeout(copyTimerRef.current); copyTimerRef.current = null; }
    onCloseRef.current();
  }

  async function handleCopy(key: string, label: string, value: string | null): Promise<void> {
    if (!value || !detail || !reviewConfirmed) return;
    const copied = await copyText(value);
    if (!copied) {
      setCopiedKey(null);
      setCopyFailure({ label, value });
      return;
    }
    setCopyFailure(null);
    setCopiedKey(key);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
      copyTimerRef.current = null;
    }, 1600);
  }

  function downloadPng(): void {
    if (!detail?.imageDataUrl || !reviewConfirmed) return;
    const link = document.createElement('a');
    link.href = detail.imageDataUrl;
    const safeTitle = detail.title.replace(/[\\/:*?"<>|]/gu, '_').trim() || '海报';
    link.download = `${safeTitle}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const reportValue: unknown = detail?.verifyReport ?? null;
  const renderReport = isPosterRenderReport(reportValue) ? reportValue : null;
  const renderedValues = renderReport?.renderedValues ?? {};
  const truncatedLabels: Record<string, string> = {
    title: '海报标题',
    effectiveFrom: '生效日期',
    baggage: '行李额',
    extraNote: '补充说明',
    'outbound.route': '去程航线',
    'inbound.route': '回程航线',
  };
  const truncated = (renderReport?.truncated ?? []).map((key) => truncatedLabels[key] ?? key);
  const sourceRows = detail
    ? [
        { key: 'title', label: '海报标题', value: renderedValues.title ?? detail.title },
        ...detail.facts.map((fact) => ({ key: fact.key, label: fact.label, value: fact.value })),
        ...(renderedValues.extraNote ? [{ key: 'extraNote', label: '补充说明', value: renderedValues.extraNote }] : []),
      ]
    : [];
  const disabledReason = loading
    ? '详情加载中，请稍候'
    : !detail
      ? '暂无详情可分发'
        : !detail.imageDataUrl
          ? `未生成图片，无法下载 PNG${renderReport?.error ? `：${renderReport.error}` : ''}`
          : !reviewConfirmed
            ? '请先勾选“我已逐项核对，确认海报内容无误”'
            : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={handleClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="poster-detail-title"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="min-w-0">
            <h2 id="poster-detail-title" className="truncate text-base font-semibold text-ink">
              {detail?.title ?? '海报详情'}
            </h2>
            {detail && <p className="mt-0.5 text-xs text-ink-muted">版式：{detail.templateKey}</p>}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-ghost px-2 py-1 text-lg"
            onClick={handleClose}
            aria-label="关闭详情"
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center p-6 text-sm text-ink-soft">
            正在加载海报详情…
          </div>
        ) : error ? (
          <div className="m-5 rounded-lg border-2 border-rose-300 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
            {error}
          </div>
        ) : detail ? (
          <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
            <section className="flex min-h-64 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4">
              {detail.imageDataUrl ? (
                <img
                  src={detail.imageDataUrl}
                  alt={detail.title}
                  className="max-h-[68vh] max-w-full object-contain"
                />
              ) : (
                <p className="text-sm text-ink-muted">未生成图片</p>
              )}
            </section>

            <section className="min-w-0 space-y-5">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink">数据来源</h3>
                {detail.status === 'FAILED' ? (
                  <div className="rounded-lg border-2 border-rose-200 bg-rose-50 px-3 py-2.5 text-sm leading-6 text-rose-800">
                    <span className="font-medium">生成失败：</span>{renderReport?.error ?? '未生成图片，请重试。'}
                  </div>
                ) : (
                  <div className="rounded-lg border-2 border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-6 text-amber-900">
                    海报文字由 AI 渲染，发布前请对照右侧数据核对航班号与时刻。
                  </div>
                )}
                {detail.status !== 'FAILED' && truncated.length > 0 && (
                  <div className="mt-2 rounded-lg border-2 border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-6 text-amber-800">
                    以下内容过长已被截断：{truncated.join('、')}
                  </div>
                )}
                <div className="mt-3 space-y-2">
                  {sourceRows.map((row) => (
                    <div key={row.key} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs text-ink-muted">{row.label}</div>
                      <div className="mt-0.5 break-words text-sm font-medium text-ink">{row.value}</div>
                    </div>
                  ))}
                </div>
                {detail.status !== 'FAILED' && detail.imageDataUrl && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border-2 border-brand-200 bg-brand-50 px-3 py-2.5 text-sm leading-6 text-brand-900">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={reviewConfirmed}
                      onChange={(event) => setReviewConfirmed(event.target.checked)}
                    />
                    <span>我已逐项核对，确认海报内容无误</span>
                  </label>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink">配套文案</h3>
                <div className="space-y-2">
                  <CopyBlock
                    label="朋友圈"
                    value={detail.copyMoments}
                    copied={copiedKey === 'moments'}
                    disabled={loading || !reviewConfirmed || !detail.imageDataUrl}
                    disabledReason={disabledReason}
                    rejectionReason={copyRejectionReason(renderReport, 'moments')}
                    onCopy={() => void handleCopy('moments', '朋友圈', detail.copyMoments)}
                  />
                  <CopyBlock
                    label="代理群"
                    value={detail.copyAgent}
                    copied={copiedKey === 'agent'}
                    disabled={loading || !reviewConfirmed || !detail.imageDataUrl}
                    disabledReason={disabledReason}
                    rejectionReason={copyRejectionReason(renderReport, 'agent')}
                    onCopy={() => void handleCopy('agent', '代理群', detail.copyAgent)}
                  />
                  <CopyBlock
                    label="小红书"
                    value={detail.copyXhs}
                    copied={copiedKey === 'xhs'}
                    disabled={loading || !reviewConfirmed || !detail.imageDataUrl}
                    disabledReason={disabledReason}
                    rejectionReason={copyRejectionReason(renderReport, 'xhs')}
                    onCopy={() => void handleCopy('xhs', '小红书', detail.copyXhs)}
                  />
                </div>
                {copyFailure && (
                  <div className="mt-2 rounded-lg border-2 border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
                    <p className="font-medium">复制「{copyFailure.label}」失败，请手动复制下方文本：</p>
                    <textarea
                      readOnly
                      className="input mt-2 min-h-24 resize-y bg-white text-ink"
                      value={copyFailure.value}
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                      aria-label={`${copyFailure.label}手动复制文本`}
                    />
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : null}

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          {disabledReason && (
            <span className="mr-auto text-xs font-medium text-amber-800">{disabledReason}</span>
          )}
          <button type="button" className="btn-secondary" onClick={handleClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!detail?.imageDataUrl || loading || !reviewConfirmed}
            title={disabledReason ?? undefined}
            onClick={downloadPng}
          >
            下载 PNG
          </button>
        </footer>
      </div>
    </div>
  );
}
