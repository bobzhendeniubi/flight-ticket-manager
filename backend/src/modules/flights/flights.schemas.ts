/**
 * 航班 / 班次维护与座位统计的请求体与查询参数 —— 定义已搬进 @ftm/contracts（packages/contracts/src/flights.ts）。
 *
 * 校验规则一字未改：只把 z.nativeEnum(PrismaEnum) 换成契约包镜像的同值 schema
 *（枚举漂移测试守着两边一致），helper 的 import 改指契约包里的同一份实现。
 *
 * 这里留 re-export 壳子，既有 import 路径全部继续可用；前端从 @ftm/contracts
 * 取同一份类型，不再手抄。
 */
export * from '@ftm/contracts/flights';
