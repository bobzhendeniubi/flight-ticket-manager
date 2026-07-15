import { describe, it, expect } from 'vitest';

import { fetchImageSafely } from './safe-fetch.js';

describe('safe-fetch · data-URL 本地解码', () => {
  it('合法 data:image base64 → 解出字节，不出网', async () => {
    // 1x1 透明 PNG
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const buf = await fetchImageSafely(png);
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBeGreaterThan(0);
  });

  it('非 image 的 data-URL → null', async () => {
    expect(await fetchImageSafely('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });

  it('空 base64 → null', async () => {
    expect(await fetchImageSafely('data:image/png;base64,')).toBeNull();
  });
});

describe('safe-fetch · SSRF 防线（不实际出网，因目标被拒于 fetch 前）', () => {
  it('云元数据地址 169.254.169.254 → null', async () => {
    expect(
      await fetchImageSafely('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
    ).toBeNull();
  });

  it('回环 / 私网字面量 IP → null', async () => {
    for (const u of [
      'http://127.0.0.1/x.png',
      'https://127.0.0.1/x.png',
      'https://10.0.0.5/x.png',
      'https://192.168.1.1/x.png',
      'https://172.16.0.9/x.png',
      'http://[::1]/x.png',
    ]) {
      expect(await fetchImageSafely(u)).toBeNull();
    }
  });

  it('非 https（http/file/gopher）→ null', async () => {
    for (const u of [
      'http://example.com/x.png',
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/x.png',
    ]) {
      expect(await fetchImageSafely(u)).toBeNull();
    }
  });

  it('非法 URL → null', async () => {
    expect(await fetchImageSafely('not a url')).toBeNull();
  });
});
