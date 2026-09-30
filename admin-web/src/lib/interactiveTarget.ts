/**
 * 「按下点是不是交互控件」判定。
 *
 * 浮动面板的标题栏兼作拖动把手时，按下事件里 preventDefault + setPointerCapture 会把后续
 * pointerup/click 都派给标题栏本身——落在标题栏里的按钮、链接因此永远收不到 click。
 * 拖动起手前先用它判断：按在控件上就放行给控件自己处理，只有按在空白/标题文字上才进入拖动。
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, label, summary, [role="button"], [contenteditable="true"]';

/** 鸭子类型而非 instanceof Element：单测跑在 node 环境（无 DOM 全局），传入带 closest 的桩对象即可。 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(INTERACTIVE_SELECTOR) !== null;
}
