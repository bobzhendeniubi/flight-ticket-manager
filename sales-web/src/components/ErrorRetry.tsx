import { Icon } from './Icon';

/**
 * 加载失败 + 重试（对标 Klook/携程 错误态）。
 * 友好文案 + 重试按钮（btn-secondary）。
 * 纯展示：重试动作走 onRetry 回调，不引 api。
 */
export interface ErrorRetryProps {
  message?: string;
  onRetry: () => void;
}

export function ErrorRetry({ message, onRetry }: ErrorRetryProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-deal/20 bg-deal-light px-6 py-10 text-center"
    >
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-deal shadow-card">
        <Icon name="info" className="h-7 w-7" />
      </span>
      <div className="space-y-1">
        <h3 className="text-base font-bold text-ink">哎呀，加载失败了</h3>
        <p className="mx-auto max-w-xs text-sm text-ink-soft">
          {message ?? '网络好像开了个小差，请稍后再试一次'}
        </p>
      </div>
      <button type="button" className="btn-secondary mt-1" onClick={onRetry}>
        <Icon name="arrowRight" className="h-4 w-4" />
        重新加载
      </button>
    </div>
  );
}
