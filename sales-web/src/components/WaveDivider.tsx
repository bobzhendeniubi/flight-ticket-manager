/**
 * 波浪分隔条 —— 椰岛标志性海岛母题。
 *
 * 一条比容器宽一倍（w-[200%]）的双层波浪 SVG，横向缓慢漂移（animate-wave-drift）
 * 形成无缝循环。只动 transform，合成器友好；prefers-reduced-motion 时全局守卫会停。
 *
 * 用法：放在一个 relative 容器内（hero 底部 / 页脚顶部）。
 *  - flip：上下翻转（页脚顶部用，让波峰朝上"托住"内容）。
 *  - position：默认贴底（bottom-0），flip 时建议改贴顶（top-0）。
 * 颜色通过 fill 传入（默认暖沙色 #fbf6ee，与页面暖底融合）。
 */
export function WaveDivider({
  className = '',
  fill = '#fbf6ee',
  height = 48,
  flip = false,
  position = 'bottom',
}: {
  className?: string;
  fill?: string;
  height?: number;
  flip?: boolean;
  position?: 'top' | 'bottom';
}) {
  return (
    <div
      aria-hidden
      className={`wave-divider ${position === 'top' ? 'top-0' : 'bottom-0'} ${className}`}
      style={{ height }}
    >
      <svg
        viewBox="0 0 1440 80"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        style={flip ? { transform: 'scaleY(-1)' } : undefined}
      >
        {/* 后层波浪（淡一点，制造层次/景深） */}
        <path
          d="M0,40 C180,72 360,8 540,32 C720,56 900,80 1080,48 C1260,16 1350,28 1440,40 L1440,80 L0,80 Z"
          fill={fill}
          opacity="0.55"
        />
        {/* 前层波浪（主体） */}
        <path
          d="M0,52 C160,28 320,68 480,52 C640,36 800,20 960,44 C1120,68 1280,60 1440,44 L1440,80 L0,80 Z"
          fill={fill}
        />
      </svg>
    </div>
  );
}
