/**
 * SHARED with sales-web/src/lib/mockData.ts — keep in sync.
 * Demo-only 数据。M3-M5 前端页面直接渲染，没接后端。
 * 业务聚焦：澳门客户 → 岘港的旅行打包服务。
 * 所有金额单位：人民币 (CNY)。
 */

// ── 岘港酒店 ───────────────────────────────────────────────────────
export interface HotelRoomType {
  name: string;
  priceMult: number; // 倍率相对于 basePrice
  sleeps: number;
  bedType: string;
}

export interface MockHotel {
  id: string;
  name: string; // 中文名
  nameEn: string;
  cityCode: string; // 岘港 DAD / 会安 HOA / 巴拿山 BAN
  area: string; // 所在区域
  stars: 3 | 4 | 5;
  basePrice: number; // 每晚起
  rating: number;
  reviewCount: number;
  emoji: string;
  photo: string;
  amenities: string[];
  highlight: string;
  roomTypes: HotelRoomType[];
}

export const MOCK_HOTELS: MockHotel[] = [
  {
    id: 'h1',
    name: '岘港四季度假村',
    nameEn: 'Four Seasons Resort The Nam Hai',
    cityCode: 'DAD',
    area: '美溪海滩 / 会安之间',
    stars: 5,
    basePrice: 3280,
    rating: 4.9,
    reviewCount: 2891,
    emoji: '🏝️',
    photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=600&h=400&fit=crop',
    amenities: ['私人海滩', '全海景别墅', '3 个无边泳池', '含自助早餐', '免费班车', 'SPA'],
    highlight: '全别墅式私密度假，The Nam Hai 独家 1km 海岸线',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h2',
    name: '岘港洲际半岛度假村',
    nameEn: 'InterContinental Danang Sun Peninsula Resort',
    cityCode: 'DAD',
    area: '山茶半岛',
    stars: 5,
    basePrice: 3680,
    rating: 4.9,
    reviewCount: 3421,
    emoji: '🌊',
    photo: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=400&fit=crop',
    amenities: ['私人海湾', '缆车', '米其林餐厅 La Maison 1888', '日落无敌海景', '豪华 SPA'],
    highlight: 'Bill Bensley 设计，山茶半岛独占海湾，明星度假首选',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h3',
    name: '岘港凯悦度假村',
    nameEn: 'Hyatt Regency Danang Resort and Spa',
    cityCode: 'DAD',
    area: '美溪海滩',
    stars: 5,
    basePrice: 1880,
    rating: 4.7,
    reviewCount: 4215,
    emoji: '🏖️',
    photo: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=600&h=400&fit=crop',
    amenities: ['5 个泳池', '直通海滩', '儿童俱乐部', '含早餐', '免费机场班车'],
    highlight: '美溪海滩热门家庭首选，亲子设施完善',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h4',
    name: '岘港铂尔曼海滩度假村',
    nameEn: 'Pullman Danang Beach Resort',
    cityCode: 'DAD',
    area: '美溪海滩',
    stars: 5,
    basePrice: 1580,
    rating: 4.6,
    reviewCount: 2103,
    emoji: '🏖️',
    photo: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=600&h=400&fit=crop',
    amenities: ['私人沙滩', '无边泳池', '含早餐', '水上运动', '健身房'],
    highlight: '法式度假风，步行 3 分钟到美溪海滩',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h5',
    name: '融合玛雅全别墅度假村',
    nameEn: 'Fusion Maia Da Nang',
    cityCode: 'DAD',
    area: '非水庄海滩',
    stars: 5,
    basePrice: 2480,
    rating: 4.8,
    reviewCount: 1576,
    emoji: '💆',
    photo: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&h=400&fit=crop',
    amenities: ['每日 2 次 SPA 免费', '私人泳池别墅', '养生健康餐', '瑜伽课程'],
    highlight: '全别墅 All-SPA-Inclusive，越南养生度假代表',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h6',
    name: '岘港太阳豪庭度假村',
    nameEn: 'Sunrise Premium Resort Da Nang',
    cityCode: 'DAD',
    area: '美溪海滩',
    stars: 4,
    basePrice: 880,
    rating: 4.5,
    reviewCount: 1890,
    emoji: '🌅',
    photo: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=600&h=400&fit=crop',
    amenities: ['海滩直通', '泳池', '健身房', '含早餐'],
    highlight: '性价比之选，美溪核心段，离酒吧街 5 分钟',
    roomTypes: [
      { name: '标准双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '豪华大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床' },
      { name: '家庭房', priceMult: 1.4, sleeps: 4, bedType: '1 大床 + 2 单人床' },
    ],
  },
  {
    id: 'h7',
    name: '那曼避风港度假村',
    nameEn: 'Naman Retreat',
    cityCode: 'HOA',
    area: '会安 / 岘港之间',
    stars: 5,
    basePrice: 2180,
    rating: 4.7,
    reviewCount: 1104,
    emoji: '🌴',
    photo: 'https://images.unsplash.com/photo-1578683010236-d716f9a3f461?w=600&h=400&fit=crop',
    amenities: ['私人海滩', '全日 SPA 免费', '瑜伽', '含早餐'],
    highlight: '岘港-会安黄金地段，15 分钟到会安古城',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h8',
    name: '馨乐庭蓝湾公寓',
    nameEn: 'Citadines Blue Cove Danang',
    cityCode: 'DAD',
    area: '岘港市中心 / 韩江边',
    stars: 4,
    basePrice: 580,
    rating: 4.4,
    reviewCount: 876,
    emoji: '🏙️',
    photo: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=600&h=400&fit=crop',
    amenities: ['厨房 / 洗衣机', '韩江景观', '免费 WiFi', '靠近龙桥'],
    highlight: '市区公寓式酒店，适合长住和家庭，近龙桥',
    roomTypes: [
      { name: '标准双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '豪华大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床' },
      { name: '家庭房', priceMult: 1.4, sleeps: 4, bedType: '1 大床 + 2 单人床' },
    ],
  },
  {
    id: 'h9',
    name: '岘港 TIA Wellness 度假村',
    nameEn: 'TIA Wellness Resort',
    cityCode: 'DAD',
    area: '美溪海滩 北段',
    stars: 5,
    basePrice: 2880,
    rating: 4.8,
    reviewCount: 932,
    emoji: '🧘',
    photo: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=600&h=400&fit=crop',
    amenities: ['全日 SPA 免费', '私人泳池别墅', '养生餐', '禅修花园'],
    highlight: '越南顶级 Wellness 概念，每日 2 次免费 SPA',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h10',
    name: '岘港喜来登大酒店',
    nameEn: 'Sheraton Grand Danang Resort',
    cityCode: 'DAD',
    area: '非水庄 / 美溪南段',
    stars: 5,
    basePrice: 1680,
    rating: 4.7,
    reviewCount: 2104,
    emoji: '⭐',
    photo: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=600&h=400&fit=crop',
    amenities: ['250m 海岸线', '5 个泳池', '万豪会员积分', '含早餐'],
    highlight: '万豪集团旗下，会员积分 + 升房稳定',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h11',
    name: '岘港 Vinpearl 度假村',
    nameEn: 'Vinpearl Luxury Da Nang',
    cityCode: 'DAD',
    area: '美溪海滩 南段',
    stars: 5,
    basePrice: 1480,
    rating: 4.6,
    reviewCount: 1843,
    emoji: '🌺',
    photo: 'https://images.unsplash.com/photo-1584132967334-10e028bd69f7?w=600&h=400&fit=crop',
    amenities: ['私人沙滩', '免费班车去 Vinpearl Land', '亲子俱乐部'],
    highlight: '越南本土豪牌 Vingroup，含 Vinpearl Land 主题公园门票',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
  {
    id: 'h12',
    name: '会安水疗安岚度假村',
    nameEn: 'Anantara Hoi An Resort',
    cityCode: 'HOA',
    area: '会安古城旁',
    stars: 5,
    basePrice: 1980,
    rating: 4.8,
    reviewCount: 1267,
    emoji: '🏯',
    photo: 'https://images.unsplash.com/photo-1596178065887-1198b6148b2b?w=600&h=400&fit=crop',
    amenities: ['秋盆河景', '步行 10 分钟到古城', 'SPA', '含早餐'],
    highlight: '安岚集团 · 古城唯一河景五星，灯笼之夜步行可达',
    roomTypes: [
      { name: '豪华双床房', priceMult: 1, sleeps: 2, bedType: '2 张单人床' },
      { name: '海景大床房', priceMult: 1.15, sleeps: 2, bedType: '1 张大床 · 海景' },
      { name: '行政套房', priceMult: 1.45, sleeps: 3, bedType: '1 张大床 + 客厅' },
      { name: '别墅套房', priceMult: 1.85, sleeps: 4, bedType: '2 卧室 + 私人泳池' },
    ],
  },
];

// ── 岘港当地接送/包车 ────────────────────────────────────────────
export interface MockTransfer {
  id: string;
  name: string;
  vehicleType: string;
  capacity: number;
  basePrice: number;
  originArea: string;
  destArea: string;
  emoji: string;
  photo: string;
  features: string[];
  duration: string;
}

export const MOCK_TRANSFERS: MockTransfer[] = [
  {
    id: 't1',
    name: '岘港机场接送 · 经济轿车',
    vehicleType: '舒适型轿车（4 座）',
    capacity: 3,
    basePrice: 98,
    originArea: '岘港机场 (DAD)',
    destArea: '美溪海滩 / 市区任一酒店',
    emoji: '🚗',
    photo: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=600&h=400&fit=crop',
    features: ['含中文司机', '免费等候 60 分钟', '含儿童安全座椅', '矿泉水'],
    duration: '约 15 分钟',
  },
  {
    id: 't2',
    name: '岘港机场接送 · 7 座商务车',
    vehicleType: '7 座 MPV（如丰田 Innova）',
    capacity: 6,
    basePrice: 188,
    originArea: '岘港机场 (DAD)',
    destArea: '美溪海滩 / 山茶半岛 / 市区',
    emoji: '🚐',
    photo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=600&h=400&fit=crop',
    features: ['家庭首选', '6 大件行李空间', '中文司机', '免费等候 60 分钟'],
    duration: '约 15–30 分钟',
  },
  {
    id: 't3',
    name: '岘港 → 会安古城 专车',
    vehicleType: '舒适型轿车 / 商务车',
    capacity: 6,
    basePrice: 248,
    originArea: '岘港酒店',
    destArea: '会安古城',
    emoji: '🏮',
    photo: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=600&h=400&fit=crop',
    features: ['单程约 45 分钟', '可中途停美溪海滩拍照', '含中文司机'],
    duration: '约 45 分钟',
  },
  {
    id: 't4',
    name: '巴拿山 1 日包车',
    vehicleType: '7 座商务车',
    capacity: 6,
    basePrice: 588,
    originArea: '岘港酒店',
    destArea: '巴拿山法国小镇 + 佛手黄金桥',
    emoji: '🌉',
    photo: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=400&fit=crop',
    features: ['8 小时包车', '含门票预订代购', '含中文司机', '可加购法式小镇午餐'],
    duration: '单程约 40 分钟',
  },
  {
    id: 't5',
    name: '岘港 → 顺化故都 1 日游包车',
    vehicleType: '7 座商务车',
    capacity: 6,
    basePrice: 888,
    originArea: '岘港酒店',
    destArea: '海云岭 → 顺化皇城 → 返回',
    emoji: '🏯',
    photo: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=600&h=400&fit=crop',
    features: ['途经海云岭观景台', '包含顺化景点解说', '10 小时包车', '中文司机'],
    duration: '全程约 10 小时',
  },
  {
    id: 't6',
    name: '岘港 → 美山圣地 半日包车',
    vehicleType: '舒适型轿车 / 商务车',
    capacity: 6,
    basePrice: 488,
    originArea: '岘港酒店',
    destArea: '美山遗址（UNESCO）→ 返回',
    emoji: '🛕',
    photo: 'https://images.unsplash.com/photo-1545569341-9eb8b30979d9?w=600&h=400&fit=crop',
    features: ['UNESCO 占婆遗址', '5 小时包车', '中文司机', '含矿泉水'],
    duration: '约 5 小时',
  },
  {
    id: 't7',
    name: '岘港市内夜游包车',
    vehicleType: '舒适型轿车',
    capacity: 3,
    basePrice: 268,
    originArea: '岘港酒店',
    destArea: '龙桥 → 韩江夜景 → 山茶半岛灵应寺',
    emoji: '🌃',
    photo: 'https://images.unsplash.com/photo-1514282401047-d79a71a590e8?w=600&h=400&fit=crop',
    features: ['4 小时包车', '含中文导游', '龙桥喷火表演（周末）'],
    duration: '约 4 小时',
  },
  {
    id: 't8',
    name: '海上钓鱼半日团（含船）',
    vehicleType: '专属钓鱼快艇 + 接送',
    capacity: 6,
    basePrice: 988,
    originArea: '岘港酒店',
    destArea: '岘港湾外海',
    emoji: '🎣',
    photo: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=600&h=400&fit=crop',
    features: ['含钓具/船餐/啤酒', '渔夫教学', '英文+中文船长'],
    duration: '约 5 小时',
  },
];

// ── 签证 ──────────────────────────────────────────────────────────
export interface MockVisa {
  id: string;
  country: string;
  countryCode: string;
  flag: string;
  photo: string;
  type: string;
  processingDays: number;
  basePrice: number;
  expressSurcharge: number;
  requiredDocs: string[];
  validityMonths: number;
  highlight?: string;
}

// 以越南签证为主打，其他东南亚目的地作扩展
export const MOCK_VISAS: MockVisa[] = [
  {
    id: 'v1',
    country: '越南',
    countryCode: 'VN',
    flag: '🇻🇳',
    photo: 'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?w=600&h=400&fit=crop',
    type: '电子签证 E-visa · 30 天单次',
    processingDays: 3,
    basePrice: 280,
    expressSurcharge: 150,
    requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版'],
    validityMonths: 1,
    highlight: '最热销 · 全流程线上，我方代办',
  },
  {
    id: 'v2',
    country: '越南',
    countryCode: 'VN',
    flag: '🇻🇳',
    photo: 'https://images.unsplash.com/photo-1557750255-c76072a7fdf1?w=600&h=400&fit=crop',
    type: '电子签证 E-visa · 90 天多次',
    processingDays: 5,
    basePrice: 680,
    expressSurcharge: 300,
    requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版', '行程单'],
    validityMonths: 3,
    highlight: '适合多次往返岘港的商务旅客',
  },
  {
    id: 'v3',
    country: '越南',
    countryCode: 'VN',
    flag: '🇻🇳',
    photo: 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=600&h=400&fit=crop',
    type: '落地签批文（持护照到机场办）',
    processingDays: 2,
    basePrice: 180,
    expressSurcharge: 80,
    requiredDocs: ['护照首页扫描件'],
    validityMonths: 1,
    highlight: '最快办理，适合临时出行',
  },
  {
    id: 'v4',
    country: '越南',
    countryCode: 'VN',
    flag: '🇻🇳',
    photo: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=600&h=400&fit=crop',
    type: '商务邀请函签证（1 年多次）',
    processingDays: 10,
    basePrice: 980,
    expressSurcharge: 500,
    requiredDocs: ['护照首页扫描件', '照片', '在职证明', '越南公司邀请函'],
    validityMonths: 12,
    highlight: '需我方协助发邀请函',
  },
  {
    id: 'v5',
    country: '柬埔寨',
    countryCode: 'KH',
    flag: '🇰🇭',
    photo: 'https://images.unsplash.com/photo-1563492065599-3520f775eeed?w=600&h=400&fit=crop',
    type: '电子签证 E-visa',
    processingDays: 3,
    basePrice: 320,
    expressSurcharge: 120,
    requiredDocs: ['护照扫描件', '照片'],
    validityMonths: 3,
  },
  {
    id: 'v6',
    country: '泰国',
    countryCode: 'TH',
    flag: '🇹🇭',
    photo: 'https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=600&h=400&fit=crop',
    type: '单次旅游签证',
    processingDays: 5,
    basePrice: 280,
    expressSurcharge: 150,
    requiredDocs: ['护照原件', '2 寸白底照片', '身份证复印件', '在职证明'],
    validityMonths: 3,
  },
  {
    id: 'v7',
    country: '新加坡',
    countryCode: 'SG',
    flag: '🇸🇬',
    photo: 'https://images.unsplash.com/photo-1525625293386-3f8f99389edd?w=600&h=400&fit=crop',
    type: '电子旅游签',
    processingDays: 3,
    basePrice: 280,
    expressSurcharge: 100,
    requiredDocs: ['护照电子版', '照片电子版'],
    validityMonths: 2,
  },
  {
    id: 'v8',
    country: '老挝',
    countryCode: 'LA',
    flag: '🇱🇦',
    photo: 'https://images.unsplash.com/photo-1601040532080-8773f1c3289e?w=600&h=400&fit=crop',
    type: '落地签 / 电子签',
    processingDays: 3,
    basePrice: 260,
    expressSurcharge: 100,
    requiredDocs: ['护照扫描件', '照片'],
    validityMonths: 1,
  },
  {
    id: 'v9',
    country: '马来西亚',
    countryCode: 'MY',
    flag: '🇲🇾',
    photo: 'https://images.unsplash.com/photo-1596422846543-75c6fc197f11?w=600&h=400&fit=crop',
    type: '电子签证 eVISA',
    processingDays: 3,
    basePrice: 240,
    expressSurcharge: 80,
    requiredDocs: ['护照扫描件', '照片', '行程单'],
    validityMonths: 3,
  },
  {
    id: 'v10',
    country: '印度尼西亚',
    countryCode: 'ID',
    flag: '🇮🇩',
    photo: 'https://images.unsplash.com/photo-1537996194471-76f2285ba9a4?w=600&h=400&fit=crop',
    type: '电子落地签 e-VOA',
    processingDays: 2,
    basePrice: 280,
    expressSurcharge: 100,
    requiredDocs: ['护照扫描件'],
    validityMonths: 1,
  },
];

// ── 订单 (admin view) ────────────────────────────────────────────
export type MockOrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'TICKETED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUND_REQUESTED';

export interface MockOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  contactPhone: string;
  agentName: string | null;
  itemSummary: string;
  itemKind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'COMBO';
  total: number;
  status: MockOrderStatus;
  paymentMethod: string | null;
  createdAt: string;
  passengerCount: number;
}

export const MOCK_ORDERS: MockOrder[] = [
  {
    id: 'o1',
    orderNumber: 'FTM20260415001',
    customerName: '张伟',
    contactPhone: '+853 6234 ****',
    agentName: null,
    itemSummary: 'QH9589 澳门→岘港 · 经济舱 × 2 (来回)',
    itemKind: 'FLIGHT',
    total: 5720,
    status: 'TICKETED',
    paymentMethod: '微信支付',
    createdAt: '2026-04-14T14:23:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o2',
    orderNumber: 'FTM20260415002',
    customerName: '李娜',
    contactPhone: '+852 9012 ****',
    agentName: '澳门岘港旅游总代',
    itemSummary: 'QH9589 澳门→岘港 · 商务舱 × 1',
    itemKind: 'FLIGHT',
    total: 4380,
    status: 'PAID',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-14T16:05:00+08:00',
    passengerCount: 1,
  },
  {
    id: 'o3',
    orderNumber: 'FTM20260415003',
    customerName: '王强',
    contactPhone: '+853 6654 ****',
    agentName: null,
    itemSummary: '来回机票 + 岘港洲际半岛 3 晚',
    itemKind: 'COMBO',
    total: 16880,
    status: 'PROCESSING',
    paymentMethod: '支付宝',
    createdAt: '2026-04-15T09:12:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o4',
    orderNumber: 'FTM20260415004',
    customerName: '陈静',
    contactPhone: '+852 6023 ****',
    agentName: '澳门欢乐旅行社',
    itemSummary: '越南电子签 E-visa 30 天 × 4',
    itemKind: 'VISA',
    total: 1120,
    status: 'PROCESSING',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-15T10:48:00+08:00',
    passengerCount: 4,
  },
  {
    id: 'o5',
    orderNumber: 'FTM20260415005',
    customerName: '刘洋',
    contactPhone: '+853 6876 ****',
    agentName: null,
    itemSummary: '岘港机场接送 · 7 座商务车',
    itemKind: 'TRANSFER',
    total: 188,
    status: 'PAID',
    paymentMethod: '微信支付',
    createdAt: '2026-04-15T11:30:00+08:00',
    passengerCount: 5,
  },
  {
    id: 'o6',
    orderNumber: 'FTM20260415006',
    customerName: '黄磊',
    contactPhone: '+852 9234 ****',
    agentName: '澳门威尼斯人门店',
    itemSummary: 'QH9589 澳门→岘港 · 经济舱 × 3',
    itemKind: 'FLIGHT',
    total: 4440,
    status: 'PENDING_PAYMENT',
    paymentMethod: null,
    createdAt: '2026-04-15T12:15:00+08:00',
    passengerCount: 3,
  },
  {
    id: 'o7',
    orderNumber: 'FTM20260415007',
    customerName: '周芳',
    contactPhone: '+853 6123 ****',
    agentName: null,
    itemSummary: 'QH9588 岘港→澳门 · 经济舱 × 1',
    itemKind: 'FLIGHT',
    total: 1380,
    status: 'REFUND_REQUESTED',
    paymentMethod: '微信支付',
    createdAt: '2026-04-13T18:40:00+08:00',
    passengerCount: 1,
  },
  {
    id: 'o8',
    orderNumber: 'FTM20260415008',
    customerName: '孙悦',
    contactPhone: '+852 5432 ****',
    agentName: '澳门岘港旅游总代',
    itemSummary: '巴拿山 1 日包车 × 4',
    itemKind: 'TRANSFER',
    total: 588,
    status: 'TICKETED',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-12T14:00:00+08:00',
    passengerCount: 4,
  },
  {
    id: 'o9',
    orderNumber: 'FTM20260415009',
    customerName: '赵磊',
    contactPhone: '+853 6098 ****',
    agentName: null,
    itemSummary: '融合玛雅全别墅 5 晚',
    itemKind: 'HOTEL',
    total: 12400,
    status: 'COMPLETED',
    paymentMethod: '支付宝',
    createdAt: '2026-04-10T21:15:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o10',
    orderNumber: 'FTM20260415010',
    customerName: '吴彦',
    contactPhone: '+852 6765 ****',
    agentName: null,
    itemSummary: 'QH9589 澳门→岘港 · 商务舱 × 1',
    itemKind: 'FLIGHT',
    total: 4380,
    status: 'CANCELLED',
    paymentMethod: null,
    createdAt: '2026-04-11T10:00:00+08:00',
    passengerCount: 1,
  },
];

export const STATUS_LABEL: Record<MockOrderStatus, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款申请中',
};

export const STATUS_COLOR: Record<MockOrderStatus, string> = {
  PENDING_PAYMENT: 'bg-amber-100 text-amber-700',
  PAID: 'bg-blue-100 text-blue-700',
  PROCESSING: 'bg-indigo-100 text-indigo-700',
  TICKETED: 'bg-green-100 text-green-700',
  COMPLETED: 'bg-slate-100 text-slate-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  REFUND_REQUESTED: 'bg-red-100 text-red-700',
};

// ── 定价 (M5) ─────────────────────────────────────────────────────
export interface PricingTier {
  tier: 'A' | 'B' | 'C' | 'D';
  label: string;
  multiplier: number;
  description: string;
}

export const DEFAULT_TIERS: PricingTier[] = [
  { tier: 'A', label: 'A 等级（黄金档）', multiplier: 1.5, description: '春节/五一/国庆/中秋节假日' },
  { tier: 'B', label: 'B 等级（高峰档）', multiplier: 1.2, description: '周五周日 / 暑期旺季' },
  { tier: 'C', label: 'C 等级（平峰档）', multiplier: 1.0, description: '工作日常规时段' },
  { tier: 'D', label: 'D 等级（优惠档）', multiplier: 0.8, description: '雨季（9-11月）/淡季周二周三' },
];

export function generatePriceHistory(basePrice: number): Array<{ date: string; price: number; tier: 'A' | 'B' | 'C' | 'D' }> {
  const res: Array<{ date: string; price: number; tier: 'A' | 'B' | 'C' | 'D' }> = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    let tier: 'A' | 'B' | 'C' | 'D';
    if (dow === 5 || dow === 0) tier = 'B';
    else if (dow === 1 || dow === 6) tier = 'C';
    else tier = 'D';
    if (i === 0 || i === 7) tier = 'A';
    const multMap = { A: 1.5, B: 1.2, C: 1.0, D: 0.8 };
    const noise = 0.95 + Math.random() * 0.1;
    res.push({
      date: d.toISOString().slice(0, 10),
      price: Math.round(basePrice * multMap[tier] * noise),
      tier,
    });
  }
  return res;
}

// ── 仪表盘 KPI ─────────────────────────────────────────────────────
export const DASHBOARD_KPIS = {
  todayRevenue: 148540,
  todayOrders: 52,
  pendingOrders: 9,
  activeAgents: 14,
  monthRevenue: 3250400,
  monthOrders: 1186,
  revenueChangePct: 14.2,
  ordersChangePct: 9.8,
};

export const DASHBOARD_WEEKLY: Array<{ date: string; revenue: number; orders: number }> = [
  { date: '04-09', revenue: 118200, orders: 38 },
  { date: '04-10', revenue: 132400, orders: 44 },
  { date: '04-11', revenue: 99300, orders: 32 },
  { date: '04-12', revenue: 154800, orders: 48 },
  { date: '04-13', revenue: 172100, orders: 58 },
  { date: '04-14', revenue: 144700, orders: 49 },
  { date: '04-15', revenue: 148540, orders: 52 },
];

// ── 套餐 / Bundle (M3 后台产品管理) ─────────────────────────────────
export type BundleItemKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';

export interface BundleItem {
  kind: BundleItemKind;
  /** 显示用名称；真接 API 后改为 productId 引用 */
  productName: string;
  /** 数量或晚数 */
  qty: number;
  /** 单价，¥ */
  unitPrice: number;
}

export interface MockBundle {
  id: string;
  name: string;
  tagline: string;
  emoji: string;
  photo: string;
  /** 含哪些产品 */
  items: BundleItem[];
  /** 单卖总价（计算自 items；机票为可选基准价，运营未填=0 则仅含地面项） */
  listPrice: number;
  /** 套餐价（机票基准价计入，未填=0 则仅地面，卡内按出发日实时重算含机票真实价） */
  bundlePrice: number;
  /** 整单折扣百分比（整数 0–100）：套餐总价 = 全包价 × (1 − discountPct/100） */
  discountPct: number;
  /** @deprecated 已弃用的固定让利金额；前台改用 discountPct（整单 percent off） */
  groundDiscount: number;
  /** 机票对应人数（用于调 /flights/price） */
  flightPax: number;
  /** 适合人数 */
  suitableFor: string;
  /** 当前状态 */
  active: boolean;
}


export const MOCK_BUNDLES: MockBundle[] = [
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '岘港凯悦度假村 美溪海景房 3 晚', qty: 3, unitPrice: 1880 },
      { kind: 'TRANSFER', productName: '岘港机场接送（来回 7 座商务车）', qty: 2, unitPrice: 188 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b1',
      name: '经典度假 3 晚 · 凯悦海景',
      tagline: '来回机票 + 凯悦海景 3 晚 + 来回接送',
      emoji: '🏖️',
      photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 10,
      groundDiscount: 380,
      flightPax: 2,
      suitableFor: '2 人 · 情侣/家庭',
      active: true,
    };
  })(),
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '岘港洲际半岛度假村 山景房 4 晚', qty: 4, unitPrice: 3680 },
      { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
      { kind: 'TRANSFER', productName: '巴拿山 1 日包车', qty: 1, unitPrice: 588 },
      { kind: 'VISA', productName: '越南 E-visa 30 天 × 2', qty: 2, unitPrice: 280 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b2',
      name: '蜜月豪华 4 晚 · 洲际半岛',
      tagline: '来回机票 + 洲际半岛 + 巴拿山佛手桥 + 签证全包',
      emoji: '💍',
      photo: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 12,
      groundDiscount: 1200,
      flightPax: 2,
      suitableFor: '2 人 · 蜜月/纪念日',
      active: true,
    };
  })(),
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回商务舱 × 1 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '馨乐庭蓝湾公寓 市区 1 晚', qty: 1, unitPrice: 580 },
      { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
      { kind: 'VISA', productName: '越南落地签批文', qty: 1, unitPrice: 180 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b3',
      name: '商务快闪 1 晚 · 商务舱',
      tagline: '商务舱来回 + 市区公寓 + 签证 + 豪华接送',
      emoji: '💼',
      photo: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 8,
      groundDiscount: 200,
      flightPax: 1,
      suitableFor: '1 人 · 商务',
      active: true,
    };
  })(),
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 4 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '岘港太阳豪庭度假村 双房 4 晚', qty: 4, unitPrice: 1760 },
      { kind: 'TRANSFER', productName: '岘港机场接送（7 座商务车 来回）', qty: 2, unitPrice: 188 },
      { kind: 'TRANSFER', productName: '会安古城 1 日包车', qty: 1, unitPrice: 248 },
      { kind: 'VISA', productName: '越南 E-visa 30 天 × 4', qty: 4, unitPrice: 280 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b4',
      name: '亲子 4 晚 · 太阳豪庭',
      tagline: '来回机票 4 人 + 太阳豪庭双房 + 会安古城 + 签证',
      emoji: '👨‍👩‍👧‍👦',
      photo: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 0,
      groundDiscount: 800,
      flightPax: 4,
      suitableFor: '4 人 · 全家出游',
      active: true,
    };
  })(),
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '岘港 TIA Wellness 度假村 5 晚', qty: 5, unitPrice: 2880 },
      { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
      { kind: 'TRANSFER', productName: '海上钓鱼半日团', qty: 1, unitPrice: 988 },
      { kind: 'VISA', productName: '越南 E-visa 30 天 × 2', qty: 2, unitPrice: 280 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b5',
      name: '养生 5 晚 · TIA 全 SPA',
      tagline: '来回机票 + TIA 全日 SPA 免费 + 海钓',
      emoji: '🧘',
      photo: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 0,
      groundDiscount: 1000,
      flightPax: 2,
      suitableFor: '2 人 · 减压度假',
      active: true,
    };
  })(),
  (() => {
    const items: BundleItem[] = [
      { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '会安水疗安岚度假村 古城河景房 4 晚', qty: 4, unitPrice: 1980 },
      { kind: 'TRANSFER', productName: '岘港机场接送 + 会安专车', qty: 2, unitPrice: 248 },
      { kind: 'TRANSFER', productName: '美山圣地半日包车', qty: 1, unitPrice: 488 },
      { kind: 'VISA', productName: '越南 E-visa 30 天 × 2', qty: 2, unitPrice: 280 },
    ];
    // 一价全包：含机票在内的全部要素合计（FLIGHT 行项带固定机票价；mock 占位 0）。
    const allInTotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
    return {
      id: 'b6',
      name: '会安文化 4 晚 · 安岚古城',
      tagline: '来回机票 + 会安古城 + 美山遗址 UNESCO 双世遗',
      emoji: '🏮',
      photo: 'https://images.unsplash.com/photo-1558005137-d9619a5c539f?w=600&h=400&fit=crop',
      items,
      listPrice: allInTotal,
      bundlePrice: allInTotal,
      discountPct: 0,
      groundDiscount: 680,
      flightPax: 2,
      suitableFor: '2 人 · 文化探索',
      active: true,
    };
  })(),
];

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

// ── 散客管理 ──────────────────────────────────────────────────────
export interface MockCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  idNumber: string | null;
  /** 归属代理 id（null = 直销散客） */
  agentId: string | null;
  agentName: string | null;
  createdAt: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: string | null;
  tags: string[];
}

export const MOCK_CUSTOMERS: MockCustomer[] = [
  { id: 'cust1', name: '陈文豪', phone: '+853 6234 5678', email: 'chan@example.com', idNumber: 'MA1234567', agentId: 'a1', agentName: '澳门岘港旅游总代', createdAt: '2026-02-10T10:00:00+08:00', totalOrders: 3, totalSpent: 28560, lastOrderAt: '2026-04-14T14:23:00+08:00', tags: ['VIP', '回头客'] },
  { id: 'cust2', name: '王美玲', phone: '+852 9012 3456', email: 'wong@example.com', idNumber: 'HK5566778', agentId: null, agentName: null, createdAt: '2026-03-05T09:15:00+08:00', totalOrders: 1, totalSpent: 4380, lastOrderAt: '2026-04-14T16:05:00+08:00', tags: ['新客'] },
  { id: 'cust3', name: '李嘉欣', phone: '+853 6654 0001', email: null, idNumber: 'MA2345678', agentId: 'a2', agentName: '澳门欢乐旅行社', createdAt: '2026-01-20T15:30:00+08:00', totalOrders: 5, totalSpent: 52300, lastOrderAt: '2026-04-15T09:12:00+08:00', tags: ['VIP'] },
  { id: 'cust4', name: '张伟', phone: '+853 6023 7788', email: 'zhangwei@mo.com', idNumber: 'MA3456789', agentId: null, agentName: null, createdAt: '2026-04-02T11:00:00+08:00', totalOrders: 2, totalSpent: 11200, lastOrderAt: '2026-04-15T10:48:00+08:00', tags: [] },
  { id: 'cust5', name: '黄太太', phone: '+853 6876 1122', email: 'huang@mo.com', idNumber: 'MA4567890', agentId: 'a1', agentName: '澳门岘港旅游总代', createdAt: '2025-12-15T13:45:00+08:00', totalOrders: 8, totalSpent: 96400, lastOrderAt: '2026-04-15T11:30:00+08:00', tags: ['VIP', '回头客', '蜜月'] },
  { id: 'cust6', name: '刘洋', phone: '+852 9234 5566', email: null, idNumber: null, agentId: 'a3', agentName: '澳门威尼斯人门店', createdAt: '2026-03-22T17:20:00+08:00', totalOrders: 1, totalSpent: 588, lastOrderAt: '2026-04-12T14:00:00+08:00', tags: ['新客'] },
  { id: 'cust7', name: '周芳', phone: '+853 6123 3344', email: 'zhou@example.com', idNumber: 'MA5678901', agentId: null, agentName: null, createdAt: '2026-02-28T08:00:00+08:00', totalOrders: 1, totalSpent: 1380, lastOrderAt: '2026-04-13T18:40:00+08:00', tags: ['退款历史'] },
  { id: 'cust8', name: '孙悦', phone: '+852 5432 6677', email: 'sun@example.com', idNumber: 'HK7788990', agentId: 'a1', agentName: '澳门岘港旅游总代', createdAt: '2026-01-08T12:00:00+08:00', totalOrders: 4, totalSpent: 22180, lastOrderAt: '2026-04-12T14:00:00+08:00', tags: ['回头客'] },
];

// ── 旅客管理（订单里的实际出行人）─────────────────────────────────
export interface MockTraveler {
  id: string;
  fullName: string;
  passportNumber: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality: string;
  phone: string | null;
  /** 关联的客户 id（散客本人可能是旅客之一，或代订） */
  customerIds: string[];
  /** 出行次数 */
  tripCount: number;
  lastTripAt: string | null;
  notes: string | null;
}

export const MOCK_TRAVELERS: MockTraveler[] = [
  { id: 't1', fullName: 'CHAN MAN HO 陈文豪', passportNumber: 'MA1234567', dateOfBirth: '1985-06-15', nationality: 'MO', phone: '+853 6234 5678', customerIds: ['cust1'], tripCount: 3, lastTripAt: '2026-04-14', notes: 'VIP 客户' },
  { id: 't2', fullName: 'CHAN WAI LING 陈惠玲', passportNumber: 'MA1234568', dateOfBirth: '1987-03-22', nationality: 'MO', phone: null, customerIds: ['cust1'], tripCount: 3, lastTripAt: '2026-04-14', notes: '陈文豪配偶' },
  { id: 't3', fullName: 'WONG MEI LING 王美玲', passportNumber: 'HK5566778', dateOfBirth: '1990-11-08', nationality: 'HK', phone: '+852 9012 3456', customerIds: ['cust2'], tripCount: 1, lastTripAt: '2026-04-14', notes: null },
  { id: 't4', fullName: 'LEE KA YIN 李嘉欣', passportNumber: 'MA2345678', dateOfBirth: '1988-11-09', nationality: 'MO', phone: '+853 6654 0001', customerIds: ['cust3'], tripCount: 5, lastTripAt: '2026-04-15', notes: 'VIP · 偏好海景房' },
  { id: 't5', fullName: 'LEE KA FAI 李家辉', passportNumber: 'MA2345679', dateOfBirth: '1986-05-17', nationality: 'MO', phone: null, customerIds: ['cust3'], tripCount: 5, lastTripAt: '2026-04-15', notes: '李嘉欣丈夫' },
  { id: 't6', fullName: 'LEE SIN YAN 李善恩', passportNumber: 'MA2345680', dateOfBirth: '2018-09-03', nationality: 'MO', phone: null, customerIds: ['cust3'], tripCount: 2, lastTripAt: '2026-04-15', notes: '儿童 · 需要儿童安全座椅' },
  { id: 't7', fullName: 'ZHANG WEI 张伟', passportNumber: 'MA3456789', dateOfBirth: '1982-04-20', nationality: 'MO', phone: '+853 6023 7788', customerIds: ['cust4'], tripCount: 2, lastTripAt: '2026-04-15', notes: null },
  { id: 't8', fullName: 'HUANG LING YUN 黄凌云', passportNumber: 'MA4567890', dateOfBirth: '1975-08-11', nationality: 'MO', phone: '+853 6876 1122', customerIds: ['cust5'], tripCount: 8, lastTripAt: '2026-04-15', notes: 'VIP · 年消费¥96K+' },
  { id: 't9', fullName: 'HUANG YUE 黄悦', passportNumber: 'MA4567891', dateOfBirth: '2015-02-14', nationality: 'MO', phone: null, customerIds: ['cust5'], tripCount: 4, lastTripAt: '2026-04-15', notes: '黄太太女儿 · 蜜月套餐记录' },
  { id: 't10', fullName: 'LIU YANG 刘洋', passportNumber: 'HK3344556', dateOfBirth: '1995-07-28', nationality: 'HK', phone: '+852 9234 5566', customerIds: ['cust6'], tripCount: 1, lastTripAt: '2026-04-12', notes: null },
  { id: 't11', fullName: 'ZHOU FANG 周芳', passportNumber: 'MA5678901', dateOfBirth: '1992-12-30', nationality: 'MO', phone: '+853 6123 3344', customerIds: ['cust7'], tripCount: 1, lastTripAt: '2026-04-13', notes: '有退款记录' },
  { id: 't12', fullName: 'SUN YUE 孙悦', passportNumber: 'HK7788990', dateOfBirth: '1991-06-10', nationality: 'HK', phone: '+852 5432 6677', customerIds: ['cust8'], tripCount: 4, lastTripAt: '2026-04-12', notes: null },
];


// ═══════════════════════════════════════════════════════════════
// 审计日志
// ═══════════════════════════════════════════════════════════════

export interface MockAuditLog {
  id: string;
  timestamp: string;
  actor: string; // 操作人 email
  actorRole: string;
  action: string; // CREATE_AGENT / UPDATE_PRICING / ADJUST_BALANCE...
  target: string; // 操作对象
  targetType: 'AGENT' | 'ORDER' | 'FLIGHT' | 'CUSTOMER' | 'PRICING' | 'COMMISSION' | 'TENANT';
  before: string | null;
  after: string;
  ip: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export const MOCK_AUDIT_LOGS: MockAuditLog[] = [
  { id: 'log1', timestamp: '2026-04-16T09:12:33+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'UPDATE_PRICING_RULE', target: 'QH9589 日期等级 2026-05-01', targetType: 'PRICING', before: 'rank=C', after: 'rank=A (五一假期)', ip: '192.168.1.10', severity: 'WARNING' },
  { id: 'log2', timestamp: '2026-04-16T08:45:12+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'ADJUST_BALANCE', target: '澳门岘港旅游总代 (agent1)', targetType: 'AGENT', before: '¥80,000', after: '¥100,000 (+¥20,000 充值)', ip: '192.168.1.10', severity: 'CRITICAL' },
  { id: 'log3', timestamp: '2026-04-15T17:23:01+08:00', actor: 'staff@ftm.local', actorRole: 'STAFF', action: 'ADVANCE_ORDER_STATUS', target: 'FTM20260415003', targetType: 'ORDER', before: 'PROCESSING', after: 'TICKETED', ip: '192.168.1.15', severity: 'INFO' },
  { id: 'log4', timestamp: '2026-04-15T16:02:45+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'CREATE_AGENT', target: '澳门威尼斯人门店 (tier=3)', targetType: 'AGENT', before: null, after: 'parent=澳门欢乐旅行社, balance=¥5,000', ip: '192.168.1.10', severity: 'INFO' },
  { id: 'log5', timestamp: '2026-04-15T15:30:18+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'UPDATE_COMMISSION', target: '澳门岘港旅游总代 - FLIGHT', targetType: 'COMMISSION', before: '10% · 给下级 40%', after: '10% · 给下级 45%', ip: '192.168.1.10', severity: 'WARNING' },
  { id: 'log6', timestamp: '2026-04-15T14:23:00+08:00', actor: 'customer@ftm.local', actorRole: 'CUSTOMER', action: 'CREATE_ORDER', target: 'FTM20260415001 · QH9589 × 2', targetType: 'ORDER', before: null, after: 'total=¥5,720, paymentMethod=微信支付', ip: '203.xx.xx.xx', severity: 'INFO' },
  { id: 'log7', timestamp: '2026-04-15T12:15:00+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'BULK_CREATE_SCHEDULES', target: 'QH9589', targetType: 'FLIGHT', before: null, after: '批量创建 90 个班次（2026-05-01 ~ 2026-07-31 每日）', ip: '192.168.1.10', severity: 'INFO' },
  { id: 'log8', timestamp: '2026-04-14T18:40:00+08:00', actor: 'staff@ftm.local', actorRole: 'STAFF', action: 'APPROVE_REFUND', target: 'FTM20260413007 · ¥1,380', targetType: 'ORDER', before: 'REFUND_REQUESTED', after: 'REFUNDED', ip: '192.168.1.15', severity: 'WARNING' },
  { id: 'log9', timestamp: '2026-04-14T14:05:00+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'UPDATE_CUSTOMER', target: '陈文豪 (cust1)', targetType: 'CUSTOMER', before: 'tags=[回头客]', after: 'tags=[VIP, 回头客]', ip: '192.168.1.10', severity: 'INFO' },
  { id: 'log10', timestamp: '2026-04-14T11:00:00+08:00', actor: 'system', actorRole: 'SYSTEM', action: 'DAILY_PRICING_REFRESH', target: '全部班次', targetType: 'PRICING', before: null, after: 'ML 需求预测更新 · 730 个班次重算动态价', ip: 'system', severity: 'INFO' },
  { id: 'log11', timestamp: '2026-04-14T09:33:00+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'CREATE_TENANT', target: '港游旅游社 HK Voyage', targetType: 'TENANT', before: null, after: 'tier=PROFESSIONAL, license ends 2027-03-15', ip: '192.168.1.10', severity: 'CRITICAL' },
  { id: 'log12', timestamp: '2026-04-13T22:15:00+08:00', actor: 'admin@ftm.local', actorRole: 'ADMIN', action: 'LOGIN', target: 'admin-web', targetType: 'TENANT', before: null, after: '成功登录', ip: '192.168.1.10', severity: 'INFO' },
];

// ═══════════════════════════════════════════════════════════════
// 结算单
// ═══════════════════════════════════════════════════════════════

export interface MockSettlement {
  id: string;
  period: string; // YYYY-MM
  agentId: string;
  agentName: string;
  agentTier: number;
  /** 本月完成订单数 */
  orderCount: number;
  /** 本月订单总额（GMV） */
  grossRevenue: number;
  /** 应得佣金 */
  commissionEarned: number;
  /** 已扣除的给下级分成 */
  commissionPaidToChildren: number;
  /** 本级净佣金 */
  netCommission: number;
  /** 预付余额抵扣 */
  prepaymentOffset: number;
  /** 应支付给代理 */
  payableToAgent: number;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID';
  generatedAt: string;
  paidAt: string | null;
}

export const MOCK_SETTLEMENTS: MockSettlement[] = [
  { id: 's1', period: '2026-03', agentId: 'a1', agentName: '澳门岘港旅游总代', agentTier: 1, orderCount: 48, grossRevenue: 286400, commissionEarned: 28640, commissionPaidToChildren: 11456, netCommission: 17184, prepaymentOffset: 12000, payableToAgent: 5184, status: 'PAID', generatedAt: '2026-04-01T00:00:00+08:00', paidAt: '2026-04-05T14:30:00+08:00' },
  { id: 's2', period: '2026-03', agentId: 'a2', agentName: '澳门欢乐旅行社', agentTier: 2, orderCount: 23, grossRevenue: 156800, commissionEarned: 6272, commissionPaidToChildren: 1882, netCommission: 4390, prepaymentOffset: 3000, payableToAgent: 1390, status: 'PAID', generatedAt: '2026-04-01T00:00:00+08:00', paidAt: '2026-04-05T14:45:00+08:00' },
  { id: 's3', period: '2026-03', agentId: 'a3', agentName: '澳门威尼斯人门店', agentTier: 3, orderCount: 12, grossRevenue: 48200, commissionEarned: 578, commissionPaidToChildren: 0, netCommission: 578, prepaymentOffset: 200, payableToAgent: 378, status: 'PAID', generatedAt: '2026-04-01T00:00:00+08:00', paidAt: '2026-04-05T15:00:00+08:00' },
  { id: 's4', period: '2026-04', agentId: 'a1', agentName: '澳门岘港旅游总代', agentTier: 1, orderCount: 31, grossRevenue: 192600, commissionEarned: 19260, commissionPaidToChildren: 7704, netCommission: 11556, prepaymentOffset: 8000, payableToAgent: 3556, status: 'APPROVED', generatedAt: '2026-04-16T00:00:00+08:00', paidAt: null },
  { id: 's5', period: '2026-04', agentId: 'a2', agentName: '澳门欢乐旅行社', agentTier: 2, orderCount: 16, grossRevenue: 103200, commissionEarned: 4128, commissionPaidToChildren: 1238, netCommission: 2890, prepaymentOffset: 2000, payableToAgent: 890, status: 'PENDING_APPROVAL', generatedAt: '2026-04-16T00:00:00+08:00', paidAt: null },
  { id: 's6', period: '2026-04', agentId: 'a3', agentName: '澳门威尼斯人门店', agentTier: 3, orderCount: 8, grossRevenue: 32400, commissionEarned: 389, commissionPaidToChildren: 0, netCommission: 389, prepaymentOffset: 100, payableToAgent: 289, status: 'DRAFT', generatedAt: '2026-04-16T00:00:00+08:00', paidAt: null },
];

// ═══════════════════════════════════════════════════════════════
// 订单履约 (Fulfillment) 扩展
// ═══════════════════════════════════════════════════════════════

export type FulfillmentStatus = 'PENDING' | 'IN_PROGRESS' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

export interface MockFulfillment {
  orderId: string;
  flight?: { pnr: string | null; eTicketNumber: string | null; status: FulfillmentStatus };
  hotel?: { confirmationNumber: string | null; status: FulfillmentStatus };
  visa?: { applicationNumber: string | null; progress: string; status: FulfillmentStatus };
  transfer?: { driverName: string | null; vehicleNumber: string | null; status: FulfillmentStatus };
}

export const MOCK_FULFILLMENTS: Record<string, MockFulfillment> = {
  o1: { orderId: 'o1', flight: { pnr: 'BAV7X9A', eTicketNumber: '738-2145678901', status: 'CONFIRMED' } },
  o2: { orderId: 'o2', flight: { pnr: 'BAV8M2C', eTicketNumber: '738-2145678902', status: 'CONFIRMED' } },
  o3: { orderId: 'o3', flight: { pnr: 'BAV9K3D', eTicketNumber: null, status: 'IN_PROGRESS' }, hotel: { confirmationNumber: 'HYT-890123', status: 'CONFIRMED' } },
  o4: { orderId: 'o4', visa: { applicationNumber: 'VN-EVSA-2026-00789', progress: '材料审核中（2/5步）', status: 'IN_PROGRESS' } },
  o5: { orderId: 'o5', transfer: { driverName: 'Nguyen Van A', vehicleNumber: '43A-12345', status: 'CONFIRMED' } },
  o6: { orderId: 'o6', flight: { pnr: null, eTicketNumber: null, status: 'PENDING' } },
  o7: { orderId: 'o7', flight: { pnr: 'BAV5H1P', eTicketNumber: '738-2145678907', status: 'CANCELLED' } },
  o8: { orderId: 'o8', transfer: { driverName: 'Tran Duc B', vehicleNumber: '43A-67890', status: 'CONFIRMED' } },
  o9: { orderId: 'o9', hotel: { confirmationNumber: 'FSR-445566', status: 'CONFIRMED' } },
  o10: { orderId: 'o10', flight: { pnr: null, eTicketNumber: null, status: 'CANCELLED' } },
};
