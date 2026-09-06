/**
 * 营销中心入参校验 —— 定义已搬进 @ftm/contracts（packages/contracts/src/marketing.ts）。
 *
 * 版式 key 清单也一并进了契约包（后台版式下拉的取值 = 请求体的枚举）；交给生图模型的
 * 提示词注册表仍留在 marketing.templates.ts，那是服务端的活儿，不进浏览器 bundle。
 *
 * 这里留 re-export 壳子，既有 import 路径继续可用。
 */
export * from '@ftm/contracts/marketing';
