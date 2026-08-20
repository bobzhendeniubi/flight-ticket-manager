/**
 * 海报版式 + 纯背景生图提示词构造（纯函数，无 IO）。
 *
 * 生图模型只接受风格与构图要求，不接受航班号、时刻、生效日期等硬数据。
 * 所有文字都由 marketing.compose 使用事实快照绘制。
 *
 * 品牌口径：对外露出一律用前台品牌，法律主体名不进海报。
 */
export interface PosterTemplate {
  key: string;
  /** 后台下拉里显示的名字 */
  label: string;
  /** 一句话说明这套版式适合什么场景 */
  hint: string;
  /** 风格半提示词 */
  style: string;
}

export const POSTER_TEMPLATES = [
  {
    key: 'OCEAN_GOLD',
    label: '深蓝鎏金 · 商务',
    hint: '正式、有分量，适合新航线开航、包机首发这类通告',
    style:
      '深蓝色渐变天空，底部为海滩日落的金色海面与棕榈树剪影，' +
      '顶部保留开阔天空，中部保留低对比度深蓝区域，整体高端商务航空风格，' +
      '光影层次丰富，质感厚重。',
  },
  {
    key: 'SUNNY_TROPICAL',
    label: '明亮海岛 · 度假',
    hint: '轻快、有度假感，适合日常促销和朋友圈转发',
    style:
      '明亮通透的热带海岛风格，蓝绿色海水与白色沙滩，晴朗天空与椰林，' +
      '顶部天空留白，中部使用柔和低对比度海面，' +
      '整体清爽活泼，饱和度高，阳光充足。',
  },
  {
    key: 'MINIMAL_EDITORIAL',
    label: '简约杂志 · 克制',
    hint: '干净、信息优先，适合发给代理看时刻',
    style:
      '简约杂志背景风格，大面积留白，克制的暖沙色与深墨绿配色，' +
      '背景为柔和的海岸线远景虚化，顶部和中部都保留干净低对比度区域，' +
      '整体安静、精致、适合服务端信息排版。',
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
  return POSTER_TEMPLATES.find((t) => t.key === key) ?? POSTER_TEMPLATES[0];
}

/** 拼航线海报的纯背景生图提示词。任何事实值都不进入模型请求。 */
export function buildFlightRoutePrompt(
  templateKey: string,
): string {
  const t = findTemplate(templateKey);
  const lines: string[] = [
    '生成一张航空旅行宣传海报的纯背景图，尺寸 1080×1440，竖版 3:4 构图。',
    '',
    '【画面风格】',
    t.style,
  ];

  lines.push(
    '',
    '【硬性禁止】画面中不得出现任何文字、汉字、字母、数字、航班号、日期、标志、logo、' +
      '图标、二维码、伪文字、乱码或水印。',
    '必须是无字背景图：顶部保留干净天空留白，中部保留适合叠加信息卡的低对比度区域，' +
      '不要自行设计排版、卡片或文字。',
  );

  return lines.join('\n');
}
