import { useState } from 'react';
import { Icon } from './Icon';

/**
 * 写评价表单（对标 Klook/携程 发表评价）。
 * 可点星评分 + 标题 + 正文 + 提交，含基础客户端校验（必填评分、正文最少字数）。
 * 内部受控；提交结果走 onSubmit 回调，不引 api。
 */
export interface WriteReviewFormData {
  rating: number;
  title?: string;
  body: string;
}

export interface WriteReviewFormProps {
  onSubmit: (data: WriteReviewFormData) => Promise<void> | void;
  submitting?: boolean;
}

const MAX_STARS = 5;
const MIN_BODY_LEN = 10;

export function WriteReviewForm({ onSubmit, submitting }: WriteReviewFormProps) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1) {
      setError('请先点亮星星评分');
      return;
    }
    if (body.trim().length < MIN_BODY_LEN) {
      setError(`评价内容至少 ${MIN_BODY_LEN} 个字，分享更多细节更有帮助`);
      return;
    }
    setError(null);
    await onSubmit({
      rating,
      title: title.trim() || undefined,
      body: body.trim(),
    });
  };

  const shown = hover || rating;

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <div>
        <span className="label">总体评分</span>
        <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
          {Array.from({ length: MAX_STARS }, (_, i) => {
            const v = i + 1;
            return (
              <button
                key={v}
                type="button"
                aria-label={`${v} 星`}
                aria-pressed={rating === v}
                className="rounded-md p-0.5 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                onMouseEnter={() => setHover(v)}
                onFocus={() => setHover(v)}
                onClick={() => {
                  setRating(v);
                  setError(null);
                }}
              >
                <Icon
                  name="star"
                  className={`h-7 w-7 ${v <= shown ? 'text-sun' : 'text-slate-200'}`}
                />
              </button>
            );
          })}
          {rating > 0 && (
            <span className="nums ml-1 text-sm font-bold text-amber-700">{rating}.0</span>
          )}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="review-title">
          标题（选填）
        </label>
        <input
          id="review-title"
          type="text"
          className="input"
          placeholder="一句话总结这次体验"
          maxLength={40}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="review-body">
          评价内容
        </label>
        <textarea
          id="review-body"
          className="input min-h-[7rem] resize-y"
          placeholder="说说航班、酒店、用车的真实体验，给后来人一个参考～"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (error) setError(null);
          }}
        />
        <p className="nums mt-1 text-right text-xs text-ink-muted">{body.trim().length} 字</p>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-deal" role="alert">
          <Icon name="info" className="h-4 w-4" />
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? '提交中…' : '发表评价'}
      </button>
    </form>
  );
}
