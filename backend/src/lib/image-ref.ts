/**
 * 图片列的三种落库形态 + 它们之间的转换（护照照片 / 收款凭证专用）。
 *
 * 一列（Passenger.passportPhotoUrl、Payment.proofUrl、Receipt.proofUrl）里可能出现三种值，
 * 靠前缀互斥、绝不混淆：
 *
 *   1. `blob:sha256:<64 位小写 hex>;<mime>`   —— **blob 引用**（本模块定义，出库后的标准形态）
 *        例：blob:sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08;image/jpeg
 *        · sha256 = 字节内容的摘要，也是 blob 存储里的键（见 blob-store.ts）
 *        · mime 只认嗅探结果（JPEG/PNG/WEBP/GIF 魔数），不信客户端申报值；同字节必得同引用
 *        · 浏览器的 `blob:` 对象 URL 长成 `blob:https://host/uuid`，与本格式的 `blob:sha256:` 前缀
 *          + 定长 hex 天然区分，parseBlobRef 对它返回 null
 *   2. `data:image/<type>;base64,…`            —— 内联 data URL（历史形态；前端仍以此提交，
 *        写入口统一转成 1；存量由回填脚本转）
 *   3. `http(s)://…`                           —— 外链（历史/外部来源，保持现状，读取走 safe-fetch）
 *
 * 对前端的契约不变：前端只见 2（提交与回显）；1 只存在于库里与服务端内部。
 *
 * 转换失败一律**保守**：转不了就保留原值（宁可多占库、绝不丢图），并打日志；
 * 读不到 blob 当无图 + WARN，绝不 500。
 */
import { getBlobStore, type BlobStore } from './blob-store.js';
import { fetchImageSafely } from './safe-fetch.js';

export const BLOB_REF_PREFIX = 'blob:sha256:';

/** 生成 / 解析共用的唯一正则：前缀 + 64 位小写 hex + `;` + image/* mime。 */
const BLOB_REF_RE = /^blob:sha256:([0-9a-f]{64});(image\/[a-z0-9.+-]+)$/;

/** 内联 data URL 的 base64 形态（大小写不敏感；base64 段允许换行/空白，Buffer 解码会忽略）。 */
const IMAGE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i;

/** 解码后字节上限：护照图前端压到 ≤700KB、凭证 ≤6MB data URL，16MB 是纯防呆。 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** 能进 blob 的图片类型（按魔数识别）。其它类型（如 HEIC/SVG）不转，保留原值。 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface BlobRef {
  sha256: string;
  mime: string;
}

export function makeBlobRef(sha256: string, mime: string): string {
  const ref = `${BLOB_REF_PREFIX}${sha256};${mime}`;
  if (!BLOB_REF_RE.test(ref)) throw new Error(`invalid blob ref parts: sha256=${sha256} mime=${mime}`);
  return ref;
}

/** 严格解析：不是本格式（含大小写 / 长度 / mime 不合规）一律 null。 */
export function parseBlobRef(value: unknown): BlobRef | null {
  if (typeof value !== 'string') return null;
  const m = BLOB_REF_RE.exec(value);
  return m ? { sha256: m[1], mime: m[2] } : null;
}

export function isBlobRef(value: unknown): value is string {
  return parseBlobRef(value) !== null;
}

/** `data:image/…` 开头（不要求已能解码；解码见 decodeImageDataUrl）。 */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value);
}

/** 解 base64 data URL → 字节 + 申报 mime；格式不对 / 空 / 超限 → null。 */
export function decodeImageDataUrl(value: string): { declaredMime: string; bytes: Buffer } | null {
  const m = IMAGE_DATA_URL_RE.exec(value);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  return { declaredMime: m[1].toLowerCase(), bytes };
}

/** 按魔数嗅探图片类型（申报 mime 不可信：`image/jpg`、错标 png 的 jpeg 都见过）。 */
export function sniffImageMime(bytes: Buffer): ImageMime | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.byteLength >= 6 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (
    bytes.byteLength >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function toImageDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** 打包 zip 时的文件后缀（与 passport-zip.extFromUrl 的 data URL 分支同口径，未知一律 jpg）。 */
export function extForImageMime(mime: string): 'jpg' | 'png' | 'webp' | 'gif' {
  const sub = mime.toLowerCase().replace(/^image\//, '');
  if (sub === 'png' || sub === 'webp' || sub === 'gif') return sub;
  return 'jpg';
}

function describeForLog(value: string): string {
  // 绝不把 base64 正文打进日志：只留前缀 + 长度
  return `${value.slice(0, 24)}… (len=${value.length})`;
}

/**
 * 写入口转换：内联 data URL → blob 引用。其它形态（引用 / 外链 / 空）原样返回。
 *
 * 转不了（不是 base64 image、魔数不是 JPEG/PNG/WEBP/GIF、超限）→ 保留原值 + WARN；
 * 存储层抛错（磁盘满 / 卷没挂 / 无权限）→ 保留原值 + ERROR —— 业务不因存储故障而下单失败，
 * 库里多一行内联图而已，worker 每日兜底清扫 / 回填脚本随后会再转。
 */
export async function internImageValue<T extends string | null | undefined>(
  value: T,
  store: BlobStore = getBlobStore(),
): Promise<T | string> {
  if (!isImageDataUrl(value)) return value;
  const decoded = decodeImageDataUrl(value);
  if (!decoded) {
    // eslint-disable-next-line no-console
    console.warn(`[image-ref] data URL 无法解码，保留内联落库: ${describeForLog(value)}`);
    return value;
  }
  const mime = sniffImageMime(decoded.bytes);
  if (!mime) {
    // eslint-disable-next-line no-console
    console.warn(
      `[image-ref] 字节不是 JPEG/PNG/WEBP/GIF（申报 ${decoded.declaredMime}），保留内联落库: ${describeForLog(value)}`,
    );
    return value;
  }
  try {
    const { sha256 } = await store.put(decoded.bytes);
    return makeBlobRef(sha256, mime);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[image-ref] blob 写入失败，回退内联落库（请检查 BLOB_DIR 挂载/权限/磁盘）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return value;
  }
}

/**
 * 读出口转换：blob 引用 → 内联 data URL（对前端契约不变）。其它形态原样返回。
 * blob 缺失 → **保留引用原样** + WARN：让「有图但读不到」看得见（前端图裂 / 导出 README 写「下载失败」），
 * 而不是伪装成「客人没传」。
 */
export async function materializeImageValue<T extends string | null | undefined>(
  value: T,
  store: BlobStore = getBlobStore(),
): Promise<T | string> {
  const ref = parseBlobRef(value);
  if (!ref) return value;
  let bytes: Buffer | null = null;
  try {
    bytes = await store.get(ref.sha256);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[image-ref] blob 读取失败 ${ref.sha256}: ${err instanceof Error ? err.message : String(err)}`);
    return value;
  }
  if (!bytes) {
    // eslint-disable-next-line no-console
    console.warn(`[image-ref] blob 缺失（请检查 BLOB_DIR 卷 / 备份是否同步）: ${ref.sha256}`);
    return value;
  }
  return toImageDataUrl(bytes, ref.mime);
}

/**
 * 要字节的消费方（护照包 zip / 按酒店导护照 / 签证包）统一走这里：三种形态都能读。
 *   blob 引用 → 本地 blob；data URL → 本地解码；http(s) → safe-fetch（SSRF 防线不变）。
 * 读不到一律 null（调用方记入缺图明细），绝不抛。
 */
export async function resolveImageBytes(
  value: string | null | undefined,
  store: BlobStore = getBlobStore(),
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!value) return null;
  const ref = parseBlobRef(value);
  if (ref) {
    try {
      const bytes = await store.get(ref.sha256);
      if (bytes) return { bytes, mime: ref.mime };
      // eslint-disable-next-line no-console
      console.warn(`[image-ref] blob 缺失（请检查 BLOB_DIR 卷 / 备份是否同步）: ${ref.sha256}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[image-ref] blob 读取失败 ${ref.sha256}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
  const bytes = await fetchImageSafely(value);
  if (!bytes) return null;
  const declared = IMAGE_DATA_URL_RE.exec(value)?.[1]?.toLowerCase();
  return { bytes, mime: sniffImageMime(bytes) ?? declared ?? 'image/jpeg' };
}
