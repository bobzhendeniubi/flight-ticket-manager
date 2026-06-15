import { useState, type ImgHTMLAttributes } from 'react';

/**
 * 响应式图片助手（对标 Klook/携程 列表/详情图）。
 * - Unsplash 链接自动生成 srcSet（&w=）+ &q=75&auto=format，按 widths 出多档
 * - 用 aspect-[] 锁定宽高比，避免 CLS（布局抖动）
 * - 默认 loading="lazy"；eager 时 eager + fetchpriority=high（首屏 hero 用）
 * - 加载失败 → 统一灰底内联 SVG 占位（不白屏、不显示破图标）
 * 纯展示，无 api / 无副作用。
 */
export type ImgRatio = '4/3' | '16/9' | '1/1' | '3/2';

export interface ImgProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  src: string;
  alt: string;
  ratio?: ImgRatio;
  widths?: number[];
  eager?: boolean;
}

const RATIO_CLASS: Record<ImgRatio, string> = {
  '4/3': 'aspect-[4/3]',
  '16/9': 'aspect-[16/9]',
  '1/1': 'aspect-square',
  '3/2': 'aspect-[3/2]',
};

const DEFAULT_WIDTHS = [400, 800, 1200];

/** 统一灰底占位（图标取景框），data-URI 内联，零额外请求。 */
const PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
      <rect width="160" height="120" fill="#eef2f6"/>
      <g fill="none" stroke="#b9c4d1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="46" y="40" width="68" height="48" rx="6"/>
        <circle cx="64" cy="58" r="6"/>
        <path d="M52 84l18-16 12 10 10-8 16 14"/>
      </g>
    </svg>`,
  );

function isUnsplash(url: string): boolean {
  return /images\.unsplash\.com/.test(url);
}

/** 给 Unsplash 链接拼上宽度与优化参数。 */
function unsplashAt(url: string, w: number): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}w=${w}&q=75&auto=format&fit=crop`;
}

export function Img({
  src,
  alt,
  ratio = '4/3',
  widths = DEFAULT_WIDTHS,
  eager,
  className = '',
  sizes,
  ...rest
}: ImgProps) {
  const [failed, setFailed] = useState(false);

  const useUnsplash = !failed && isUnsplash(src);
  const srcSet = useUnsplash
    ? widths.map((w) => `${unsplashAt(src, w)} ${w}w`).join(', ')
    : undefined;
  const resolvedSizes = sizes ?? (useUnsplash ? '(max-width: 640px) 100vw, 33vw' : undefined);

  const finalSrc = failed
    ? PLACEHOLDER
    : useUnsplash
      ? unsplashAt(src, widths[widths.length - 1])
      : src;

  // fetchpriority 在 React 18 的 DOM 类型里尚未收录，用小写属性透传（HTML 标准属性名）。
  const eagerAttrs = eager ? { fetchpriority: 'high' } : {};

  return (
    <img
      {...rest}
      src={finalSrc}
      srcSet={failed ? undefined : srcSet}
      sizes={failed ? undefined : resolvedSizes}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      {...eagerAttrs}
      onError={() => setFailed(true)}
      className={`h-full w-full object-cover ${RATIO_CLASS[ratio]} ${failed ? 'bg-slate-100 object-contain p-6' : ''} ${className}`}
    />
  );
}
