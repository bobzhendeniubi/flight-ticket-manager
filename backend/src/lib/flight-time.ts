/**
 * 航班时刻的时区换算内核 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/flight-time.ts）。
 *
 * 为什么搬：这类纯函数既是后端校验/展示的一部分，也是前端要复用的同一口径
 *（admin-web 与 sales-web 各抄过一份机场时区表与姓名规范化，抄本迟早跟正本分家）。
 * 搬过去之后两边 import 的是同一份实现，不再有「谁跟谁对齐」的问题。
 *
 * 这里留一个 re-export 壳子，是为了让既有的相对路径 import 全部继续可用 ——
 * 搬迁本身不该逼着二十几个调用点一起改。新代码直接写
 * `import … from '@ftm/contracts/lib/flight-time'` 即可。
 */
export * from '@ftm/contracts/lib/flight-time';
