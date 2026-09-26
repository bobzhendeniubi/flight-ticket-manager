import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { env } from '../config/env.js';
import { errorMessageForLog } from '../lib/request-failure-log.js';
import { createImageBlobExtension } from './image-blob-extension.js';

/**
 * Prisma 自己的日志改成事件、由这里记一行。默认的 console 输出会把整段报错原样打进容器日志——
 * 校验错误还会渲染全部调用参数（证件号、姓名、整张护照照片的 base64）。这里只留首行 + 末行原因、
 * 去令牌、遮证件号、≤200 字（与请求失败日志同一口径，见 lib/request-failure-log.ts）。
 * 请求里的查询失败照旧由错误处理器按请求记失败日志；这一行兜住 worker / 定时任务里的查询失败。
 * 级别与此前一致：开发环境 warn + error，其余只记 error。
 */
const prismaLog = pino({ name: 'prisma', level: env.NODE_ENV === 'development' ? 'warn' : 'error' });

const baseClient = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});
// 挂在底层客户端上：经下面图片出库扩展执行的查询，报错事件同样由它发出（已实测）
baseClient.$on('error', (e) => prismaLog.error({ target: e.target }, errorMessageForLog(new Error(e.message))));
baseClient.$on('warn', (e) => prismaLog.warn({ target: e.target }, errorMessageForLog(new Error(e.message))));

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
