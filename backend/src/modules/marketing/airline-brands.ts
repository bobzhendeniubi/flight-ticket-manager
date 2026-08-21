/**
 * 航司品牌配置。
 * 新增航司只需在此数组加一条配置，无需修改提示词或生成流程；logo 描述要写到能让模型画对的粒度，
 * 参考越竹这条的详细程度：分左右两半、给出颜色十六进制、说明各部件形状与朝向。
 */
export interface AirlineBrand {
  iataCode: string;
  nameZh: string;
  nameEn: string;
  /** logo 的准确视觉描述，直接嵌入生图提示词。必须写清构成、颜色、相对位置。 */
  logoPrompt: string;
  /** 机身涂装描述，用于要求飞机与 logo 呼应。 */
  liveryPrompt: string;
  primaryColor: string;
  accentColor: string;
}

const AIRLINE_BRANDS: readonly AirlineBrand[] = [
  {
    iataCode: 'QH',
    nameZh: '越竹航空',
    nameEn: 'BAMBOO AIRWAYS',
    logoPrompt:
      '标志左半部分是深蓝色（#073871）无衬线大写英文「BAMBOO」，其正下方是较小字号的「AIRWAYS」，' +
      '其中字母 M 中间的竖笔是草绿色；标志右半部分是一组竹叶造型图形——三片草绿色（#64AC54）的' +
      '细长竹叶向右上方斜向舒展，叶片下方衬着一片深蓝色（#045493）和一片浅蓝色（#4BBBEB）的弧形叶片。',
    liveryPrompt: '机身尾翼带有绿色竹叶与蓝色弧形叶片图案。',
    primaryColor: '#073871',
    accentColor: '#64AC54',
  },
];

/** 按 IATA 二字码查找品牌；未知航司返回 null，生成流程会改画通用白色客机。 */
export function findAirlineBrand(flightNumber: string): AirlineBrand | null {
  const iataCode = flightNumber.trim().slice(0, 2).toUpperCase();
  return AIRLINE_BRANDS.find((brand) => brand.iataCode === iataCode) ?? null;
}

export { AIRLINE_BRANDS };
