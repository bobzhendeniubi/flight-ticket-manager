/**
 * 护照图片压缩（避免后端 413）
 *
 * 多人团（如 9 人各一张护照图）会把请求体撑爆后端上限。策略：每张图都缩到长边 ≤1600px、
 * 转 JPEG、目标 ≤~700KB（data-URL）。9 张 × ~700KB ≈ 6MB，稳落在后端上限内。
 * 结账页（CheckoutPage）与订单页护照补录弹窗共用。
 */
const PASSPORT_PHOTO_MAX_BYTES = 6 * 1024 * 1024; // 单张 data-URL 硬上限，超则丢弃该图
const PASSPORT_PHOTO_COMPRESS_TARGET = 700 * 1024; // 压缩目标（~700KB data-URL）
const MAX_IMAGE_DIMENSION = 1600; // 缩放时长边上限（px）

/**
 * 把护照图片 File 读成 data-URL；统一 canvas 等比缩小到长边 ≤1600 + JPEG 降质到目标体积。
 * 压缩后仍超硬上限时返回 ''（调用方跳过该图，不阻断主流程）。
 */
export async function passportFileToDataUrl(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取失败')));
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsDataURL(file);
  });

  // 解码原图（拿到像素尺寸才能等比缩放）
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('图片解析失败'));
    el.src = raw;
  });

  // 统一缩放到长边 ≤ MAX_IMAGE_DIMENSION（小图不放大；scale 上限 1）
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // 极端环境拿不到 canvas：原图已在目标内就用原图，否则丢弃（不阻断主流程）
    return raw.length <= PASSPORT_PHOTO_MAX_BYTES ? raw : '';
  }

  ctx.drawImage(img, 0, 0, w, h);

  // 缩放后逐步降质到目标体积
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length <= PASSPORT_PHOTO_COMPRESS_TARGET) return out;
  }

  const fallback = canvas.toDataURL('image/jpeg', 0.45);
  // 仍超硬上限 → 丢弃图片（不阻断主流程），上传失败只影响签证台取图
  if (fallback.length > PASSPORT_PHOTO_MAX_BYTES) return '';
  return fallback;
}
