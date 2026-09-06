/**
 * 国籍三位码 → 两位码查表 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/country-codes.ts）。
 *
 * 为什么搬：录单粘贴名单时前端先解析一遍、后端再校验一遍，两边认的国籍码表必须
 * 是同一张，否则会出现「前端收得进、后端退回来」。
 *
 * 这里留一个 re-export 壳子，让既有的相对路径 import 继续可用。新代码直接写
 * `import … from '@ftm/contracts/lib/country-codes'` 即可。
 */
export * from '@ftm/contracts/lib/country-codes';
