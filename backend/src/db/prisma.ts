import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { createImageBlobExtension } from './image-blob-extension.js';

const prismaLogLevels =
  env.NODE_ENV === 'development' ? (['warn', 'error'] as const) : (['error'] as const);

const baseClient = new PrismaClient({
  log: [...prismaLogLevels],
});

/**
 * 全站共用的客户端：挂了图片出库扩展（db/image-blob-extension.ts）——
 * 写入时 data URL → blob 引用、读出时引用 → data URL，业务代码与前端契约都不用感知。
 *
 * 类型仍标成 PrismaClient：$extends 后的类型与全站 `client: PrismaClient` 形参、
 * `Prisma.TransactionClient` 不兼容；扩展只改查询行为、不改任何模型类型，运行时对象同构
 * （不再提供的只有 $use / $on，仓库里没人用）。
 */
export const prisma = baseClient.$extends(createImageBlobExtension()) as unknown as PrismaClient;

/**
 * **不带**图片出库扩展的原生客户端：只给存量回填 CLI / worker 兜底清扫用 —— 它们要看见列里
 * 的真实引用、拿旧值做 CAS。业务代码一律用上面的 prisma，不要碰这个。
 */
export const rawPrisma: PrismaClient = baseClient;

export async function disconnectPrisma(): Promise<void> {
  await baseClient.$disconnect();
}
