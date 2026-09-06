/**
 * 真实 PNR / 电子票号校验内核 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/ticket-number.ts）。
 *
 * 为什么搬：票号是拿去跟航司对账的东西，单人回填、整班批量回填、以及前端贴名单
 * 时的即时提示必须认同一套「什么算合法票号」，多一套口径就是多一本账。
 *
 * 这里留一个 re-export 壳子，让既有的相对路径 import 继续可用。新代码直接写
 * `import … from '@ftm/contracts/lib/ticket-number'` 即可。
 */
export * from '@ftm/contracts/lib/ticket-number';
