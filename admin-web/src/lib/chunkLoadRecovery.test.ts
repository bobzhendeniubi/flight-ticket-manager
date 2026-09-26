/**
 * lib/chunkLoadRecovery · 按需加载失败识别 + 自动刷新防循环记号回归。
 *
 * 发版后旧哈希页面文件 404 → 自动刷新一次；刷新后同一构建仍失败必须停手改提示，
 * 否则就是整页无限刷新。这里把「认不认得出」「刷几次」两件事钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  CHUNK_RELOAD_STORAGE_KEY,
  claimChunkReload,
  isChunkLoadError,
  releaseChunkReload,
  type ReloadGuardStorage,
} from './chunkLoadRecovery';

/** 内存版存储，行为同 sessionStorage 的 getItem/setItem/removeItem。 */
function memoryStorage(): ReloadGuardStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('isChunkLoadError', () => {
  it('认得各浏览器「动态 import 文件没拿到」的报错', () => {
    const messages = [
      'Failed to fetch dynamically imported module: https://admin.example.com/assets/OrdersPage-abc123.js', // Chrome / Edge
      'error loading dynamically imported module: https://admin.example.com/assets/OrdersPage-abc123.js', // Firefox
      'Importing a module script failed.', // Safari
      'Unable to preload CSS for /assets/OrdersPage-abc123.css', // Vite 预加载 CSS
      'Loading chunk 123 failed.', // webpack 风格
      'Loading CSS chunk orders failed',
    ];
    for (const message of messages) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
  });

  it('name 为 ChunkLoadError 的错误也算', () => {
    const err = new Error('whatever');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('直接传报错文本（非 Error 对象）也能识别', () => {
    expect(isChunkLoadError('Failed to fetch dynamically imported module: /assets/x.js')).toBe(true);
    expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(true);
  });

  it('页面代码自身的错误不算（要交给外层错误边界，不能靠刷新掩盖）', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new SyntaxError('Unexpected token <'))).toBe(false);
    expect(isChunkLoadError(new Error('请求失败（500）'))).toBe(false);
    expect(isChunkLoadError('随便一句话')).toBe(false);
  });

  it('null / undefined / 数字 / 无 message 的对象 → false，不抛', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(404)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

describe('claimChunkReload / releaseChunkReload', () => {
  it('同一构建第一次失败允许自动刷新，并先记下构建号', () => {
    const storage = memoryStorage();
    expect(claimChunkReload('build-a', storage)).toBe(true);
    expect(storage.data.get(CHUNK_RELOAD_STORAGE_KEY)).toBe('build-a');
  });

  it('刷新后同一构建再失败 → 不再自动刷新（防无限刷新）', () => {
    const storage = memoryStorage();
    expect(claimChunkReload('build-a', storage)).toBe(true);
    expect(claimChunkReload('build-a', storage)).toBe(false);
    expect(claimChunkReload('build-a', storage)).toBe(false);
  });

  it('刷新后已是新构建（又发了一次版）→ 新构建还能自动刷新一次', () => {
    const storage = memoryStorage();
    expect(claimChunkReload('build-a', storage)).toBe(true);
    expect(claimChunkReload('build-b', storage)).toBe(true);
    expect(claimChunkReload('build-b', storage)).toBe(false);
  });

  it('页面代码成功加载过（release）→ 同一构建之后再失败又能自动刷新一次', () => {
    const storage = memoryStorage();
    expect(claimChunkReload('build-a', storage)).toBe(true);
    releaseChunkReload(storage);
    expect(storage.data.has(CHUNK_RELOAD_STORAGE_KEY)).toBe(false);
    expect(claimChunkReload('build-a', storage)).toBe(true);
  });

  it('存储不可用 → 不自动刷新（没法防循环，宁可提示）', () => {
    expect(claimChunkReload('build-a', null)).toBe(false);
  });

  it('存储读写抛错 → 不自动刷新，也不往外抛', () => {
    const throwing: ReloadGuardStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(claimChunkReload('build-a', throwing)).toBe(false);
    expect(() => releaseChunkReload(throwing)).not.toThrow();
  });

  it('setItem 静默失败（写了读不回）→ 不自动刷新', () => {
    const silent: ReloadGuardStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(claimChunkReload('build-a', silent)).toBe(false);
  });

  it('release 时没有记号 / 存储为 null 都是空操作', () => {
    expect(() => releaseChunkReload(memoryStorage())).not.toThrow();
    expect(() => releaseChunkReload(null)).not.toThrow();
  });
});
