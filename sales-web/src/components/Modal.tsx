import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * 无障碍弹层（对标 Klook/携程 详情/画廊弹窗）。
 * - role="dialog" + aria-modal，焦点陷阱（Tab 循环），Esc 关闭，点遮罩关闭
 * - 打开时锁 body 滚动，关闭后把焦点还给打开它的元素
 * - 尊重 prefers-reduced-motion（无障碍：减少动效时不做淡入/缩放）
 * 纯展示：数据走 props，关闭走 onClose 回调，不引 api / 不做路由跳转。
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'full';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: ModalSize;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  full: 'max-w-[min(96vw,72rem)]',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // 记住打开前的焦点元素，关闭后归还
  useEffect(() => {
    if (open) {
      openerRef.current = (document.activeElement as HTMLElement) ?? null;
    } else if (openerRef.current) {
      openerRef.current.focus?.();
      openerRef.current = null;
    }
  }, [open]);

  // 锁 body 滚动
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // 打开后把初始焦点移进面板
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4 motion-safe:animate-fade-in"
      onKeyDown={onKeyDown}
    >
      {/* 遮罩 */}
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 cursor-default bg-ink/55 backdrop-blur-sm"
        onClick={onClose}
        tabIndex={-1}
      />
      {/* 面板 */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '对话框'}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-t-3xl bg-surface shadow-pop outline-none motion-safe:animate-fade-up sm:rounded-3xl`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200/80 px-5 py-3.5">
          <h2 className="section-title truncate text-base md:text-lg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="btn-ghost -mr-1.5 h-9 w-9 shrink-0 rounded-full p-0"
          >
            <Icon name="arrowRight" className="h-5 w-5 rotate-180" />
            <span className="sr-only">关闭</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
