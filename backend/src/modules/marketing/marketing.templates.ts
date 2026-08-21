/**
 * 航线海报模板与整图生图提示词构造（纯函数，无 IO）。
 *
 * 三套版式只提供背景风格；航班事实由系统填入，运营话术由表单填入，最终交给生图模型直接绘制整张海报。
 * 品牌描述来自 airline-brands.ts，未知航司不猜品牌，只要求模型绘制通用白色客机。
 */
import { findAirlineBrand, type AirlineBrand } from './airline-brands.js';

export interface PosterTemplate {
  key: string;
  /** 后台下拉里显示的名字。 */
  label: string;
  /** 一句话说明这套版式适合什么场景。 */
  hint: string;
  /** 只描述背景风格，不包含航班事实或版面文字。 */
  style: string;
}

export interface PosterLegContent {
  flightNumber: string;
  route: string;
  time: string;
}

/** 交给整图生图模板的内容；航段字段是系统事实，其他字段是运营话术。 */
export interface PosterContent {
  headline: string;
  subtitle: string;
  slogan: string;
  highlights: string[];
  ctaLine1: string;
  ctaLine2: string;
  baggageText: string | null;
  outbound: PosterLegContent;
  inbound: PosterLegContent | null;
}

export const POSTER_TEMPLATES = [
  {
    key: 'OCEAN_GOLD',
    label: '深蓝鎏金 · 商务',
    hint: '正式、有分量，适合新航线开航、包机首发这类通告',
    style:
      '深蓝色渐变天空，底部为海滩日落的金色海面与棕榈树剪影，顶部光线开阔，' +
      '整体高端商务航空风格，光影层次丰富，质感厚重。',
  },
  {
    key: 'SUNNY_TROPICAL',
    label: '明亮海岛 · 度假',
    hint: '轻快、有度假感，适合日常促销和朋友圈转发',
    style:
      '明亮通透的热带海岛风格，蓝绿色海水与白色沙滩，晴朗天空与椰林，' +
      '整体清爽活泼，饱和度高，阳光充足。',
  },
  {
    key: 'MINIMAL_EDITORIAL',
    label: '简约杂志 · 克制',
    hint: '干净、信息优先，适合发给代理看时刻',
    style:
      '简约杂志背景风格，暖沙色与深墨绿配色，背景为柔和的海岸线远景虚化，' +
      '整体安静、精致、具有高级编辑感。',
  },
] as const satisfies readonly PosterTemplate[];

export type PosterTemplateKey = (typeof POSTER_TEMPLATES)[number]['key'];

/** 供 schema 使用的模板 key，始终从实际模板清单派生。 */
export const POSTER_TEMPLATE_KEYS = POSTER_TEMPLATES.map(
  (template) => template.key,
) as [PosterTemplateKey, ...PosterTemplateKey[]];

export function isPosterTemplateKey(value: string): value is PosterTemplateKey {
  return POSTER_TEMPLATES.some((template) => template.key === value);
}

export function findTemplate(key: string): PosterTemplate {
  return POSTER_TEMPLATES.find((template) => template.key === key) ?? POSTER_TEMPLATES[0];
}

function optionalLine(label: string, value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? `【${label}】「${trimmed}」` : null;
}

function legText(leg: PosterLegContent): string {
  return `「航班号 ${leg.flightNumber}」「${leg.route}」「${leg.time}」`;
}

function buildBrandLines(brand: AirlineBrand | null): string[] {
  if (!brand) {
    return ['【顶部】一架没有任何品牌标志和文字的通用白色客机在飞行，机身为纯白色。'];
  }
  return [
    `【顶部品牌标志】${brand.logoPrompt}`,
    `标志下方一行是中文「${brand.nameZh}」。`,
    `标志下面是一架白色客机在飞行，${brand.liveryPrompt}`,
  ];
}

function buildCardLines(content: PosterContent): string {
  if (!content.inbound) {
    return `【一张居中的白色信息卡】写：${legText(content.outbound)}。`;
  }
  return `【两张白色信息卡】左卡：${legText(content.outbound)}；右卡：${legText(content.inbound)}。`;
}

/** 拼装整张航线海报提示词；任何为空的话术行都会被整个省略。 */
export function buildFlightRoutePrompt(
  templateKey: string,
  content: PosterContent,
  brand: AirlineBrand | null = findAirlineBrand(content.outbound.flightNumber),
): string {
  const template = findTemplate(templateKey);
  const lines: string[] = [
    '生成一张航空公司航线宣传海报，竖版 3:4，中文排版，设计精美专业。',
    '',
    ...buildBrandLines(brand),
  ];

  for (const line of [
    optionalLine('主标题', content.headline),
    optionalLine('副标题', content.subtitle),
    optionalLine('标语', content.slogan),
  ]) {
    if (line) lines.push(line);
  }

  const highlights = content.highlights.map((highlight) => highlight.trim()).filter(Boolean);
  if (highlights.length > 0) {
    lines.push(`【三个并排金色圆角卡片】分别写：${highlights.map((item) => `「${item}」`).join('')}`);
  }

  lines.push(buildCardLines(content));

  const footerLines = [content.ctaLine1, content.ctaLine2]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => `「${value}」`);
  if (content.baggageText?.trim()) {
    footerLines.push(`最下方小字「免费托运行李：${content.baggageText.trim()}」`);
  }
  if (footerLines.length > 0) lines.push(`【底部】${footerLines.join('')}`);

  lines.push(
    `【背景】${template.style}`,
    '所有中文与数字必须逐字符准确渲染，不得改动、不得出现错别字或乱码。整体高端商务航空风格。',
    '',
    '【严格禁止】不得添加任何上述内容之外的信息，尤其不得自行计算或标注飞行时长、票价、机型、座位数等未给出的数据。',
  );

  return lines.join('\n');
}
