/**
 * Prisma 图片出库扩展 · 单元测试（不连库：直接调 args / 结果重写函数 + 扩展的钩子处理函数）。
 *   - DMMF 守卫：passportPhotoUrl / proofUrl 这两个列名在全 schema 里只出现在 IMAGE_COLUMNS 登记的模型上
 *     （钩子按列名识别图片列，别的模型将来若加同名列必须同步登记）
 *   - 写：顶层 data / create / update；嵌套 create / createMany / update（信封 & 对一直写）/ updateMany /
 *         upsert / connectOrCreate；`{ set }` 算子；where 不动；Json 列里同名键不动；copy-on-write
 *   - 读：任意深度 include / select 结果里的引用 → data URL；缺失 blob 保留引用
 *   - 钩子端到端：args 进钩子前转成引用、query 结果出钩子后转回 data URL
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { createLocalBlobStore, sha256Hex, type BlobStore } from '../lib/blob-store.js';
import { makeBlobRef, toImageDataUrl } from '../lib/image-ref.js';
import {
  IMAGE_COLUMNS,
  createImageBlobExtension,
  imageBlobExtensionConfig,
  internWriteArgs,
  materializeReadResult,
  modelTouchesImages,
  rewriteReadResult,
  rewriteWriteArgs,
  type ImageBlobHookParams,
} from './image-blob-extension.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const PNG_URL = toImageDataUrl(PNG_1PX, 'image/png');
const JPEG_URL = toImageDataUrl(JPEG_FAKE, 'image/jpeg');
const PNG_REF = makeBlobRef(sha256Hex(PNG_1PX), 'image/png');
const JPEG_REF = makeBlobRef(sha256Hex(JPEG_FAKE), 'image/jpeg');

/** 同步替换器：data URL → 标记串，便于断言「哪里被换了、哪里没换」 */
const MARK = (v: string) => (v.startsWith('data:') ? `<${v.length}>` : null);

let root: string;
let store: BlobStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ftm-ext-'));
  store = createLocalBlobStore(root);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('DMMF 守卫', () => {
  it('图片列名在全 schema 里只出现在 IMAGE_COLUMNS 登记的模型上', () => {
    const imageFieldNames = new Set(Object.values(IMAGE_COLUMNS).flat());
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        if (field.kind === 'object' || !imageFieldNames.has(field.name)) continue;
        expect(
          IMAGE_COLUMNS[model.name] ?? [],
          `${model.name}.${field.name} 是图片列名却没登记进 IMAGE_COLUMNS`,
        ).toContain(field.name);
      }
    }
  });

  it('登记的模型 / 列真实存在于 schema', () => {
    for (const [model, fields] of Object.entries(IMAGE_COLUMNS)) {
      const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
      expect(m, `模型 ${model} 不存在`).toBeDefined();
      for (const f of fields) {
        expect(m!.fields.some((x) => x.name === f && x.kind === 'scalar' && x.type === 'String')).toBe(true);
      }
    }
  });

  it('能通向图片列、又有名为 data 的标量列的模型，不被任何对一关系指向（嵌套 update 信封判别的前提）', () => {
    // rewriteUpdateEnvelope 靠「有没有 where / 目标模型有没有叫 data 的标量列」区分 `{ where?, data }` 信封与
    // 对一关系直接写的数据对象。某模型若既有标量 data、又被对一关系指向、还能通向图片列，就可能把真实数据
    // 当成信封（或反之）而漏转图片——改 schema 撞上这条时先回头改 image-blob-extension.ts。
    const models = Prisma.dmmf.datamodel.models;
    const risky = new Set(
      models
        .filter((m) => modelTouchesImages(m.name) && m.fields.some((f) => f.kind !== 'object' && f.name === 'data'))
        .map((m) => m.name),
    );
    const offenders = models.flatMap((m) =>
      m.fields
        .filter((f) => f.kind === 'object' && !f.isList && risky.has(f.type))
        .map((f) => `${m.name}.${f.name} → ${f.type}`),
    );
    expect(offenders).toEqual([]);
  });

  it('modelTouchesImages：图片模型及能通向它们的模型 true；孤立模型 false', () => {
    expect(modelTouchesImages('Passenger')).toBe(true);
    expect(modelTouchesImages('Order')).toBe(true);
    expect(modelTouchesImages('OrderItem')).toBe(true);
    const isolated = Prisma.dmmf.datamodel.models.find(
      (m) => !(m.name in IMAGE_COLUMNS) && m.fields.every((f) => f.kind !== 'object'),
    );
    expect(isolated, 'schema 里应至少有一个无关系的模型用来验证直通').toBeDefined();
    expect(modelTouchesImages(isolated!.name)).toBe(false);
    expect(modelTouchesImages('NoSuchModel')).toBe(false);
  });
});

describe('rewriteWriteArgs · 写入树', () => {
  it('顶层 create data 的图片列被换；非图片列与 where/select/include 不动', () => {
    const args = {
      data: { fullName: 'A', passportPhotoUrl: PNG_URL, chineseName: 'data:看起来像但不是图片列' },
      select: { passportPhotoUrl: true },
    };
    const out = rewriteWriteArgs('Passenger', args, MARK) as typeof args;
    expect(out.data.passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(out.data.chineseName).toBe('data:看起来像但不是图片列');
    expect(out.data.fullName).toBe('A');
    expect(out.select).toBe(args.select);
    expect(args.data.passportPhotoUrl).toBe(PNG_URL); // 不改原对象
  });

  it('order.create 嵌套 passengers.create[] / payments.create 全部换', () => {
    const args = {
      data: {
        orderNumber: 'X',
        passengers: {
          create: [
            { fullName: 'A', passportPhotoUrl: PNG_URL },
            { fullName: 'B', passportPhotoUrl: null },
            { fullName: 'C' },
          ],
        },
        payments: { create: { amount: 1, proofUrl: JPEG_URL } },
      },
    };
    const out = rewriteWriteArgs('Order', args, MARK) as typeof args;
    expect(out.data.passengers.create[0].passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(out.data.passengers.create[1].passportPhotoUrl).toBeNull();
    expect(out.data.passengers.create[2]).toBe(args.data.passengers.create[2]); // 没动的元素保持同引用
    expect(out.data.payments.create.proofUrl).toBe(`<${JPEG_URL.length}>`);
  });

  it('嵌套 createMany.data / updateMany / upsert / connectOrCreate / update 信封与对一直写', () => {
    const args = {
      data: {
        passengers: {
          createMany: { data: [{ passportPhotoUrl: PNG_URL }, { passportPhotoUrl: 'https://x/y.jpg' }] },
          updateMany: [{ where: { id: 'p1', passportPhotoUrl: PNG_URL }, data: { passportPhotoUrl: JPEG_URL } }],
          upsert: { where: { id: 'p2' }, create: { passportPhotoUrl: PNG_URL }, update: { passportPhotoUrl: JPEG_URL } },
          connectOrCreate: [{ where: { id: 'p3' }, create: { passportPhotoUrl: PNG_URL } }],
          update: { where: { id: 'p4' }, data: { passportPhotoUrl: PNG_URL } },
        },
        // 对一关系的 update 可以直接就是数据对象——用 payments.update 的这种形态模拟
        payments: { update: { proofUrl: JPEG_URL } },
      },
    };
    const out = rewriteWriteArgs('Order', args, MARK) as typeof args;
    const p = out.data.passengers;
    expect(p.createMany.data[0].passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(p.createMany.data[1].passportPhotoUrl).toBe('https://x/y.jpg');
    expect(p.updateMany[0].where.passportPhotoUrl).toBe(PNG_URL); // where 不动
    expect(p.updateMany[0].data.passportPhotoUrl).toBe(`<${JPEG_URL.length}>`);
    expect(p.upsert.create.passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(p.upsert.update.passportPhotoUrl).toBe(`<${JPEG_URL.length}>`);
    expect(p.connectOrCreate[0].create.passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(p.update.data.passportPhotoUrl).toBe(`<${PNG_URL.length}>`);
    expect(out.data.payments.update.proofUrl).toBe(`<${JPEG_URL.length}>`);
  });

  it('顶层 upsert 的 create + update、updateMany 的 data + where、`{ set }` 算子', () => {
    const upsert = { where: { id: 'x' }, create: { proofUrl: PNG_URL }, update: { proofUrl: { set: JPEG_URL } } };
    const out = rewriteWriteArgs('Payment', upsert, MARK) as typeof upsert;
    expect(out.create.proofUrl).toBe(`<${PNG_URL.length}>`);
    expect(out.update.proofUrl).toEqual({ set: `<${JPEG_URL.length}>` });

    const um = { where: { passportPhotoUrl: PNG_URL }, data: { passportPhotoUrl: JPEG_URL } };
    const out2 = rewriteWriteArgs('Passenger', um, MARK) as typeof um;
    expect(out2.where.passportPhotoUrl).toBe(PNG_URL);
    expect(out2.data.passportPhotoUrl).toBe(`<${JPEG_URL.length}>`);
  });

  it('深链：passenger.update → order.update（对一直写）→ payments.create 里的 proofUrl 也换', () => {
    const args = { data: { order: { update: { payments: { create: { proofUrl: JPEG_URL } } } } } };
    const out = rewriteWriteArgs('Passenger', args, MARK) as typeof args;
    expect(out.data.order.update.payments.create.proofUrl).toBe(`<${JPEG_URL.length}>`);
  });

  it('Json 列（gatewayPayload）里的同名键不动；copy-on-write：没东西可换时返回原 args 同引用', () => {
    const args = { data: { proofUrl: JPEG_URL, gatewayPayload: { proofUrl: PNG_URL, note: 'n' } } };
    const out = rewriteWriteArgs('Payment', args, MARK) as typeof args;
    expect(out.data.proofUrl).toBe(`<${JPEG_URL.length}>`);
    expect(out.data.gatewayPayload).toBe(args.data.gatewayPayload);
    expect(out.data.gatewayPayload.proofUrl).toBe(PNG_URL);

    const untouched = { data: { proofUrl: 'https://x/y.png', amount: 1 }, where: { id: 'p' } };
    expect(rewriteWriteArgs('Payment', untouched, MARK)).toBe(untouched);
    expect(rewriteWriteArgs('Passenger', undefined, MARK)).toBeUndefined();
  });
});

describe('rewriteReadResult · 读出树', () => {
  const REF = (v: string) => (v.startsWith('blob:sha256:') ? `[${v.slice(-10)}]` : null);

  it('findMany 结果 + include 嵌套（order.items[].order.passengers）任意深度换；非图片字符串不动', () => {
    const result = [
      {
        id: 'o1',
        orderNumber: 'blob:sha256:不是图片列',
        passengers: [{ id: 'p1', passportPhotoUrl: PNG_REF }, { id: 'p2', passportPhotoUrl: null }],
        payments: [{ id: 'pay1', proofUrl: JPEG_REF, gatewayPayload: { proofUrl: PNG_REF } }],
        items: [{ id: 'i1', order: { passengers: [{ passportPhotoUrl: JPEG_REF }] } }],
      },
    ];
    const out = rewriteReadResult('Order', result, REF) as typeof result;
    expect(out[0].orderNumber).toBe('blob:sha256:不是图片列');
    expect(out[0].passengers[0].passportPhotoUrl).toBe(`[${PNG_REF.slice(-10)}]`);
    expect(out[0].passengers[1].passportPhotoUrl).toBeNull();
    expect(out[0].payments[0].proofUrl).toBe(`[${JPEG_REF.slice(-10)}]`);
    expect(out[0].payments[0].gatewayPayload).toBe(result[0].payments[0].gatewayPayload);
    expect(out[0].items[0].order.passengers[0].passportPhotoUrl).toBe(`[${JPEG_REF.slice(-10)}]`);
    expect(result[0].passengers[0].passportPhotoUrl).toBe(PNG_REF); // 不改原结果
  });

  it('count / 数字 / null / 无图片列的结果原样直通（同引用）', () => {
    expect(rewriteReadResult('Passenger', 3, REF)).toBe(3);
    expect(rewriteReadResult('Passenger', null, REF)).toBeNull();
    const plain = { id: 'p', fullName: 'A', passportPhotoUrl: 'https://x/y.jpg' };
    expect(rewriteReadResult('Passenger', plain, REF)).toBe(plain);
  });
});

describe('internWriteArgs / materializeReadResult（异步，真存储）', () => {
  it('同一张图在 args 里出现多次只入库一次，全部换成同一引用', async () => {
    const args = {
      data: {
        passengers: { create: [{ passportPhotoUrl: PNG_URL }, { passportPhotoUrl: PNG_URL }] },
        payments: { create: { proofUrl: JPEG_URL } },
      },
    };
    const out = (await internWriteArgs('Order', args, store)) as typeof args;
    expect(out.data.passengers.create[0].passportPhotoUrl).toBe(PNG_REF);
    expect(out.data.passengers.create[1].passportPhotoUrl).toBe(PNG_REF);
    expect(out.data.payments.create.proofUrl).toBe(JPEG_REF);
    expect(await store.get(sha256Hex(PNG_1PX))).toEqual(PNG_1PX);
    expect(await store.get(sha256Hex(JPEG_FAKE))).toEqual(JPEG_FAKE);
  });

  it('转不了的 data URL 保留原值；读侧引用缺失时保留引用', async () => {
    const notImage = 'data:image/png;base64,SGVsbG8=';
    const out = (await internWriteArgs('Passenger', { data: { passportPhotoUrl: notImage } }, store)) as {
      data: { passportPhotoUrl: string };
    };
    expect(out.data.passportPhotoUrl).toBe(notImage);

    const missingRef = makeBlobRef('b'.repeat(64), 'image/jpeg');
    const read = (await materializeReadResult('Passenger', { passportPhotoUrl: missingRef }, store)) as {
      passportPhotoUrl: string;
    };
    expect(read.passportPhotoUrl).toBe(missingRef);
  });

  it('读侧：引用 → data URL', async () => {
    await store.put(PNG_1PX);
    const read = (await materializeReadResult(
      'Order',
      { passengers: [{ passportPhotoUrl: PNG_REF }] },
      store,
    )) as { passengers: Array<{ passportPhotoUrl: string }> };
    expect(read.passengers[0].passportPhotoUrl).toBe(PNG_URL);
  });
});

describe('createImageBlobExtension · 钩子端到端（假 query）', () => {
  function handlerOf(): (p: ImageBlobHookParams) => Promise<unknown> {
    return imageBlobExtensionConfig({ store }).query.$allModels.$allOperations;
  }

  it('createImageBlobExtension 产出的是可挂到客户端的扩展（defineExtension 包装成函数）', () => {
    expect(typeof createImageBlobExtension({ store })).toBe('function');
  });

  it('写：进钩子的 args 已是引用；读：query 返回的引用出钩子变 data URL', async () => {
    const handler = handlerOf();
    const seen: unknown[] = [];
    const result = await handler({
      model: 'Order',
      operation: 'create',
      args: { data: { passengers: { create: [{ passportPhotoUrl: PNG_URL }] } } },
      query: async (args) => {
        seen.push(args);
        // 模拟库返回落库后的形态（引用）
        return { id: 'o1', passengers: [{ id: 'p1', passportPhotoUrl: PNG_REF }] };
      },
    });
    const sentArgs = seen[0] as { data: { passengers: { create: Array<{ passportPhotoUrl: string }> } } };
    expect(sentArgs.data.passengers.create[0].passportPhotoUrl).toBe(PNG_REF);
    expect((result as { passengers: Array<{ passportPhotoUrl: string }> }).passengers[0].passportPhotoUrl).toBe(PNG_URL);
  });

  it('通不到图片列的模型直通：args 同引用、结果同引用，不碰存储', async () => {
    const handler = handlerOf();
    const isolated = Prisma.dmmf.datamodel.models.find(
      (m) => !(m.name in IMAGE_COLUMNS) && m.fields.every((f) => f.kind !== 'object'),
    )!;
    const args = { data: { proofUrl: PNG_URL } };
    const ret = { proofUrl: PNG_REF };
    let received: unknown;
    const result = await handler({
      model: isolated.name,
      operation: 'create',
      args,
      query: async (a) => {
        received = a;
        return ret;
      },
    });
    expect(received).toBe(args);
    expect(result).toBe(ret);
    expect(await store.exists(sha256Hex(PNG_1PX))).toBe(false);
  });
});
