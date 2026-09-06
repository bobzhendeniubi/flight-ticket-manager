/**
 * 凭证图片 data-URL 校验 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/proof-url.ts）。
 *
 * 为什么搬：这条 6MB 上限前端上传前也要知道（不然只能等后端 400 才发现太大），
 * 属于典型的「两边都要、必须同一份」的口径。
 *
 * 这里留一个 re-export 壳子，让既有的相对路径 import 全部继续可用。新代码直接写
 * `import … from '@ftm/contracts/lib/proof-url'` 即可。
 */
export * from '@ftm/contracts/lib/proof-url';
