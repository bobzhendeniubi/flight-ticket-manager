/**
 * 拉丁乘客姓名规范化 —— 实现已搬进 @ftm/contracts
 *（packages/contracts/src/lib/passenger-name.ts）。
 *
 * 为什么搬：admin-web 早就手抄了一份（src/lib/passengerName.ts），录单弹窗与后端
 * 校验各按各的抄本走，姓名格式这种「入库前必须归一」的东西经不起两份口径。
 *
 * 这里留一个 re-export 壳子，让既有的相对路径 import 全部继续可用。新代码直接写
 * `import … from '@ftm/contracts/lib/passenger-name'` 即可。
 */
export * from '@ftm/contracts/lib/passenger-name';
