/**
 * 回单/截图查看器 · 缩略图 → 页内大图预览层
 *
 * 为什么不用 <a target="_blank">：回单是 base64 `data:` URL 存库，现代 Chrome/Firefox
 * 拦截顶层导航到 data: URL —— 缩略图能显示，但新标签打开必空白。
 * 这里改为点缩略图弹出页内 lightbox（半透明遮罩 + 大图，点遮罩/Esc 关闭，图过大可滚动），
 * 「下载」按钮走 blob 落盘（data: 的 download 属性被浏览器允许，但 blob 更稳）。
 */
import { useCallback, useEffect, useState } from 'react';

interface ProofImageViewerProps {
  /** 图片地址（通常是 base64 data: URL，也兼容普通 http URL） */
  src: string;
  /** 无障碍描述 + 下载文件名基名 */
  alt: string;
  /** 缩略图额外类名（尺寸/边框由调用方决定） */
  thumbClassName?: string;
}

// 从 data: URL 解析扩展名，落盘文件名用；非 data: 或解析失败回退 png
function extFromDataUrl(src: string): string {
  const m = /^data:image\/([a-zA-Z0-9.+-]+)[;,]/.exec(src);
  if (!m) return 'png';
  const sub = m[1].toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  if (sub === 'svg+xml') return 'svg';
  return sub;
}

export function ProofImageViewer({ src, alt, thumbClassName }: ProofImageViewerProps) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // blob 方式落盘：dataURL → fetch → blob → objectURL → a.download → revoke
  async function download(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${alt}.${extFromDataUrl(src)}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // 兜底：blob 失败时用 data: 的 download 属性（浏览器允许 download 场景的 data:）
      const a = document.createElement('a');
      a.href = src;
      a.download = `${alt}.${extFromDataUrl(src)}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="block cursor-zoom-in rounded"
        onClick={() => setOpen(true)}
        title="点击查看大图"
      >
        <img src={src} alt={alt} className={thumbClassName} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
        >
          <div className="absolute inset-0 bg-ink/70 animate-fade-in" onClick={close} aria-hidden />
          <div className="relative z-10 flex max-h-full w-full max-w-3xl flex-col">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-white">{alt}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-white/90 px-3 py-1 text-xs font-medium text-ink hover:bg-white disabled:opacity-50"
                  onClick={download}
                  disabled={downloading}
                >
                  {downloading ? '下载中…' : '下载'}
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-lg text-ink hover:bg-white"
                  onClick={close}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-white/5">
              <img src={src} alt={alt} className="mx-auto block max-w-none" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
