/**
 * 图片引用格式 + 三种落库形态转换 · 单元测试（blob 存储用临时目录）。
 *   - 引用生成 / 解析：只认 `blob:sha256:<64 小写 hex>;<mime>`，data: / http(s): / 浏览器 blob: URL 全部 null
 *   - data URL 解码 + 魔数嗅探：JPEG / PNG / WEBP / GIF 识别，其它 null
 *   - internImageValue：data URL → 引用（字节进库、同字节同引用）；引用 / 外链 / 空值 / 转不了的原样返回；
 *     存储层抛错回退原值
 *   - materializeImageValue：引用 → data URL；blob 缺失保留引用
 *   - resolveImageBytes：三种形态都能读，缺失 null
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobStore, createLocalBlobStore, sha256Hex } from './blob-store.js';
import {
  BLOB_REF_PREFIX,
  decodeImageDataUrl,
  extForImageMime,
  internImageValue,
  isBlobRef,
  isImageDataUrl,
  makeBlobRef,
  materializeImageValue,
  parseBlobRef,
  resolveImageBytes,
  sniffImageMime,
  toImageDataUrl,
} from './image-ref.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF_FAKE = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1');
const WEBP_FAKE = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HEX64 = 'a'.repeat(64);

let root: string;
let store: BlobStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ftm-image-ref-'));
  store = createLocalBlobStore(root);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('blob 引用格式', () => {
  it('makeBlobRef → parseBlobRef 往返', () => {
    const ref = makeBlobRef(HEX64, 'image/jpeg');
    expect(ref).toBe(`${BLOB_REF_PREFIX}${HEX64};image/jpeg`);
    expect(parseBlobRef(ref)).toEqual({ sha256: HEX64, mime: 'image/jpeg' });
    expect(isBlobRef(ref)).toBe(true);
  });

  it('非法片段拒绝生成', () => {
    expect(() => makeBlobRef('A'.repeat(64), 'image/jpeg')).toThrow();
    expect(() => makeBlobRef(HEX64, 'text/html')).toThrow();
    expect(() => makeBlobRef('a'.repeat(63), 'image/png')).toThrow();
  });

  it('与 data: / http(s): / 浏览器 blob: 对象 URL 绝不混淆', () => {
    for (const v of [
      'data:image/jpeg;base64,/9j/4AAQ',
      'https://example.com/a.jpg',
      'http://example.com/a.jpg',
      'blob:https://admin.example.com/3d6a1c8e-0a5e-4d5b-9b5e-1f2a3b4c5d6e',
      `blob:sha256:${HEX64}`, // 缺 mime
      `blob:sha256:${'A'.repeat(64)};image/jpeg`, // 大写
      `blob:sha256:${'a'.repeat(63)};image/jpeg`, // 长度
      `blob:sha256:${HEX64};text/plain`, // 非 image
      `BLOB:sha256:${HEX64};image/jpeg`,
      '',
      null,
      undefined,
      42,
    ]) {
      expect(parseBlobRef(v)).toBeNull();
      expect(isBlobRef(v)).toBe(false);
    }
  });
});

describe('data URL 解码 + 魔数嗅探', () => {
  it('isImageDataUrl 只看前缀（大小写不敏感）', () => {
    expect(isImageDataUrl('data:image/png;base64,abc')).toBe(true);
    expect(isImageDataUrl('DATA:IMAGE/JPEG;base64,abc')).toBe(true);
    expect(isImageDataUrl('data:text/plain;base64,abc')).toBe(false);
    expect(isImageDataUrl(makeBlobRef(HEX64, 'image/png'))).toBe(false);
    expect(isImageDataUrl(null)).toBe(false);
  });

  it('decodeImageDataUrl：合法 → 字节 + 申报 mime；非 base64 / 空 / 非 image → null', () => {
    const decoded = decodeImageDataUrl(toImageDataUrl(PNG_1PX, 'image/PNG'));
    expect(decoded?.declaredMime).toBe('image/png');
    expect(decoded?.bytes).toEqual(PNG_1PX);
    expect(decodeImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(decodeImageDataUrl('data:image/png,not-base64')).toBeNull();
    expect(decodeImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });

  it('魔数：JPEG / PNG / GIF / WEBP 识别，其它 null（申报 mime 不算数）', () => {
    expect(sniffImageMime(JPEG_FAKE)).toBe('image/jpeg');
    expect(sniffImageMime(PNG_1PX)).toBe('image/png');
    expect(sniffImageMime(GIF_FAKE)).toBe('image/gif');
    expect(sniffImageMime(WEBP_FAKE)).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('Hello'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeNull(); // 太短
  });

  it('extForImageMime：png/webp/gif 原样，jpeg 与未知一律 jpg', () => {
    expect(extForImageMime('image/png')).toBe('png');
    expect(extForImageMime('image/webp')).toBe('webp');
    expect(extForImageMime('image/gif')).toBe('gif');
    expect(extForImageMime('image/jpeg')).toBe('jpg');
    expect(extForImageMime('image/svg+xml')).toBe('jpg');
  });
});

describe('internImageValue（写入口：内联 → 引用）', () => {
  it('data URL → blob 引用；字节进库；mime 取嗅探值而非申报值', async () => {
    // 申报 image/jpg（非标准写法）但字节是 PNG → 引用里是 image/png
    const value = toImageDataUrl(PNG_1PX, 'image/jpg');
    const ref = await internImageValue(value, store);
    expect(parseBlobRef(ref)).toEqual({ sha256: sha256Hex(PNG_1PX), mime: 'image/png' });
    expect(await store.get(sha256Hex(PNG_1PX))).toEqual(PNG_1PX);
  });

  it('同字节必得同引用（拆单 / 批量复用的图天然去重）', async () => {
    const a = await internImageValue(toImageDataUrl(JPEG_FAKE, 'image/jpeg'), store);
    const b = await internImageValue(`data:image/jpeg;base64,${JPEG_FAKE.toString('base64')}`, store);
    expect(a).toBe(b);
  });

  it('引用 / 外链 / 空值原样返回', async () => {
    const ref = makeBlobRef(HEX64, 'image/jpeg');
    expect(await internImageValue(ref, store)).toBe(ref);
    expect(await internImageValue('https://example.com/p.jpg', store)).toBe('https://example.com/p.jpg');
    expect(await internImageValue(null, store)).toBeNull();
    expect(await internImageValue(undefined, store)).toBeUndefined();
    expect(await internImageValue('', store)).toBe('');
  });

  it('转不了（不是 JPEG/PNG/WEBP/GIF 字节、解不出 base64）→ 保留原值 + warn，不入库', async () => {
    const notImage = 'data:image/png;base64,SGVsbG8='; // "Hello"
    expect(await internImageValue(notImage, store)).toBe(notImage);
    const empty = 'data:image/png;base64,';
    expect(await internImageValue(empty, store)).toBe(empty);
    expect(console.warn).toHaveBeenCalled();
  });

  it('存储层抛错（卷没挂 / 磁盘满）→ 回退原值 + error，绝不抛出让业务写失败', async () => {
    const broken = new BlobStore({
      put: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      get: async () => null,
      exists: async () => false,
    });
    const value = toImageDataUrl(PNG_1PX, 'image/png');
    expect(await internImageValue(value, broken)).toBe(value);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('materializeImageValue（读出口：引用 → 内联）', () => {
  it('引用 → data URL（mime 来自引用），其它形态原样', async () => {
    const { sha256 } = await store.put(PNG_1PX);
    const ref = makeBlobRef(sha256, 'image/png');
    expect(await materializeImageValue(ref, store)).toBe(toImageDataUrl(PNG_1PX, 'image/png'));
    const dataUrl = toImageDataUrl(JPEG_FAKE, 'image/jpeg');
    expect(await materializeImageValue(dataUrl, store)).toBe(dataUrl);
    expect(await materializeImageValue('https://x/y.png', store)).toBe('https://x/y.png');
    expect(await materializeImageValue(null, store)).toBeNull();
  });

  it('blob 缺失 → 保留引用原样 + warn（不伪装成没传）', async () => {
    const ref = makeBlobRef(HEX64, 'image/jpeg');
    expect(await materializeImageValue(ref, store)).toBe(ref);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('resolveImageBytes（要字节的消费方）', () => {
  it('引用 → 本地 blob 字节 + 引用里的 mime', async () => {
    const { sha256 } = await store.put(JPEG_FAKE);
    const out = await resolveImageBytes(makeBlobRef(sha256, 'image/jpeg'), store);
    expect(out?.bytes).toEqual(JPEG_FAKE);
    expect(out?.mime).toBe('image/jpeg');
  });

  it('data URL → 本地解码，mime 按魔数（申报错也纠正）', async () => {
    const out = await resolveImageBytes(toImageDataUrl(PNG_1PX, 'image/jpeg'), store);
    expect(out?.bytes).toEqual(PNG_1PX);
    expect(out?.mime).toBe('image/png');
  });

  it('引用但 blob 缺失 → null + warn；空值 → null；私网外链 → null（SSRF 防线不变）', async () => {
    expect(await resolveImageBytes(makeBlobRef(HEX64, 'image/png'), store)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
    expect(await resolveImageBytes(null, store)).toBeNull();
    expect(await resolveImageBytes('', store)).toBeNull();
    expect(await resolveImageBytes('https://127.0.0.1/x.png', store)).toBeNull();
  });
});
