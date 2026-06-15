import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Img } from './Img';
import { Icon } from './Icon';

/**
 * 图片画廊（对标 Klook/携程 详情图集）。
 * 主图 + 缩略图条；点开 lightbox（复用 Modal）含上一张/下一张 + 方向键 + 计数。
 * 缩略图懒加载；0 图时给一张得体的占位图块。
 * 纯展示：images 走 props，不引 api。
 */
export interface GalleryImage {
  url: string;
  alt?: string;
}

export interface PhotoGalleryProps {
  images: GalleryImage[];
  className?: string;
}

const MAX_THUMBS = 6;

export function PhotoGallery({ images, className = '' }: PhotoGalleryProps) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const count = images.length;

  const go = useCallback(
    (dir: 1 | -1) => {
      setActive((cur) => (count === 0 ? 0 : (cur + dir + count) % count));
    },
    [count],
  );

  // lightbox 内的方向键导航
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go]);

  // 0 图：得体占位
  if (count === 0) {
    return (
      <div
        className={`flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-2xl bg-canvas text-ink-muted ${className}`}
      >
        <Icon name="mapPin" className="h-9 w-9" />
        <span className="text-xs">暂无图片</span>
      </div>
    );
  }

  const current = images[Math.min(active, count - 1)];
  const thumbs = images.slice(0, MAX_THUMBS);
  const extra = count - thumbs.length;

  return (
    <div className={className}>
      {/* 主图 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative block w-full overflow-hidden rounded-2xl bg-slate-100 shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
        aria-label="查看大图"
      >
        <Img
          src={current.url}
          alt={current.alt ?? '图片'}
          ratio="4/3"
          eager
          className="img-zoom"
        />
        <span className="badge-outline absolute bottom-2.5 right-2.5 bg-white/90 backdrop-blur">
          <Icon name="search" className="h-3 w-3" />
          {active + 1}/{count}
        </span>
      </button>

      {/* 缩略图条 */}
      {count > 1 && (
        <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
          {thumbs.map((img, i) => {
            const isLastThumb = i === thumbs.length - 1 && extra > 0;
            return (
              <button
                key={`${img.url}-${i}`}
                type="button"
                onClick={() => setActive(i)}
                aria-label={`第 ${i + 1} 张`}
                aria-current={i === active}
                className={`relative h-16 w-20 shrink-0 overflow-hidden rounded-xl border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
                  i === active ? 'border-brand' : 'border-transparent opacity-80 hover:opacity-100'
                }`}
              >
                <Img src={img.url} alt={img.alt ?? ''} ratio="4/3" widths={[160, 320]} />
                {isLastThumb && (
                  <span className="absolute inset-0 flex items-center justify-center bg-ink/55 text-sm font-bold text-white">
                    +{extra}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="full"
        title={`${active + 1} / ${count}`}
      >
        <div className="relative flex items-center justify-center bg-ink p-2 sm:p-4">
          <Img
            src={current.url}
            alt={current.alt ?? '图片'}
            ratio="16/9"
            widths={[800, 1200, 1600]}
            eager
            className="max-h-[78vh] !object-contain"
          />
          {count > 1 && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                aria-label="上一张"
                className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-pop transition hover:bg-white"
              >
                <Icon name="arrowRight" className="h-5 w-5 rotate-180" />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                aria-label="下一张"
                className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-pop transition hover:bg-white"
              >
                <Icon name="arrowRight" className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
