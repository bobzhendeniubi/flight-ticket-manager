/**
 * Demo-only 数据。M3-M5 前端页面用这份数据直接渲染，没接后端。
 * 所有金额单位：人民币 (CNY)。
 */

// ── 酒店 ────────────────────────────────────────────────────────────
export interface MockHotel {
  id: string;
  name: string;
  cityCode: string;
  cityName: string;
  stars: 3 | 4 | 5;
  basePrice: number;
  rating: number;
  reviewCount: number;
  emoji: string;
  amenities: string[];
  location: string;
}

export const MOCK_HOTELS: MockHotel[] = [
  {
    id: 'h1',
    name: '北京国贸大酒店',
    cityCode: 'PEK',
    cityName: '北京',
    stars: 5,
    basePrice: 1580,
    rating: 4.8,
    reviewCount: 2341,
    emoji: '🏨',
    amenities: ['免费WiFi', '含早餐', '健身房', '游泳池', '停车场'],
    location: '朝阳区建国门外大街 1 号',
  },
  {
    id: 'h2',
    name: '北京机场丽都假日酒店',
    cityCode: 'PEK',
    cityName: '北京',
    stars: 4,
    basePrice: 680,
    rating: 4.5,
    reviewCount: 1105,
    emoji: '🏨',
    amenities: ['免费班车', '24小时前台', '含早餐'],
    location: '首都机场周边 · 距 T3 航站楼 8km',
  },
  {
    id: 'h3',
    name: '上海外滩茂悦大酒店',
    cityCode: 'PVG',
    cityName: '上海',
    stars: 5,
    basePrice: 2180,
    rating: 4.9,
    reviewCount: 3421,
    emoji: '🏨',
    amenities: ['外滩江景', '含早餐', '行政酒廊', '健身房'],
    location: '虹口区黄浦路 199 号',
  },
  {
    id: 'h4',
    name: '上海浦东机场华美达',
    cityCode: 'PVG',
    cityName: '上海',
    stars: 4,
    basePrice: 520,
    rating: 4.3,
    reviewCount: 867,
    emoji: '🏨',
    amenities: ['免费机场班车', '24小时餐厅', '行李寄存'],
    location: '浦东机场周边 · 距 T2 航站楼 5km',
  },
  {
    id: 'h5',
    name: '广州越秀宾馆',
    cityCode: 'CAN',
    cityName: '广州',
    stars: 4,
    basePrice: 480,
    rating: 4.4,
    reviewCount: 621,
    emoji: '🏨',
    amenities: ['含早餐', '商务中心', '停车场'],
    location: '越秀区东风中路 339 号',
  },
  {
    id: 'h6',
    name: '深圳福田香格里拉',
    cityCode: 'SZX',
    cityName: '深圳',
    stars: 5,
    basePrice: 1680,
    rating: 4.7,
    reviewCount: 1876,
    emoji: '🏨',
    amenities: ['CBD 核心', '行政酒廊', '游泳池', '水疗'],
    location: '福田区益田路 4088 号',
  },
  {
    id: 'h7',
    name: '成都春熙路亚朵',
    cityCode: 'CTU',
    cityName: '成都',
    stars: 3,
    basePrice: 380,
    rating: 4.5,
    reviewCount: 945,
    emoji: '🏨',
    amenities: ['免费WiFi', '含早餐'],
    location: '锦江区春熙路商圈',
  },
  {
    id: 'h8',
    name: '厦门鼓浪屿金瑞酒店',
    cityCode: 'XMN',
    cityName: '厦门',
    stars: 4,
    basePrice: 720,
    rating: 4.6,
    reviewCount: 530,
    emoji: '🏖️',
    amenities: ['海景房', '含早餐', '免费自行车'],
    location: '思明区鼓浪屿龙头路',
  },
];

// ── 机场接送 ────────────────────────────────────────────────────────
export interface MockTransfer {
  id: string;
  name: string;
  vehicleType: string;
  capacity: number;
  basePrice: number;
  originArea: string;
  destArea: string;
  emoji: string;
  features: string[];
}

export const MOCK_TRANSFERS: MockTransfer[] = [
  {
    id: 't1',
    name: '经济型轿车',
    vehicleType: '舒适型轿车（如帕萨特、迈腾）',
    capacity: 3,
    basePrice: 128,
    originArea: '市区 5 环内',
    destArea: '首都机场 T2/T3',
    emoji: '🚗',
    features: ['最多 3 人 + 2 大件行李', '专职司机', '免费等候 30 分钟'],
  },
  {
    id: 't2',
    name: '舒适型商务车',
    vehicleType: '7 座商务车（如别克 GL8）',
    capacity: 6,
    basePrice: 258,
    originArea: '市区 5 环内',
    destArea: '首都机场 T2/T3',
    emoji: '🚐',
    features: ['最多 6 人 + 6 大件行李', '空间宽敞', '免费等候 60 分钟'],
  },
  {
    id: 't3',
    name: '豪华轿车',
    vehicleType: '豪华轿车（如奔驰 E 级、宝马 5 系）',
    capacity: 3,
    basePrice: 388,
    originArea: '市区任意位置',
    destArea: '首都机场 T2/T3',
    emoji: '🚘',
    features: ['商务接待首选', '车内 WiFi + 充电', '专职司机', '免费等候 60 分钟'],
  },
  {
    id: 't4',
    name: '大型 SUV',
    vehicleType: '7 座 SUV（如汉兰达、途昂）',
    capacity: 6,
    basePrice: 298,
    originArea: '市区 5 环内',
    destArea: '首都机场 T2/T3',
    emoji: '🚙',
    features: ['适合家庭出行', '最多 6 人 + 大件行李'],
  },
];

// ── 签证 ───────────────────────────────────────────────────────────
export interface MockVisa {
  id: string;
  country: string;
  countryCode: string;
  flag: string;
  type: string;
  processingDays: number;
  basePrice: number;
  expressSurcharge: number;
  requiredDocs: string[];
  validityMonths: number;
}

export const MOCK_VISAS: MockVisa[] = [
  {
    id: 'v1',
    country: '日本',
    countryCode: 'JP',
    flag: '🇯🇵',
    type: '单次旅游签',
    processingDays: 7,
    basePrice: 380,
    expressSurcharge: 180,
    requiredDocs: ['护照原件', '2寸白底照片', '身份证复印件', '在职证明', '银行流水'],
    validityMonths: 3,
  },
  {
    id: 'v2',
    country: '日本',
    countryCode: 'JP',
    flag: '🇯🇵',
    type: '三年多次签',
    processingDays: 10,
    basePrice: 880,
    expressSurcharge: 300,
    requiredDocs: ['护照原件', '2寸白底照片', '身份证复印件', '税单', '房产证明'],
    validityMonths: 36,
  },
  {
    id: 'v3',
    country: '韩国',
    countryCode: 'KR',
    flag: '🇰🇷',
    type: '单次旅游签',
    processingDays: 5,
    basePrice: 280,
    expressSurcharge: 150,
    requiredDocs: ['护照原件', '2寸白底照片', '身份证复印件', '在职证明'],
    validityMonths: 3,
  },
  {
    id: 'v4',
    country: '泰国',
    countryCode: 'TH',
    flag: '🇹🇭',
    type: '旅游落地签',
    processingDays: 1,
    basePrice: 240,
    expressSurcharge: 0,
    requiredDocs: ['护照原件', '往返机票', '酒店订单'],
    validityMonths: 1,
  },
  {
    id: 'v5',
    country: '美国',
    countryCode: 'US',
    flag: '🇺🇸',
    type: 'B1/B2 商务旅游签',
    processingDays: 30,
    basePrice: 1680,
    expressSurcharge: 800,
    requiredDocs: ['护照原件', '2寸白底照片', 'DS-160 确认页', '预约单', '面签辅导'],
    validityMonths: 120,
  },
  {
    id: 'v6',
    country: '英国',
    countryCode: 'GB',
    flag: '🇬🇧',
    type: '标准访问签',
    processingDays: 15,
    basePrice: 1380,
    expressSurcharge: 600,
    requiredDocs: ['护照原件', '照片', '资金证明', '行程单', '在职证明'],
    validityMonths: 6,
  },
  {
    id: 'v7',
    country: '申根（法国/意大利等）',
    countryCode: 'SC',
    flag: '🇪🇺',
    type: '申根旅游签',
    processingDays: 15,
    basePrice: 980,
    expressSurcharge: 500,
    requiredDocs: ['护照原件', '照片', '资金证明', '行程单', '酒店预订', '保险单'],
    validityMonths: 6,
  },
  {
    id: 'v8',
    country: '新加坡',
    countryCode: 'SG',
    flag: '🇸🇬',
    type: '电子旅游签',
    processingDays: 3,
    basePrice: 280,
    expressSurcharge: 100,
    requiredDocs: ['护照电子版', '2寸白底照片电子版'],
    validityMonths: 2,
  },
  {
    id: 'v9',
    country: '阿联酋',
    countryCode: 'AE',
    flag: '🇦🇪',
    type: '30天旅游签',
    processingDays: 4,
    basePrice: 580,
    expressSurcharge: 200,
    requiredDocs: ['护照电子版', '照片', '行程单'],
    validityMonths: 2,
  },
  {
    id: 'v10',
    country: '澳大利亚',
    countryCode: 'AU',
    flag: '🇦🇺',
    type: '600 类访客签',
    processingDays: 20,
    basePrice: 1180,
    expressSurcharge: 600,
    requiredDocs: ['护照原件', '资金证明', '行程单', '在职证明', '体检'],
    validityMonths: 12,
  },
];

// ── 订单 (admin view) ────────────────────────────────────────────────
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
  agentName: string | null; // 代理订单
  itemSummary: string;
  itemKind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'COMBO';
  total: number;
  status: MockOrderStatus;
  paymentMethod: string | null;
  createdAt: string; // ISO
  passengerCount: number;
}

export const MOCK_ORDERS: MockOrder[] = [
  {
    id: 'o1',
    orderNumber: 'FTM20260415001',
    customerName: '张伟',
    contactPhone: '138****1234',
    agentName: null,
    itemSummary: 'QH9588 北京→上海 · 经济舱 × 2',
    itemKind: 'FLIGHT',
    total: 2360,
    status: 'TICKETED',
    paymentMethod: '微信支付',
    createdAt: '2026-04-14T14:23:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o2',
    orderNumber: 'FTM20260415002',
    customerName: '李娜',
    contactPhone: '139****5678',
    agentName: '总代旅行社',
    itemSummary: 'QH9589 上海→北京 · 商务舱 × 1',
    itemKind: 'FLIGHT',
    total: 3980,
    status: 'PAID',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-14T16:05:00+08:00',
    passengerCount: 1,
  },
  {
    id: 'o3',
    orderNumber: 'FTM20260415003',
    customerName: '王强',
    contactPhone: '136****9012',
    agentName: null,
    itemSummary: '机票 + 北京国贸大酒店 2 晚',
    itemKind: 'COMBO',
    total: 5520,
    status: 'PROCESSING',
    paymentMethod: '支付宝',
    createdAt: '2026-04-15T09:12:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o4',
    orderNumber: 'FTM20260415004',
    customerName: '陈静',
    contactPhone: '137****3456',
    agentName: '区代旅行社',
    itemSummary: '日本三年多次签证 × 2',
    itemKind: 'VISA',
    total: 1760,
    status: 'PROCESSING',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-15T10:48:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o5',
    orderNumber: 'FTM20260415005',
    customerName: '刘洋',
    contactPhone: '135****7890',
    agentName: null,
    itemSummary: '首都机场商务车接送 × 1',
    itemKind: 'TRANSFER',
    total: 258,
    status: 'PAID',
    paymentMethod: '微信支付',
    createdAt: '2026-04-15T11:30:00+08:00',
    passengerCount: 1,
  },
  {
    id: 'o6',
    orderNumber: 'FTM20260415006',
    customerName: '黄磊',
    contactPhone: '138****2468',
    agentName: '门店旅行社',
    itemSummary: 'QH9588 北京→上海 · 经济舱 × 3',
    itemKind: 'FLIGHT',
    total: 3540,
    status: 'PENDING_PAYMENT',
    paymentMethod: null,
    createdAt: '2026-04-15T12:15:00+08:00',
    passengerCount: 3,
  },
  {
    id: 'o7',
    orderNumber: 'FTM20260415007',
    customerName: '周芳',
    contactPhone: '139****1357',
    agentName: null,
    itemSummary: 'QH9589 上海→北京 · 经济舱 × 1',
    itemKind: 'FLIGHT',
    total: 1280,
    status: 'REFUND_REQUESTED',
    paymentMethod: '微信支付',
    createdAt: '2026-04-13T18:40:00+08:00',
    passengerCount: 1,
  },
  {
    id: 'o8',
    orderNumber: 'FTM20260415008',
    customerName: '孙悦',
    contactPhone: '137****8642',
    agentName: '总代旅行社',
    itemSummary: '申根签证 × 4',
    itemKind: 'VISA',
    total: 3920,
    status: 'TICKETED',
    paymentMethod: '代理预付抵扣',
    createdAt: '2026-04-12T14:00:00+08:00',
    passengerCount: 4,
  },
  {
    id: 'o9',
    orderNumber: 'FTM20260415009',
    customerName: '赵磊',
    contactPhone: '138****9753',
    agentName: null,
    itemSummary: '上海外滩茂悦大酒店 3 晚',
    itemKind: 'HOTEL',
    total: 6540,
    status: 'COMPLETED',
    paymentMethod: '支付宝',
    createdAt: '2026-04-10T21:15:00+08:00',
    passengerCount: 2,
  },
  {
    id: 'o10',
    orderNumber: 'FTM20260415010',
    customerName: '吴彦',
    contactPhone: '135****1111',
    agentName: null,
    itemSummary: 'QH9588 北京→上海 · 商务舱 × 1',
    itemKind: 'FLIGHT',
    total: 3980,
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
  { tier: 'A', label: 'A 等级（黄金档）', multiplier: 1.5, description: '节假日首末班、热门商务时刻' },
  { tier: 'B', label: 'B 等级（高峰档）', multiplier: 1.2, description: '周五周日、周一早班' },
  { tier: 'C', label: 'C 等级（平峰档）', multiplier: 1.0, description: '工作日常规时段' },
  { tier: 'D', label: 'D 等级（优惠档）', multiplier: 0.8, description: '深夜、淡季非周末' },
];

// 模拟过去 14 天每天的平均价格（用于价格走势图）
export function generatePriceHistory(basePrice: number): Array<{ date: string; price: number; tier: 'A' | 'B' | 'C' | 'D' }> {
  const res: Array<{ date: string; price: number; tier: 'A' | 'B' | 'C' | 'D' }> = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay(); // 0=Sun
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
  todayRevenue: 128540,
  todayOrders: 47,
  pendingOrders: 8,
  activeAgents: 12,
  monthRevenue: 2850400,
  monthOrders: 1042,
  revenueChangePct: 12.4,
  ordersChangePct: 8.2,
};

export const DASHBOARD_WEEKLY: Array<{ date: string; revenue: number; orders: number }> = [
  { date: '04-09', revenue: 98200, orders: 32 },
  { date: '04-10', revenue: 112400, orders: 38 },
  { date: '04-11', revenue: 89300, orders: 29 },
  { date: '04-12', revenue: 124800, orders: 42 },
  { date: '04-13', revenue: 152100, orders: 51 },
  { date: '04-14', revenue: 134700, orders: 44 },
  { date: '04-15', revenue: 128540, orders: 47 },
];
