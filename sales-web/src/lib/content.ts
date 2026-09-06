/**
 * 前台展示文案常量（真实内容，非示例数据）——**按目的地分组**。
 *
 * 背景：页脚、hero 轮播、关于页、首页景点卡这些营销位一直把「岘港」写死在组件里。
 * 公司第二条直飞航线在即，那时这些位置全会介绍错地方，而且要改四五个组件才改得完。
 *
 * 现在把「跟目的地走」的文案集中到 DESTINATION_CONTENT，按目的地机场码分组
 *（现役只有 DAD 一组，文案一字未改，只是搬了个家）。页面按当前航线的目的地取内容
 *（见 lib/useActiveDestination.ts），新线定下来后只需在这里加一组，组件不动。
 *
 * 与目的地无关的通用文案（一价全含、会员福利那两屏 hero，预订须知等）不进这里，
 * 留在各自原处——把它们也塞进每一组，只会逼着新线抄一遍。
 */

/** 目的地景点亮点（首页「必玩」卡片）。 */
export interface DestinationHighlight {
  emoji: string;
  title: string;
  description: string;
  tag: string;
}

/** hero 轮播里「介绍目的地」的那一屏（其余屏与目的地无关，留在 HeroCarousel）。 */
export interface DestinationHeroSlide {
  photo: string;
  /** palette 配色斜向渐变 scrim（确保白字对比度）。 */
  scrim: string;
  kickerEn: string;
  kicker: string;
  title: string;
  subtitle: string;
  chips: string[];
}

/** 一个目的地的全部营销文案。新开航线 = 在 DESTINATION_CONTENT 里加一组。 */
export interface DestinationContent {
  /** 目的地机场码（分组键）。 */
  code: string;
  /** 目的地中文名。 */
  name: string;
  /** 页脚品牌简介。 */
  footerTagline: string;
  /** 首页景点区标题。 */
  highlightsTitle: string;
  highlights: DestinationHighlight[];
  heroSlide: DestinationHeroSlide;
  /** 关于页里跟航线走的几处。 */
  about: {
    seoDescription: string;
    /** hero 徽标里的航线短语。 */
    routeBadge: string;
    /** 「专注一条线」那张卡的正文。 */
    focusReasonDesc: string;
    /** 信任块「主营线路」的值。 */
    mainRouteValue: string;
    /** 品牌故事第一段。 */
    storyLead: string;
  };
}

export const DESTINATION_CONTENT: Record<string, DestinationContent> = {
  DAD: {
    code: 'DAD',
    name: '岘港',
    footerTagline:
      '澳门⇌岘港海岛专线，机票 + 酒店 + 签证 + 地面服务一价全包。中文客服全程在线，让海岛度假省心又省钱。',
    highlightsTitle: '岘港必玩',
    highlights: [
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
    ],
    heroSlide: {
      // 美溪海滩 My Khe — 碧蓝海水 + 白沙
      photo: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=1600&h=720&fit=crop',
      scrim:
        'linear-gradient(105deg, rgba(10,110,128,.78) 0%, rgba(14,138,160,.55) 46%, rgba(25,184,201,.28) 100%)',
      kickerEn: 'COCO HOLIDAY · DA NANG',
      kicker: '澳门出发 · 岘港专线',
      title: '说走就走的海岛假期',
      subtitle: '澳门 ↔ 岘港每日直飞 1h45m，落地就是海。机票 · 酒店 · 签证 · 接送，一次订齐。',
      chips: ['美溪海滩', '巴拿山金桥', '会安古城'],
    },
    about: {
      seoDescription:
        '椰岛假期 · Coco Holiday — 澳门⇌岘港海岛专线，专注机票+酒店+签证+地面服务一价全包的海岛度假。',
      routeBadge: '澳门 ⇌ 岘港 海岛专线',
      focusReasonDesc:
        '只做澳门⇌岘港海岛专线，对航班、酒店、签证流程熟门熟路，能给到更贴合的行程建议。',
      mainRouteValue: '澳门 ⇌ 岘港海岛专线',
      storyLead:
        '椰岛假期（Coco Holiday）专注澳门⇌岘港海岛专线，为出行者提供机票 + 酒店 + 签证 + 地面服务的一站式打包预订。相比东拼西凑地分别预订，我们用一个套餐价覆盖整段行程，省下比价和协调的精力。',
    },
  },
};

/**
 * 兜底目的地：后端航线还没拉到、或拉到的目的地在这里还没配内容时用它。
 * 之所以敢兜底：这是营销文案，兜错顶多是「介绍了另一个目的地」，不影响价钱和库存；
 * 库存 / 定价类的航线派生一律不兜底（见 lib/bundleRoute.ts）。
 */
export const DEFAULT_DESTINATION_CODE = 'DAD';

/** 按目的地码取营销文案；没有对应分组时退回兜底目的地。 */
export function getDestinationContent(code: string | null | undefined): DestinationContent {
  const key = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return DESTINATION_CONTENT[key] ?? DESTINATION_CONTENT[DEFAULT_DESTINATION_CODE];
}

/** 已配好营销文案的目的地码（加了一组，这里自动多一个）。 */
export function destinationsWithContent(): string[] {
  return Object.keys(DESTINATION_CONTENT);
}
