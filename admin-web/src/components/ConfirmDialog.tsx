import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  tone?: 'default' | 'danger';
  confirmText?: string;
  cancelText?: string;
}

type PendingConfirm = {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
  settled: boolean;
};

type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

function renderBody(body: ReactNode): ReactNode {
  if (typeof body !== 'string') return body;
  return body.split(/\n{2,}/).map((paragraph, index) => (
    <p key={`${index}-${paragraph.slice(0, 12)}`} className="whitespace-pre-line text-sm leading-6 text-ink-soft">
      {paragraph}
    </p>
  ));
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queueRef = useRef<PendingConfirm[]>([]);
  const currentRef = useRef<PendingConfirm | null>(null);
  const advancingRef = useRef(false);
  const mountedRef = useRef(false);
  const mountGenerationRef = useRef(0);
  const [current, setCurrent] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    if (!mountedRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const request: PendingConfirm = { options, resolve, settled: false };
      if (currentRef.current || advancingRef.current) {
        queueRef.current.push(request);
        return;
      }
      currentRef.current = request;
      setCurrent(request);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    const active = currentRef.current;
    if (!active || active.settled) return;

    active.settled = true;
    active.resolve(result);
    currentRef.current = null;
    setCurrent(null);

    // Do not expose the next request during the same click/Enter event.
    advancingRef.current = true;
    window.setTimeout(() => {
      advancingRef.current = false;
      if (!mountedRef.current) {
        for (const pending of queueRef.current.splice(0)) {
          if (!pending.settled) {
            pending.settled = true;
            pending.resolve(false);
          }
        }
        return;
      }

      if (currentRef.current) return;
      const next = queueRef.current.shift();
      if (!next) return;
      currentRef.current = next;
      setCurrent(next);
    }, 0);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++mountGenerationRef.current;
    return () => {
      mountedRef.current = false;
      window.setTimeout(() => {
        if (mountGenerationRef.current !== generation) return;

        const active = currentRef.current;
        if (active && !active.settled) {
          active.settled = true;
          active.resolve(false);
        }
        currentRef.current = null;
        advancingRef.current = false;
        for (const pending of queueRef.current.splice(0)) {
          if (!pending.settled) {
            pending.settled = true;
            pending.resolve(false);
          }
        }
      }, 0);
    };
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={current !== null}
        onClose={() => settle(false)}
        title={current?.options.title}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => settle(false)}>
              {current?.options.cancelText ?? '取消'}
            </button>
            <button
              type="button"
              className={current?.options.tone === 'danger' ? 'btn-danger' : 'btn-primary'}
              onClick={() => settle(true)}
            >
              {current?.options.confirmText ?? '确认'}
            </button>
          </div>
        }
      >
        <div className="space-y-2 px-5 py-4">{current ? renderBody(current.options.body) : null}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within ConfirmProvider');
  return confirm;
}
