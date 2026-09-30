import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DEFAULT_MIN_COLUMN_WIDTH } from '../hooks/useColumnWidths';

/** 键盘每按一次方向键调整的宽度（px）。 */
const KEYBOARD_STEP_PX = 16;

interface ColumnResizeHandleProps {
  /** 列名（读屏用：「调整「内容」列宽」） */
  label: string;
  /** 当前列宽（px） */
  width: number;
  min?: number;
  /** 拖动/按键时回传新宽度——只改内存 */
  onResize: (px: number) => void;
  /** 拖动松手 / 按键后落盘 */
  onCommit: () => void;
  /** 双击恢复该列默认宽 */
  onReset: () => void;
}

/**
 * 表头右缘的列宽拖柄。放在 `position: relative` 的 <th> 里、与表头文字并列，
 * **不要**套进任何按钮/可点元素——它自己用 pointer capture 接管拖动，只在自己这 10px 宽的热区里生效，
 * 按下时 stopPropagation，不会吞掉表头其它可点元素的点击，也不会误触发外层的点击排序之类。
 * 键盘：聚焦后 ← / → 每次 ±16px（立即落盘）。
 */
export function ColumnResizeHandle({
  label,
  width,
  min = DEFAULT_MIN_COLUMN_WIDTH,
  onResize,
  onCommit,
  onReset,
}: ColumnResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (commit) onCommit();
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 阻止默认：拖动时不选中表头文字；阻止冒泡：不触发 <th> 上可能挂的其它交互。
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
    setDragging(true);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    onResize(drag.startWidth + (e.clientX - drag.startX));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' ? KEYBOARD_STEP_PX : e.key === 'ArrowLeft' ? -KEYBOARD_STEP_PX : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    onResize(width + delta);
    onCommit();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整「${label}」列宽`}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title="拖动调整列宽，双击恢复默认；聚焦后可用 ← → 微调"
      className="group/resize absolute inset-y-0 right-0 z-[1] flex w-2.5 cursor-col-resize touch-none select-none justify-end outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, true)}
      onLostPointerCapture={(e) => endDrag(e, true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 竖线：静止时是淡灰分隔线，悬停/聚焦/拖动时横向放大 3 倍并变品牌色（只动 transform，不重排） */}
      <span
        aria-hidden
        className={`my-1.5 w-px origin-right rounded-full transition-[transform,background-color] duration-150 ${
          dragging
            ? 'scale-x-[3] bg-brand'
            : 'bg-slate-200 group-hover/resize:scale-x-[3] group-hover/resize:bg-brand/60 group-focus-visible/resize:scale-x-[3] group-focus-visible/resize:bg-brand'
        }`}
      />
    </div>
  );
}
