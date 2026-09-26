/**
 * 内容寻址 blob 存储 · 单元测试（真文件系统，临时目录）。
 *   - put/get 往返、目录分片 ab/cd/<sha>、同内容第二次 put 不重写（created=false）
 *   - 原子写：落盘后目录里没有残留 .tmp；并发 put 同一内容只留一份且内容正确
 *   - 非法 sha（长度 / 大写 / 目录穿越片段）读写一律拒绝，绝不碰路径
 *   - probeBlobDir：可写目录 null，不可写路径返回问题描述
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BlobStore,
  LocalFsBlobDriver,
  createLocalBlobStore,
  isSha256Hex,
  probeBlobDir,
  sha256Hex,
} from './blob-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ftm-blob-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listAllFiles(full)));
    else out.push(full);
  }
  return out;
}

describe('BlobStore · put / get', () => {
  it('put 返回内容 sha256，文件落在 <root>/ab/cd/<sha>，get 原样读回', async () => {
    const store = createLocalBlobStore(root);
    const bytes = Buffer.from('hello blob');
    const { sha256, created } = await store.put(bytes);

    expect(created).toBe(true);
    expect(sha256).toBe(sha256Hex(bytes));
    expect(isSha256Hex(sha256)).toBe(true);

    const expectedPath = path.join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    expect((await stat(expectedPath)).isFile()).toBe(true);
    expect(await readFile(expectedPath)).toEqual(bytes);
    expect(await store.get(sha256)).toEqual(bytes);
    expect(await store.exists(sha256)).toBe(true);
  });

  it('同内容第二次 put 不重写（created=false），文件只有一份', async () => {
    const store = createLocalBlobStore(root);
    const bytes = Buffer.from('same content twice');
    const first = await store.put(bytes);
    const second = await store.put(bytes);
    expect(first.sha256).toBe(second.sha256);
    expect(second.created).toBe(false);
    expect(await listAllFiles(root)).toHaveLength(1);
  });

  it('空字节拒绝入库', async () => {
    const store = createLocalBlobStore(root);
    await expect(store.put(Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it('不存在的 sha → get null / exists false（不抛）', async () => {
    const store = createLocalBlobStore(root);
    const missing = 'a'.repeat(64);
    expect(await store.get(missing)).toBeNull();
    expect(await store.exists(missing)).toBe(false);
  });
});

describe('BlobStore · 原子写', () => {
  it('落盘后目录里没有残留临时文件', async () => {
    const store = createLocalBlobStore(root);
    await store.put(Buffer.from('a'));
    await store.put(Buffer.from('b'));
    const files = await listAllFiles(root);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('并发 put 同一内容：只留一份、内容正确、无临时文件残留', async () => {
    const store = createLocalBlobStore(root);
    const bytes = Buffer.from('concurrent write of identical bytes');
    const results = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));
    const shas = new Set(results.map((r) => r.sha256));
    expect(shas.size).toBe(1);
    const files = await listAllFiles(root);
    expect(files).toHaveLength(1);
    expect(await store.get(results[0].sha256)).toEqual(bytes);
  });
});

describe('BlobStore · 非法 sha 一律拒绝（防目录穿越）', () => {
  const bad = [
    '../../etc/passwd',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64), // 大写 hex 也不认：引用格式只认小写
    'zz' + 'a'.repeat(62),
    '',
  ];

  it('BlobStore.get / exists 对非法 sha 返回 null / false，不碰文件系统', async () => {
    const store = createLocalBlobStore(root);
    for (const key of bad) {
      expect(await store.get(key)).toBeNull();
      expect(await store.exists(key)).toBe(false);
    }
  });

  it('driver 层直接拒绝：pathFor / put / get 抛错', async () => {
    const driver = new LocalFsBlobDriver(root);
    for (const key of bad) {
      expect(() => driver.pathFor(key)).toThrow(/sha256/);
      await expect(driver.put(key, Buffer.from('x'))).rejects.toThrow(/sha256/);
      await expect(driver.get(key)).rejects.toThrow(/sha256/);
    }
    expect(await listAllFiles(root)).toHaveLength(0);
  });

  it('自定义 driver 也能挂进 BlobStore（接口只有 put/get/exists）', async () => {
    const mem = new Map<string, Buffer>();
    const store = new BlobStore({
      async put(sha, bytes) {
        const created = !mem.has(sha);
        mem.set(sha, bytes);
        return { created };
      },
      async get(sha) {
        return mem.get(sha) ?? null;
      },
      async exists(sha) {
        return mem.has(sha);
      },
    });
    const { sha256 } = await store.put(Buffer.from('in-memory driver'));
    expect(await store.get(sha256)).toEqual(Buffer.from('in-memory driver'));
  });
});

describe('probeBlobDir', () => {
  it('可写目录（含尚不存在的子目录）→ null，且不留探针文件', async () => {
    const dir = path.join(root, 'nested', 'blobs');
    expect(await probeBlobDir(dir)).toBeNull();
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('不可写位置 → 返回问题描述', async () => {
    // 把一个普通文件当目录用：mkdir 必失败
    const filePath = path.join(root, 'not-a-dir');
    await writeFile(filePath, 'plain file');
    const problem = await probeBlobDir(path.join(filePath, 'blobs'));
    expect(problem).not.toBeNull();
    expect(problem).toContain('not-a-dir');
  });
});
