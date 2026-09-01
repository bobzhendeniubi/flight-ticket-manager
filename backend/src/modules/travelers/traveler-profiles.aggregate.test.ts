/**
 * 旅客档案聚合口径单测 —— 直接驱动纯函数 buildTravelerAggregates，无 mock。
 *
 * 覆盖口径（proposal 默认值）：
 *   - tripCount 只数去程已起飞的行程；nextTripAt 取最近的未来去程
 *   - 人均消费 = 实付 ÷ 乘机人数（平摊，含儿童）
 *   - 偏好：床型/餐食/单住取最近值；轮椅任一次为真；舱位取众数
 *   - 同行人按共同订单数排序；同单同证件号去重
 *   - 酒店历史从订单行提取并按入住日倒序
 */
import { describe, it, expect } from 'vitest';
import {
  buildTravelerAggregates,
  docKey,
  type AggOrder,
  type AggPassenger,
} from './traveler-profiles.aggregate.js';

const NOW = new Date('2026-07-14T00:00:00Z');

function pax(over: Partial<AggPassenger> & { documentNumber: string }): AggPassenger {
  return {
    fullName: 'ZHANG SAN',
    chineseName: null,
    gender: null,
    documentType: 'PASSPORT',
    documentNumber: over.documentNumber,
    dateOfBirth: new Date('1990-01-01T00:00:00Z'),
    nationality: 'CN',
    passportExpiry: null,
    mealPreference: null,
    bedPref: null,
    needsWheelchair: false,
    singleRoom: false,
    ...over,
  };
}

function order(over: Partial<AggOrder> & { id: string }): AggOrder {
  return {
    orderNumber: `FTM-${over.id}`,
    status: 'COMPLETED',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    paidAmountCny: 0,
    passengers: [],
    items: [],
    ...over,
  };
}

function flightItem(departISO: string, extra?: { cabin?: 'ECONOMY' | 'BUSINESS' }) {
  return {
    kind: 'FLIGHT' as const,
    flightCabin: extra?.cabin ?? ('ECONOMY' as const),
    departureTime: new Date(departISO),
    flightNumber: 'VJ2621',
    originCode: 'MFM',
    destinationCode: 'DAD',
    hotelName: null,
    roomTypeName: null,
    hotelCheckIn: null,
    hotelCheckOut: null,
  };
}

function hotelItem(name: string, checkInISO: string, checkOutISO: string, roomType = 'Deluxe King') {
  return {
    kind: 'HOTEL' as const,
    flightCabin: null,
    departureTime: null,
    flightNumber: null,
    originCode: null,
    destinationCode: null,
    hotelName: name,
    roomTypeName: roomType,
    hotelCheckIn: new Date(checkInISO),
    hotelCheckOut: new Date(checkOutISO),
  };
}

const KEY = docKey('PASSPORT', 'E12345678');

describe('buildTravelerAggregates 行程与时间口径', () => {
  it('tripCount 只数去程已起飞的行程；未来行程记 nextTripAt', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-03-01T02:00:00Z'), flightItem('2026-03-05T10:00:00Z')],
      }),
      order({
        id: 'o2',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-08-01T02:00:00Z'), flightItem('2026-08-05T10:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(1); // 只有 3 月的已飞
    expect(agg.orderCount).toBe(2);
    expect(agg.firstTripAt).toEqual(new Date('2026-03-01T02:00:00Z'));
    expect(agg.lastTripAt).toEqual(new Date('2026-03-01T02:00:00Z'));
    expect(agg.nextTripAt).toEqual(new Date('2026-08-01T02:00:00Z'));
  });

  it('去程 = 订单里最早起飞的航段；回程 = 第二段', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        // 故意乱序传入
        items: [flightItem('2026-03-05T10:00:00Z'), flightItem('2026-03-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.trips[0].departAt).toEqual(new Date('2026-03-01T02:00:00Z'));
    expect(agg.trips[0].returnAt).toEqual(new Date('2026-03-05T10:00:00Z'));
    expect(agg.trips[0].route).toBe('MFM→DAD');
  });

  it('无机票的订单（纯签证/酒店）计入 orderCount 但不计 tripCount', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [hotelItem('岘港示例酒店', '2026-03-01T00:00:00Z', '2026-03-05T00:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.orderCount).toBe(1);
    expect(agg.tripCount).toBe(0);
    expect(agg.nextTripAt).toBeNull();
  });
});

describe('pendingTripCount 在订未飞口径', () => {
  it('只数去程未起飞的行程；与 tripCount 互补', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1', // 已飞
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
      order({
        id: 'o2', // 未飞
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-08-01T02:00:00Z')],
      }),
      order({
        id: 'o3', // 未飞
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-09-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(1);
    expect(agg.pendingTripCount).toBe(2);
    expect(agg.tripCount + agg.pendingTripCount).toBe(agg.orderCount);
  });

  it('无航段的订单两边都不计（只进 orderCount）', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [hotelItem('岘港示例酒店', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.orderCount).toBe(1);
    expect(agg.tripCount).toBe(0);
    expect(agg.pendingTripCount).toBe(0);
  });

  it('恰好卡在当下起飞的行程算已飞，不算在订未飞', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem(NOW.toISOString())],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(1);
    expect(agg.pendingTripCount).toBe(0);
  });

  it('一张往返单只算 1 次在订未飞，不按航段翻倍', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-08-01T02:00:00Z'), flightItem('2026-08-09T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(0);
    expect(agg.pendingTripCount).toBe(1);
  });

  it('别名归拢后新旧两证的在订未飞合并计数', () => {
    const aliasMap = new Map([[docKey('PASSPORT', 'E00000001'), KEY]]);
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E00000001' })], // 旧证，未飞
        items: [flightItem('2026-08-01T02:00:00Z')],
      }),
      order({
        id: 'o2',
        passengers: [pax({ documentNumber: 'E12345678' })], // 新证，未飞
        items: [flightItem('2026-09-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW, aliasMap).get(KEY)!;
    expect(agg.pendingTripCount).toBe(2);
  });
});

describe('人均消费口径', () => {
  it('订单实付平摊到每位乘机人（含儿童），跨订单累加', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        paidAmountCny: 9000,
        passengers: [
          pax({ documentNumber: 'E12345678' }),
          pax({ documentNumber: 'E22222222', fullName: 'LI SI' }),
          pax({ documentNumber: 'E33333333', fullName: 'ZHANG XIAO' }),
        ],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
      order({
        id: 'o2',
        paidAmountCny: 5000,
        passengers: [
          pax({ documentNumber: 'E12345678' }),
          pax({ documentNumber: 'E22222222', fullName: 'LI SI' }),
        ],
        items: [flightItem('2026-05-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.totalSpendCny).toBe(3000 + 2500);
    expect(agg.trips.find((t) => t.orderId === 'o1')!.spendShareCny).toBe(3000);
  });

  it('单人订单消费全额归本人', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        paidAmountCny: 100,
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.totalSpendCny).toBe(100);
  });
});

describe('偏好口径', () => {
  it('床型/餐食/单住取最近订单的值；轮椅任一次为真即真', () => {
    const orders: AggOrder[] = [
      order({
        id: 'old',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passengers: [
          pax({
            documentNumber: 'E12345678',
            bedPref: 'TWIN',
            mealPreference: '清真',
            needsWheelchair: true,
            singleRoom: true,
          }),
        ],
        items: [flightItem('2026-01-10T02:00:00Z')],
      }),
      order({
        id: 'new',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        passengers: [
          pax({ documentNumber: 'E12345678', bedPref: 'DOUBLE', singleRoom: false }),
        ],
        items: [flightItem('2026-06-10T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.prefBed).toBe('DOUBLE'); // 最近值
    expect(agg.prefMeal).toBe('清真'); // 新单没填 → 保留最近非空值
    expect(agg.prefSingleRoom).toBe(false); // 最近值（含显式 false）
    expect(agg.needsWheelchair).toBe(true); // 历史任一次为真
  });

  it('舱位取众数', () => {
    const mk = (id: string, cabin: 'ECONOMY' | 'BUSINESS', dep: string) =>
      order({
        id,
        createdAt: new Date(dep),
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem(dep, { cabin })],
      });
    const orders = [
      mk('o1', 'ECONOMY', '2026-01-10T02:00:00Z'),
      mk('o2', 'BUSINESS', '2026-02-10T02:00:00Z'),
      mk('o3', 'BUSINESS', '2026-03-10T02:00:00Z'),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.prefCabin).toBe('BUSINESS');
  });
});

describe('同行人与去重', () => {
  it('同行人按共同订单数倒序；取最新姓名写法', () => {
    const mate = (name: string) => pax({ documentNumber: 'E99999999', fullName: name });
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passengers: [
          pax({ documentNumber: 'E12345678' }),
          mate('WANG WU'),
          pax({ documentNumber: 'E88888888', fullName: 'ZHAO LIU' }),
        ],
        items: [],
      }),
      order({
        id: 'o2',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'E12345678' }), mate('WANG W')],
        items: [],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.companions[0]).toMatchObject({
      documentNumber: 'E99999999',
      fullName: 'WANG W', // 最新一单的写法
      tripsTogether: 2,
    });
    expect(agg.companions[1]).toMatchObject({ documentNumber: 'E88888888', tripsTogether: 1 });
  });

  it('同一订单同证件号重复（强录回补）只计一次，且不把自己算成同行人', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' }), pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.orderCount).toBe(1);
    expect(agg.companions).toHaveLength(0);
  });

  it('证件号大小写/首尾空格归一为同一人', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'e12345678 ' })],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
      order({
        id: 'o2',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-04-01T02:00:00Z')],
      }),
    ];
    const map = buildTravelerAggregates(orders, NOW);
    expect(map.size).toBe(1);
    expect(map.get(KEY)!.orderCount).toBe(2);
  });
});

describe('aliasMap 别名归拢（档案合并，同人换证）', () => {
  const OLD_KEY = docKey('PASSPORT', 'EOLD11111');
  const NEW_KEY = docKey('PASSPORT', 'ENEW22222');

  it('两证订单合成一份聚合：累计合并、证件字段取主证最近行', () => {
    const aliasMap = new Map([[OLD_KEY, NEW_KEY]]);
    const orders: AggOrder[] = [
      order({
        id: 'o-old',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        paidAmountCny: 1000,
        passengers: [pax({ documentNumber: 'EOLD11111', fullName: 'ZHANG SAN' })],
        items: [flightItem('2026-01-10T02:00:00Z')],
      }),
      order({
        id: 'o-new',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        paidAmountCny: 2000,
        passengers: [
          pax({
            documentNumber: 'ENEW22222',
            fullName: 'ZHANG SAN',
            passportExpiry: new Date('2036-05-01T00:00:00Z'),
          }),
        ],
        items: [flightItem('2026-06-10T02:00:00Z')],
      }),
    ];
    const map = buildTravelerAggregates(orders, NOW, aliasMap);
    expect(map.size).toBe(1);
    const agg = map.get(NEW_KEY)!;
    expect(agg.orderCount).toBe(2);
    expect(agg.tripCount).toBe(2);
    expect(agg.totalSpendCny).toBe(3000);
    expect(agg.firstTripAt).toEqual(new Date('2026-01-10T02:00:00Z'));
    expect(agg.documentNumber).toBe('ENEW22222');
    expect(agg.passportExpiry).toEqual(new Date('2036-05-01T00:00:00Z'));
  });

  it('旧证订单更近时：姓名等取最近行，证件字段仍锁定主证', () => {
    const aliasMap = new Map([[OLD_KEY, NEW_KEY]]);
    const orders: AggOrder[] = [
      order({
        id: 'o-new',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'ENEW22222', fullName: 'ZHANG SAN' })],
        items: [],
      }),
      order({
        id: 'o-old-latest',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'EOLD11111', fullName: 'ZHANG S' })],
        items: [],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW, aliasMap).get(NEW_KEY)!;
    expect(agg.fullName).toBe('ZHANG S'); // 最近一单的写法
    expect(agg.documentNumber).toBe('ENEW22222'); // 旧证不能反客为主
  });

  it('旧证的乘机人行不把「自己」算成同行人；真同行人跨两证累计', () => {
    const aliasMap = new Map([[OLD_KEY, NEW_KEY]]);
    const mate = () => pax({ documentNumber: 'E99999999', fullName: 'WANG WU' });
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'EOLD11111' }), mate()],
        items: [],
      }),
      order({
        id: 'o2',
        createdAt: new Date('2026-02-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'ENEW22222' }), mate()],
        items: [],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW, aliasMap).get(NEW_KEY)!;
    expect(agg.companions).toHaveLength(1);
    expect(agg.companions[0]).toMatchObject({ documentNumber: 'E99999999', tripsTogether: 2 });
    // 反向：同行人视角也只有本尊一条（不重复出现旧证/新证两条）
    const mateAgg = buildTravelerAggregates(orders, NOW, aliasMap).get(
      docKey('PASSPORT', 'E99999999'),
    )!;
    expect(mateAgg.companions).toHaveLength(1);
    expect(mateAgg.companions[0].tripsTogether).toBe(2);
  });

  it('同一单里旧证+新证重复录入只计一次，不互算同行人', () => {
    const aliasMap = new Map([[OLD_KEY, NEW_KEY]]);
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'EOLD11111' }), pax({ documentNumber: 'ENEW22222' })],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
    ];
    const map = buildTravelerAggregates(orders, NOW, aliasMap);
    expect(map.size).toBe(1);
    const agg = map.get(NEW_KEY)!;
    expect(agg.orderCount).toBe(1);
    expect(agg.companions).toHaveLength(0);
  });

  it('链式指针（A→B→C）解析到最终主档案，且能防环不死循环', () => {
    const KEY_A = docKey('PASSPORT', 'EAAA11111');
    const KEY_B = docKey('PASSPORT', 'EBBB22222');
    const KEY_C = docKey('PASSPORT', 'ECCC33333');
    const chain = new Map([
      [KEY_A, KEY_B],
      [KEY_B, KEY_C],
    ]);
    const mk = (id: string, doc: string, createdAt: string) =>
      order({
        id,
        createdAt: new Date(createdAt),
        passengers: [pax({ documentNumber: doc })],
        items: [],
      });
    const orders = [
      mk('oa', 'EAAA11111', '2026-01-01T00:00:00Z'),
      mk('ob', 'EBBB22222', '2026-02-01T00:00:00Z'),
      mk('oc', 'ECCC33333', '2026-03-01T00:00:00Z'),
    ];
    const map = buildTravelerAggregates(orders, NOW, chain);
    expect(map.size).toBe(1);
    expect(map.get(KEY_C)!.orderCount).toBe(3);

    // 环（脏数据）：解析停在原地，不抛错，各自独立成档
    const cyclic = new Map([
      [KEY_A, KEY_B],
      [KEY_B, KEY_A],
    ]);
    const cyclicMap = buildTravelerAggregates(
      [mk('oa', 'EAAA11111', '2026-01-01T00:00:00Z'), mk('ob', 'EBBB22222', '2026-02-01T00:00:00Z')],
      NOW,
      cyclic,
    );
    expect(cyclicMap.size).toBe(2);
  });

  it('不传 aliasMap 时行为与原口径完全一致（两证各自成档）', () => {
    const orders: AggOrder[] = [
      order({ id: 'o1', passengers: [pax({ documentNumber: 'EOLD11111' })], items: [] }),
      order({ id: 'o2', passengers: [pax({ documentNumber: 'ENEW22222' })], items: [] }),
    ];
    const map = buildTravelerAggregates(orders, NOW);
    expect(map.size).toBe(2);
  });
});

describe('酒店历史', () => {
  it('从订单行提取酒店+房型+入住区间，按入住日倒序', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [
          flightItem('2026-01-10T02:00:00Z'),
          hotelItem('示例海滩酒店', '2026-01-10T00:00:00Z', '2026-01-14T00:00:00Z', 'Twin'),
        ],
      }),
      order({
        id: 'o2',
        createdAt: new Date('2026-05-01T00:00:00Z'),
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [
          flightItem('2026-05-10T02:00:00Z'),
          hotelItem('示例度假村', '2026-05-10T00:00:00Z', '2026-05-15T00:00:00Z'),
        ],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.hotelHistory).toEqual([
      {
        hotelName: '示例度假村',
        roomType: 'Deluxe King',
        checkIn: '2026-05-10',
        checkOut: '2026-05-15',
        orderNumber: 'FTM-o2',
      },
      {
        hotelName: '示例海滩酒店',
        roomType: 'Twin',
        checkIn: '2026-01-10',
        checkOut: '2026-01-14',
        orderNumber: 'FTM-o1',
      },
    ]);
  });
});

// 待支付单纳入档案后的口径切分（2026-09-01）：后台单/代理单永不自动退位，待支付是能挂很久的
// 正常业务状态，这类单要让人建得出档案、飞行次数算得上；但订单数/累计消费/首末次出行是
// 「已消费」语义，绝不能被没收到的钱撑大。
describe('待支付单：进飞行次数口径，不进已消费口径', () => {
  it('已起飞的待支付单计入 tripCount，但不计 orderCount / 累计消费 / 首末次出行', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        status: 'PENDING_PAYMENT',
        paidAmountCny: 8000, // 待支付单万一挂着定金，也不许进累计消费
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-03-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(1);
    expect(agg.orderCount).toBe(0);
    expect(agg.totalSpendCny).toBe(0);
    expect(agg.firstTripAt).toBeNull();
    expect(agg.lastTripAt).toBeNull();
  });

  it('未起飞的待支付单计入 pendingTripCount 与 nextTripAt', () => {
    const orders: AggOrder[] = [
      order({
        id: 'o1',
        status: 'PENDING_PAYMENT',
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-09-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.pendingTripCount).toBe(1);
    expect(agg.nextTripAt).toEqual(new Date('2026-09-01T02:00:00Z'));
  });

  it('已付款单与待支付单混合：飞行次数两张都算，消费只算已付款那张', () => {
    const orders: AggOrder[] = [
      order({
        id: 'paid',
        status: 'PAID',
        paidAmountCny: 5000,
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-02-01T02:00:00Z')],
      }),
      order({
        id: 'pending',
        status: 'PENDING_PAYMENT',
        paidAmountCny: 8000,
        passengers: [pax({ documentNumber: 'E12345678' })],
        items: [flightItem('2026-06-01T02:00:00Z')],
      }),
    ];
    const agg = buildTravelerAggregates(orders, NOW).get(KEY)!;
    expect(agg.tripCount).toBe(2);
    expect(agg.orderCount).toBe(1);
    expect(agg.totalSpendCny).toBe(5000);
    // 首末次出行都锁在已付款那张单上，不被待支付的 6 月那趟顶掉
    expect(agg.firstTripAt).toEqual(new Date('2026-02-01T02:00:00Z'));
    expect(agg.lastTripAt).toEqual(new Date('2026-02-01T02:00:00Z'));
  });
});
