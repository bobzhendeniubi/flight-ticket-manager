/**
 * 前台展示文案常量（真实内容，非示例数据）。
 */

// ── 岘港景点亮点（首页展示） ─────────────────────────────────────
export interface DanangHighlight {
  emoji: string;
  title: string;
  description: string;
  tag: string;
}

export const DANANG_HIGHLIGHTS: DanangHighlight[] = [
  {
    emoji: '🏖️',
    title: '美溪海滩',
    description: '被《福布斯》评为世界六大最美海滩之一，白沙细腻，适合冲浪和日落散步。',
    tag: '亲子 / 情侣',
  },
  {
    emoji: '🌉',
    title: '巴拿山 · 佛手黄金桥',
    description: '海拔 1487 米的法国小镇 + 网红佛手托桥，世界最长单线缆车直达。',
    tag: '网红打卡',
  },
  {
    emoji: '🏮',
    title: '会安古城',
    description: 'UNESCO 世界文化遗产，千盏灯笼点亮的夜色古镇，距岘港 30 公里。',
    tag: '文化古镇',
  },
  {
    emoji: '🌊',
    title: '山茶半岛',
    description: '林木葱郁的半岛，洲际酒店独占海湾，俯瞰岘港全景的最佳观景点。',
    tag: '自然秘境',
  },
];
