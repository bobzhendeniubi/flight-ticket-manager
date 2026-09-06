/**
 * 公司业务日（上海时区）口径 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/business-time.ts）。
 *
 * 为什么搬：「今天算哪一天」这件事导出、报表、提醒、前端列表都要用，四端各建一份
 * helper 就是四份口径。搬进契约包之后是同一份。
 *
 * 这里留一个 re-export 壳子，让既有的相对路径 import 全部继续可用。新代码直接写
 * `import … from '@ftm/contracts/lib/business-time'` 即可。
 */
export * from '@ftm/contracts/lib/business-time';
