/**
 * 内容寻址 blob 存储（护照照片 / 收款凭证的字节落盘）。
 *
 * 背景：三列图片（Passenger.passportPhotoUrl、Payment.proofUrl、Receipt.proofUrl）此前以
 * `data:image/...;base64,` 内联进 Postgres，库体积 1.7GB 里 1.5GB 是照片，每天 pg_dump 1.2GB，
 * 磁盘几周就满。字节改存本地磁盘，库里只留短引用（格式见 image-ref.ts）。
 *
 * 口径：
 *   - 键 = 字节的 sha256（小写 hex 64 位），同一张图存多份（拆单 / 批量 / 复用）天然去重。
 *   - 目录分片 `<root>/ab/cd/<sha>`（前两段各取 sha 的两位 hex），单目录不会堆几千个文件。
 *   - 写入原子：同目录临时文件 → 写满 → fsync → rename 覆盖；读到的要么是完整文件要么不存在。
 *   - 已存在的 sha 不重写（内容寻址，同 sha 必同内容）。
 *   - **永不删除**：这里没有 delete，回填脚本也不删；孤儿 blob 只占磁盘，丢图才是事故。
 *   - 读路径严格校验 sha 格式：路径只由校验过的 hex 拼出，不可能目录穿越。
 *
 * 抽了一层 driver 接口，只实现本地磁盘；将来接阿里云 OSS 只需再写一个 driver，引用格式不变。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { blobDir } from '../config/env.js';

/** sha256 小写 hex（64 位）。引用与文件名都只认这一种写法。 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 存储后端接口：只管「按 sha 存 / 取字节」，不关心 mime、不关心业务。 */
export interface BlobDriver {
  /** 写入字节；该 sha 已存在则不重写。返回本次是否真的新建了文件。 */
  put(sha256: string, bytes: Buffer): Promise<{ created: boolean }>;
  /** 读取字节；不存在返回 null（读失败以外的错误照常抛出）。 */
  get(sha256: string): Promise<Buffer | null>;
  exists(sha256: string): Promise<boolean>;
}

function assertSha(sha256: string): void {
  if (!isSha256Hex(sha256)) {
    throw new Error(`blob key must be 64-hex sha256, got: ${String(sha256).slice(0, 80)}`);
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** 本地磁盘 driver：`<root>/ab/cd/<sha>`，临时文件 + fsync + rename 原子落盘。 */
export class LocalFsBlobDriver implements BlobDriver {
  constructor(readonly rootDir: string) {}

  /** 只由校验过的 hex 拼路径 —— 这是防目录穿越的唯一防线，所有入口都先过它。 */
  pathFor(sha256: string): string {
    assertSha(sha256);
    return path.join(this.rootDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(sha256: string, bytes: Buffer): Promise<{ created: boolean }> {
    const finalPath = this.pathFor(sha256);
    if (await this.exists(sha256)) return { created: false };

    const dir = path.dirname(finalPath);
    await mkdir(dir, { recursive: true });
    // 同目录临时文件：rename 只在同一文件系统内才是原子的
    const tmpPath = path.join(dir, `.${sha256}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const handle = await open(tmpPath, 'wx', 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    // 目录项也刷盘（rename 后目录未 fsync 时掉电可能丢文件名）；部分文件系统不支持对目录 fsync，尽力而为。
    try {
      const dirHandle = await open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* best effort */
    }
    return { created: true };
  }

  async get(sha256: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(sha256));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(sha256));
      return info.isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

/** 业务侧用的存储门面：算 sha、校验、委托 driver。 */
export class BlobStore {
  constructor(readonly driver: BlobDriver) {}

  /** 存字节，返回内容 sha（键）与是否新建。空字节拒绝——空图不是图。 */
  async put(bytes: Buffer): Promise<{ sha256: string; created: boolean }> {
    if (bytes.byteLength === 0) throw new Error('refusing to store an empty blob');
    const sha256 = sha256Hex(bytes);
    const { created } = await this.driver.put(sha256, bytes);
    return { sha256, created };
  }

  /** 非法 sha 一律当不存在（不抛、不碰文件系统）。 */
  async get(sha256: string): Promise<Buffer | null> {
    if (!isSha256Hex(sha256)) return null;
    return this.driver.get(sha256);
  }

  async exists(sha256: string): Promise<boolean> {
    if (!isSha256Hex(sha256)) return false;
    return this.driver.exists(sha256);
  }
}

export function createLocalBlobStore(rootDir: string): BlobStore {
  return new BlobStore(new LocalFsBlobDriver(rootDir));
}

let defaultStore: BlobStore | null = null;

/** 进程级默认存储（根目录 = env.BLOB_DIR 推导出的 blobDir），首次调用才建。 */
export function getBlobStore(): BlobStore {
  if (!defaultStore) defaultStore = createLocalBlobStore(blobDir);
  return defaultStore;
}

/**
 * 启动自检：根目录能建、能写、能读、能删。返回问题描述（null = 正常）。
 * 只用于启动日志 —— 目录不可写时服务照常起（写入口会回退内联落库并打 ERROR，见 image-ref.ts），
 * 不把整个 API 拖下线。
 */
export async function probeBlobDir(rootDir: string = blobDir): Promise<string | null> {
  const probePath = path.join(rootDir, `.probe.${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(rootDir, { recursive: true });
    const handle = await open(probePath, 'wx', 0o644);
    try {
      await handle.writeFile('ok');
    } finally {
      await handle.close();
    }
    const back = await readFile(probePath, 'utf8');
    await unlink(probePath);
    return back === 'ok' ? null : `probe read back mismatch in ${rootDir}`;
  } catch (err) {
    await unlink(probePath).catch(() => undefined);
    return `${rootDir}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
