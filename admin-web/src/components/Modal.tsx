import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import { Icon } from './Icon';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
}

type ModalStackEntry = {
  onCloseRef: MutableRefObject<() => void>;
  nodeRef: RefObject<HTMLElement>;
};

const modalStack: ModalStackEntry[] = [];
let scrollLockCount = 0;
let previousBodyOverflow: string | null = null;

function onWindowKeyDown(event: globalThis.KeyboardEvent) {
  if (event.key !== 'Escape') return;
  const top = getTopModalEntry();
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  top.onCloseRef.current();
}

function getOpenModalEntries(): ModalStackEntry[] {
  return modalStack.filter((entry) => {
    const node = entry.nodeRef.current;
    return node !== null && document.contains(node);
  });
}

/**
 * React effect 的注册顺序不等于视觉上的嵌套顺序：同帧挂载时子弹层可能先入栈。
 * 因此栈顶按当前 DOM 关系动态计算：排除仍是其它弹层祖先的节点，再取文档顺序最靠后的叶节点。
 */
function getTopModalEntry(): ModalStackEntry | null {
  const entries = getOpenModalEntries();
  const leaves = entries.filter((entry) => {
    const node = entry.nodeRef.current;
    if (!node) return false;
    return !entries.some((other) => {
      const otherNode = other.nodeRef.current;
      return other !== entry && otherNode !== null && node.contains(otherNode);
    });
  });

  let top: ModalStackEntry | null = null;
  for (const entry of leaves) {
    if (!top) {
      top = entry;
      continue;
    }
    const topNode = top.nodeRef.current;
    const node = entry.nodeRef.current;
    if (topNode && node && (topNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      top = entry;
    }
  }
  return top;
}

function isTopModalNode(node: HTMLElement | null): boolean {
  if (!node) return false;
  return getTopModalEntry()?.nodeRef.current === node;
}

function isInsideOpenModal(node: Element | null): boolean {
  if (!node) return false;
  return getOpenModalEntries().some((entry) => {
    const modalNode = entry.nodeRef.current;
    return modalNode !== null && (modalNode === node || modalNode.contains(node));
  });
}

function useModalStack(onClose: () => void, open: boolean, nodeRef: RefObject<HTMLElement>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const entry: ModalStackEntry = { onCloseRef, nodeRef };
    modalStack.push(entry);
    if (modalStack.length === 1) window.addEventListener('keydown', onWindowKeyDown, true);

    return () => {
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      if (modalStack.length === 0) window.removeEventListener('keydown', onWindowKeyDown, true);
    };
  }, [open]);
}

/** 给不适合换壳的复杂弹层补充初始焦点和栈顶 Esc 关闭。 */
export function useDialogA11y(onClose: () => void, open = true): RefObject<HTMLDivElement> {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalStack(onClose, open, dialogRef);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const node = dialogRef.current;
      if (node && isTopModalNode(node)) node.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return dialogRef;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

/** Console 后台统一弹层：焦点陷阱、Esc、焦点归还、滚动锁和减少动效支持。 */
export function Modal({ open, onClose, title, size = 'md', children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useModalStack(onClose, open, panelRef);

  useEffect(() => {
    if (!open) return;
    return () => {
      const opener = openerRef.current;
      if (opener && document.contains(opener)) opener.focus?.();
      openerRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (scrollLockCount === 0) previousBodyOverflow = document.body.style.overflow;
    scrollLockCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      scrollLockCount = Math.max(0, scrollLockCount - 1);
      if (scrollLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow ?? '';
        previousBodyOverflow = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || !isTopModalNode(panel)) return;

      const active = document.activeElement as HTMLElement | null;
      if (!isInsideOpenModal(active)) openerRef.current = active;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4 motion-safe:animate-fade-in"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 cursor-default bg-slate-900/50 backdrop-blur-sm"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '对话框'}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-t-xl border border-slate-200 bg-surface shadow-card outline-none motion-safe:animate-fade-up sm:rounded-xl`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          {title ? (
            <h2 id={titleId} className="section-title truncate text-base md:text-lg">
              {title}
            </h2>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="btn-ghost -mr-1.5 h-9 w-9 shrink-0 rounded-full p-0"
          >
            <Icon name="close" className="h-5 w-5" />
            <span className="sr-only">关闭</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="border-t border-slate-200 px-5 py-3.5">{footer}</div> : null}
      </div>
    </div>
  );
}
