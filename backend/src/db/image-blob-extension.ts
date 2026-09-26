/**
 * Prisma 客户端扩展：三列图片（Passenger.passportPhotoUrl / Payment.proofUrl / Receipt.proofUrl）
 * 的「写入内联 → blob 引用」「读出引用 → 内联」统一卡口。
 *
 * 为什么放在 Prisma 层而不是逐个改业务入口：落这三列的写入口太多（单笔建单、批量建单、改出行人、
 * 换人、自助补录、前台下单、拆单复制、占位单转正、人工确认收款、认款、凭证上传、public 路由……），
 * 而且大半是 order.create 里的嵌套 passengers.create、事务里的 tx.passenger.update 这类间接写。
 * 在客户端扩展里对**每个**模型操作的 args 做一次遍历，就把现在和将来的所有入口一网打尽：
 *   - 写：args.data / args.create / args.update（含嵌套关系写入信封 create / createMany /
 *         update / updateMany / upsert / connectOrCreate，任意深度）里的 data URL → blob 引用
 *   - 读：结果树里（含 include / select 带出的嵌套关系，任意深度）的 blob 引用 → data URL，
 *         业务代码与前端契约（接口返回 data URL）完全不变
 * 交互式事务里的 tx.xxx、批量事务 $transaction([...])、createMany / upsert 都走这个钩子
 * （已实测 Prisma 5.22）；$queryRaw / $executeRaw **不走**——raw SQL 看见的是库里的真实引用。
 *
 * 遍历按 DMMF 做了剪枝：只下钻能通向图片列的关系字段，不碰标量 / Json 列（Json 里哪怕有同名键也不动），
 * 图片列名在全 schema 里唯一（image-blob-extension.test.ts 有守卫）。
 *
 * 失败口径与 image-ref.ts 一致：转不了保留原值、读不到保留引用并 WARN，绝不让业务写失败或 500。
 */
import { Prisma } from '@prisma/client';
import { getBlobStore, type BlobStore } from '../lib/blob-store.js';
import {
  internImageValue,
  isBlobRef,
  isImageDataUrl,
  materializeImageValue,
} from '../lib/image-ref.js';

/** 承载图片字节的列：模型名 → 列名。改这里 = 改出库范围（回填脚本同样读这张表）。 */
export const IMAGE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Passenger: ['passportPhotoUrl'],
  Payment: ['proofUrl'],
  Receipt: ['proofUrl'],
};

/** 同时读 / 写多少个 blob（批量建单一次可能带上百张护照图）。 */
const BLOB_IO_CONCURRENCY = 8;

interface ModelMeta {
  imageFields: readonly string[];
  /** 关系字段 → 目标模型；只保留目标模型也能通向图片列的关系（其余下钻没有意义）。 */
  relations: ReadonlyArray<{ field: string; target: string }>;
  /** 该模型有名为 data 的标量列（FulfillmentTask.data 等）——嵌套 update 信封判别用。 */
  hasScalarNamedData: boolean;
}

function buildModelMeta(): ReadonlyMap<string, ModelMeta> {
  const models = Prisma.dmmf.datamodel.models;
  const relationsByModel = new Map<string, Array<{ field: string; target: string }>>();
  for (const m of models) {
    relationsByModel.set(
      m.name,
      m.fields.filter((f) => f.kind === 'object').map((f) => ({ field: f.name, target: f.type })),
    );
  }
  // 可达性不动点：自己有图片列，或某个关系指向可达模型 → 可达（结果树 / 写入树才可能含图片列）
  const reachable = new Set(Object.keys(IMAGE_COLUMNS));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, rels] of relationsByModel) {
      if (reachable.has(name)) continue;
      if (rels.some((r) => reachable.has(r.target))) {
        reachable.add(name);
        changed = true;
      }
    }
  }
  const meta = new Map<string, ModelMeta>();
  for (const m of models) {
    if (!reachable.has(m.name)) continue;
    meta.set(m.name, {
      imageFields: IMAGE_COLUMNS[m.name] ?? [],
      relations: (relationsByModel.get(m.name) ?? []).filter((r) => reachable.has(r.target)),
      hasScalarNamedData: m.fields.some((f) => f.kind !== 'object' && f.name === 'data'),
    });
  }
  return meta;
}

const MODEL_META: ReadonlyMap<string, ModelMeta> = buildModelMeta();

/** 模型是否可能在 args / 结果里带到图片列（不可能的模型钩子直通，零开销）。 */
export function modelTouchesImages(model: string): boolean {
  return MODEL_META.has(model);
}

/** 值替换器：返回 null = 不改。遍历本身是同步的（先收集、后替换，见 transformTree）。 */
type Replace = (value: string) => string | null;

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 数组 map，元素全没变就返回原数组（copy-on-write）。 */
function mapCow<T>(arr: T[], fn: (el: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < arr.length; i += 1) {
    const next = fn(arr[i]);
    if (next !== arr[i]) {
      if (!out) out = arr.slice();
      out[i] = next;
    }
  }
  return out ?? arr;
}

/** 对象里某些键的重写，键值全没变就返回原对象（copy-on-write）。 */
function withReplaced(obj: PlainObject, patches: Array<[string, unknown]>): PlainObject {
  const real = patches.filter(([k, v]) => v !== obj[k]);
  if (real.length === 0) return obj;
  const out: PlainObject = { ...obj };
  for (const [k, v] of real) out[k] = v;
  return out;
}

/** 图片列的值：写入时可能是字符串或 `{ set: string }` 更新算子；读出时是字符串 / null。 */
function rewriteImageFieldValue(v: unknown, replace: Replace): unknown {
  if (typeof v === 'string') {
    const next = replace(v);
    return next === null ? v : next;
  }
  if (isPlainObject(v) && typeof v.set === 'string') {
    const next = replace(v.set);
    return next === null ? v : { ...v, set: next };
  }
  return v;
}

// ── 写入树（args.data 等，含嵌套关系写入信封）──────────────────────────────────────────

/** 「某模型的数据对象（或数组）」：图片列 + 各关系字段的嵌套写入信封。 */
function rewriteModelData(model: string, node: unknown, replace: Replace): unknown {
  if (Array.isArray(node)) return mapCow(node, (el) => rewriteModelData(model, el, replace));
  if (!isPlainObject(node)) return node;
  const meta = MODEL_META.get(model);
  if (!meta) return node;
  const patches: Array<[string, unknown]> = [];
  for (const field of meta.imageFields) {
    if (field in node) patches.push([field, rewriteImageFieldValue(node[field], replace)]);
  }
  for (const { field, target } of meta.relations) {
    if (field in node) patches.push([field, rewriteRelationWrite(target, node[field], replace)]);
  }
  return withReplaced(node, patches);
}

/** 嵌套 update / updateMany：`{ where?, data }` 信封，或（对一关系）直接就是数据对象。 */
function rewriteUpdateEnvelope(target: string, node: unknown, replace: Replace): unknown {
  if (Array.isArray(node)) return mapCow(node, (el) => rewriteUpdateEnvelope(target, el, replace));
  if (!isPlainObject(node)) return node;
  const meta = MODEL_META.get(target);
  const looksLikeEnvelope =
    'data' in node && isPlainObject(node.data) && ('where' in node || !(meta?.hasScalarNamedData ?? false));
  if (looksLikeEnvelope) {
    return withReplaced(node, [['data', rewriteModelData(target, node.data, replace)]]);
  }
  return rewriteModelData(target, node, replace);
}

/** 嵌套 upsert：`{ where, create, update }`（数组或单个）。 */
function rewriteUpsertEnvelope(target: string, node: unknown, replace: Replace): unknown {
  if (Array.isArray(node)) return mapCow(node, (el) => rewriteUpsertEnvelope(target, el, replace));
  if (!isPlainObject(node)) return node;
  const patches: Array<[string, unknown]> = [];
  if ('create' in node) patches.push(['create', rewriteModelData(target, node.create, replace)]);
  if ('update' in node) patches.push(['update', rewriteModelData(target, node.update, replace)]);
  return withReplaced(node, patches);
}

/** 嵌套 connectOrCreate：`{ where, create }`（数组或单个）。 */
function rewriteConnectOrCreate(target: string, node: unknown, replace: Replace): unknown {
  if (Array.isArray(node)) return mapCow(node, (el) => rewriteConnectOrCreate(target, el, replace));
  if (!isPlainObject(node) || !('create' in node)) return node;
  return withReplaced(node, [['create', rewriteModelData(target, node.create, replace)]]);
}

/** 嵌套 createMany：`{ data, skipDuplicates? }`。 */
function rewriteCreateMany(target: string, node: unknown, replace: Replace): unknown {
  if (!isPlainObject(node) || !('data' in node)) return node;
  return withReplaced(node, [['data', rewriteModelData(target, node.data, replace)]]);
}

/** 关系字段的写入信封：create / createMany / update / updateMany / upsert / connectOrCreate。 */
function rewriteRelationWrite(target: string, envelope: unknown, replace: Replace): unknown {
  if (!isPlainObject(envelope)) return envelope;
  const patches: Array<[string, unknown]> = [];
  if ('create' in envelope) patches.push(['create', rewriteModelData(target, envelope.create, replace)]);
  if ('createMany' in envelope) {
    patches.push(['createMany', rewriteCreateMany(target, envelope.createMany, replace)]);
  }
  if ('update' in envelope) patches.push(['update', rewriteUpdateEnvelope(target, envelope.update, replace)]);
  if ('updateMany' in envelope) {
    patches.push(['updateMany', rewriteUpdateEnvelope(target, envelope.updateMany, replace)]);
  }
  if ('upsert' in envelope) patches.push(['upsert', rewriteUpsertEnvelope(target, envelope.upsert, replace)]);
  if ('connectOrCreate' in envelope) {
    patches.push(['connectOrCreate', rewriteConnectOrCreate(target, envelope.connectOrCreate, replace)]);
  }
  return withReplaced(envelope, patches);
}

/**
 * 顶层写入 args：create/update/createMany/updateMany/createManyAndReturn 的 `data`，
 * upsert 的 `create` + `update`。`where` / `select` / `include` 一概不碰（CAS 条件里的旧值不能被改写）。
 */
export function rewriteWriteArgs(model: string, args: unknown, replace: Replace): unknown {
  if (!isPlainObject(args)) return args;
  const patches: Array<[string, unknown]> = [];
  if ('data' in args) patches.push(['data', rewriteModelData(model, args.data, replace)]);
  if ('create' in args) patches.push(['create', rewriteModelData(model, args.create, replace)]);
  if ('update' in args) patches.push(['update', rewriteModelData(model, args.update, replace)]);
  return withReplaced(args, patches);
}

// ── 读出树（查询结果，含 include / select 带出的嵌套关系）───────────────────────────────

export function rewriteReadResult(model: string, result: unknown, replace: Replace): unknown {
  if (Array.isArray(result)) return mapCow(result, (el) => rewriteReadResult(model, el, replace));
  if (!isPlainObject(result)) return result;
  const meta = MODEL_META.get(model);
  if (!meta) return result;
  const patches: Array<[string, unknown]> = [];
  for (const field of meta.imageFields) {
    if (field in result) patches.push([field, rewriteImageFieldValue(result[field], replace)]);
  }
  for (const { field, target } of meta.relations) {
    if (field in result) patches.push([field, rewriteReadResult(target, result[field], replace)]);
  }
  return withReplaced(result, patches);
}

// ── 异步编排：先同步收集要转的值，逐个转换（有限并发），再同步回填 ───────────────────────

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const lane = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function transformTree(
  walk: (replace: Replace) => unknown,
  pick: (value: string) => boolean,
  convert: (value: string) => Promise<string>,
): Promise<unknown> {
  const found = new Set<string>();
  const untouched = walk((v) => {
    if (pick(v)) found.add(v);
    return null;
  });
  if (found.size === 0) return untouched;
  const mapping = new Map<string, string>();
  await mapLimit([...found], BLOB_IO_CONCURRENCY, async (v) => {
    mapping.set(v, await convert(v));
  });
  return walk((v) => mapping.get(v) ?? null);
}

/** 写入 args 里的 data URL 全部换成 blob 引用（转不了的保留原值，见 internImageValue）。 */
export function internWriteArgs(model: string, args: unknown, store: BlobStore): Promise<unknown> {
  return transformTree(
    (replace) => rewriteWriteArgs(model, args, replace),
    isImageDataUrl,
    (v) => internImageValue(v, store),
  );
}

/** 查询结果里的 blob 引用全部换回 data URL（读不到的保留引用，见 materializeImageValue）。 */
export function materializeReadResult(model: string, result: unknown, store: BlobStore): Promise<unknown> {
  return transformTree(
    (replace) => rewriteReadResult(model, result, replace),
    isBlobRef,
    (v) => materializeImageValue(v, store),
  );
}

/** 钩子处理函数的形参（与 Prisma 的 $allOperations 回调同形，单测直接调它）。 */
export interface ImageBlobHookParams {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/**
 * 扩展的配置对象（name + query 钩子）。单独导出是为了单测能拿到钩子处理函数直接调：
 * Prisma.defineExtension 传对象进去返回的是 `(client) => client.$extends(obj)` 函数，包一层就摸不到了。
 */
export function imageBlobExtensionConfig(opts: { store?: BlobStore } = {}) {
  const storeOf = () => opts.store ?? getBlobStore();
  return {
    name: 'image-blob-offload',
    query: {
      $allModels: {
        async $allOperations({ model, args, query }: ImageBlobHookParams): Promise<unknown> {
          if (!modelTouchesImages(model)) return query(args);
          const nextArgs = await internWriteArgs(model, args, storeOf());
          const result = await query(nextArgs);
          return materializeReadResult(model, result, storeOf());
        },
      },
    },
  };
}

/** 建扩展（挂到客户端：`client.$extends(createImageBlobExtension())`）；store 可注入（测试用临时目录）。 */
export function createImageBlobExtension(opts: { store?: BlobStore } = {}) {
  return Prisma.defineExtension(imageBlobExtensionConfig(opts));
}
