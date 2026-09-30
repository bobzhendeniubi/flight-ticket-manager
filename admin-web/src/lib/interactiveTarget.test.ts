/**
 * lib/interactiveTarget · 标题栏拖动起手判定回归。
 * 回归点：护照查看器标题栏兼作拖动把手，按下时无条件 capture 指针，导致栏内按钮全部点不动。
 */
import { describe, it, expect } from 'vitest';
import { isInteractiveTarget } from './interactiveTarget';

/** 模拟 Element.closest：命中时返回一个对象，否则 null。 */
function fakeEl(matches: boolean): EventTarget {
  return { closest: () => (matches ? {} : null) } as unknown as EventTarget;
}

describe('isInteractiveTarget', () => {
  it('按在按钮/链接等控件（或其内部图标）上时判为交互控件', () => {
    expect(isInteractiveTarget(fakeEl(true))).toBe(true);
  });

  it('按在标题文字等非控件区域时不是交互控件，允许进入拖动', () => {
    expect(isInteractiveTarget(fakeEl(false))).toBe(false);
  });

  it('null 或不带 closest 的目标（如 window/document）不是交互控件', () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget({} as EventTarget)).toBe(false);
  });

  it('选择器覆盖常见控件', () => {
    const seen: string[] = [];
    isInteractiveTarget({
      closest: (s: string) => {
        seen.push(s);
        return null;
      },
    } as unknown as EventTarget);
    for (const tag of ['button', 'a[href]', 'input', 'select', 'textarea']) {
      expect(seen[0]).toContain(tag);
    }
  });
});
