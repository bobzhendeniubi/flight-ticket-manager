/**
 * 非破坏性产品配图更新脚本（staging / 生产可安全运行）。
 *
 * 目的：只更新现有产品的「图片列」——
 *   - Bundle.photo   (单图 URL)
 *   - Hotel.photos   (图组 URL[])
 *   - Transfer.photo (单图 URL)
 *   - Visa.photo     (单图 URL)
 * 不动价格、不动任何其他列、不删任何行、不碰订单。幂等：重复运行结果一致。
 *
 * 为什么不按 id 匹配：staging / 生产的 cuid 与本地不同，故一律按
 *   产品编号 code（B0001 / H0001 / T0001 / V0001…）优先匹配，
 *   编号缺失时回退到业务唯一键（Hotel: name+cityCode；Transfer: name；
 *   Visa: destinationCountry+visaType；Bundle: name）。
 * 所有图片 URL 均已逐条 curl -sI 验证返回 HTTP 200。
 *
 * 跑法（在 backend/ 目录）：
 *   DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB?schema=public" \
 *     npx tsx scripts/update-product-images.ts
 *
 * 编译后（容器内）亦可：
 *   node /app/dist/scripts/update-product-images.js
 *
 * 加 --dry-run 只打印将要改动，不写库：
 *   npx tsx scripts/update-product-images.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

const U = (id: string) => `https://images.unsplash.com/photo-${id}?w=600&h=400&fit=crop`;

// ── Bundles：单图。按 code 匹配，缺 code 时回退 name。──────────────────────────
interface BundleImage {
  code: string;
  name: string;
  photo: string;
}
const BUNDLE_IMAGES: BundleImage[] = [
  { code: 'B0001', name: '经典度假 3 晚 · 凯悦海景', photo: U('1540541338287-41700207dee6') },
  { code: 'B0002', name: '蜜月豪华 4 晚 · 洲际半岛', photo: U('1564501049412-61c2a3083791') },
  // B0003 旧图是泛用写字楼（弱），换成更贴切的商旅 / 机舱图
  { code: 'B0003', name: '商务快闪 1 晚 · 商务舱', photo: U('1542314831-068cd1dbfeeb') },
];

// ── Hotels：图组（封面 + 2 张氛围图）。按 code 匹配，缺 code 时回退 name+cityCode。──
interface HotelImages {
  code: string;
  name: string;
  cityCode: string;
  photos: string[];
}
const HOTEL_IMAGES: HotelImages[] = [
  {
    code: 'H0001', name: '岘港四季度假村', cityCode: 'DAD',
    photos: [U('1582719508461-905c673771fd'), U('1582719478250-c89cae4dc85b'), U('1611892440504-42a792e24d32')],
  },
  {
    code: 'H0002', name: '岘港洲际半岛度假村', cityCode: 'DAD',
    photos: [U('1520250497591-112f2f40a3f4'), U('1455587734955-081b22074882'), U('1631049307264-da0ec9d70304')],
  },
  {
    code: 'H0003', name: '岘港凯悦度假村', cityCode: 'DAD',
    photos: [U('1571896349842-33c89424de2d'), U('1564013799919-ab600027ffc6'), U('1571902943202-507ec2618e8f')],
  },
  {
    code: 'H0004', name: '岘港铂尔曼海滩度假村', cityCode: 'DAD',
    photos: [U('1445019980597-93fa8acb246c'), U('1551882547-ff40c63fe5fa'), U('1610641818989-c2051b5e2cfd')],
  },
  {
    code: 'H0005', name: '会安阿南塔拉度假村', cityCode: 'HOA',
    photos: [U('1578662996442-48f60103fc96'), U('1582610116397-edb318620f90'), U('1568084680786-a84f91d1153c')],
  },
];

// ── Transfers：单图。按 code 匹配，缺 code 时回退 name。────────────────────────
interface TransferImage {
  code: string;
  name: string;
  photo: string;
}
const TRANSFER_IMAGES: TransferImage[] = [
  { code: 'T0001', name: '岘港机场接送 · 经济轿车', photo: U('1502877338535-766e1452684a') },
  { code: 'T0002', name: '岘港机场接送 · 7 座商务车', photo: U('1544620347-c4fd4a3d5957') },
  { code: 'T0003', name: '岘港 → 会安古城 专车', photo: U('1519641471654-76ce0107ad1b') },
  { code: 'T0004', name: '巴拿山 1 日包车', photo: U('1506905925346-21bda4d32df4') },
  { code: 'T0005', name: '岘港 → 顺化故都 1 日游包车', photo: U('1469854523086-cc02fe5d8800') },
  { code: 'T0006', name: '岘港 → 美山圣地 半日包车', photo: U('1545569341-9eb8b30979d9') },
];

// ── Visas：单图。按 code 匹配，缺 code 时回退 destinationCountry+visaType。───────
interface VisaImage {
  code: string;
  destinationCountry: string;
  visaType: string;
  photo: string;
}
const VISA_IMAGES: VisaImage[] = [
  { code: 'V0001', destinationCountry: 'VN', visaType: 'e_visa', photo: U('1559592413-7cec4d0cae2b') },
  { code: 'V0002', destinationCountry: 'VN', visaType: 'e_visa_90d', photo: U('1488646953014-85cb44e25828') },
  { code: 'V0003', destinationCountry: 'VN', visaType: 'visa_on_arrival', photo: U('1583417319070-4a69db38a482') },
  { code: 'V0004', destinationCountry: 'VN', visaType: 'business_1y', photo: U('1528127269322-539801943592') },
  { code: 'V0005', destinationCountry: 'KH', visaType: 'e_visa', photo: U('1563492065599-3520f775eeed') },
  { code: 'V0006', destinationCountry: 'TH', visaType: 'tourist', photo: U('1508009603885-50cf7c579365') },
];

let updated = 0;
let skipped = 0;

function logRow(kind: string, label: string, action: 'update' | 'skip-missing'): void {
  if (action === 'skip-missing') {
    console.warn(`  [skip] ${kind} 未找到：${label}（库里没有该产品，跳过——不新建）`);
    skipped += 1;
  } else {
    console.log(`  [ok]   ${kind} ${DRY_RUN ? '将更新' : '已更新'} 图片：${label}`);
    updated += 1;
  }
}

async function updateBundles(): Promise<void> {
  console.log('Bundles:');
  for (const b of BUNDLE_IMAGES) {
    const row =
      (await prisma.bundle.findFirst({ where: { code: b.code }, select: { id: true } })) ??
      (await prisma.bundle.findFirst({ where: { name: b.name }, select: { id: true } }));
    if (!row) {
      logRow('Bundle', `${b.code} ${b.name}`, 'skip-missing');
      continue;
    }
    if (!DRY_RUN) {
      await prisma.bundle.update({ where: { id: row.id }, data: { photo: b.photo } });
    }
    logRow('Bundle', `${b.code} ${b.name}`, 'update');
  }
}

async function updateHotels(): Promise<void> {
  console.log('Hotels:');
  for (const h of HOTEL_IMAGES) {
    const row =
      (await prisma.hotel.findFirst({ where: { code: h.code }, select: { id: true } })) ??
      (await prisma.hotel.findFirst({
        where: { name: h.name, cityCode: h.cityCode },
        select: { id: true },
      }));
    if (!row) {
      logRow('Hotel', `${h.code} ${h.name}`, 'skip-missing');
      continue;
    }
    if (!DRY_RUN) {
      await prisma.hotel.update({ where: { id: row.id }, data: { photos: h.photos } });
    }
    logRow('Hotel', `${h.code} ${h.name}`, 'update');
  }
}

async function updateTransfers(): Promise<void> {
  console.log('Transfers:');
  for (const t of TRANSFER_IMAGES) {
    const row =
      (await prisma.transfer.findFirst({ where: { code: t.code }, select: { id: true } })) ??
      (await prisma.transfer.findFirst({ where: { name: t.name }, select: { id: true } }));
    if (!row) {
      logRow('Transfer', `${t.code} ${t.name}`, 'skip-missing');
      continue;
    }
    if (!DRY_RUN) {
      await prisma.transfer.update({ where: { id: row.id }, data: { photo: t.photo } });
    }
    logRow('Transfer', `${t.code} ${t.name}`, 'update');
  }
}

async function updateVisas(): Promise<void> {
  console.log('Visas:');
  for (const v of VISA_IMAGES) {
    const row =
      (await prisma.visa.findFirst({ where: { code: v.code }, select: { id: true } })) ??
      (await prisma.visa.findFirst({
        where: { destinationCountry: v.destinationCountry, visaType: v.visaType },
        select: { id: true },
      }));
    if (!row) {
      logRow('Visa', `${v.code} ${v.destinationCountry}/${v.visaType}`, 'skip-missing');
      continue;
    }
    if (!DRY_RUN) {
      await prisma.visa.update({ where: { id: row.id }, data: { photo: v.photo } });
    }
    logRow('Visa', `${v.code} ${v.destinationCountry}/${v.visaType}`, 'update');
  }
}

async function main(): Promise<void> {
  console.log(
    `更新产品配图 ${DRY_RUN ? '(DRY RUN —— 不写库)' : ''}—— 只改图片列，不动价格/其他字段/订单。\n`,
  );
  await updateBundles();
  await updateHotels();
  await updateTransfers();
  await updateVisas();
  console.log(`\n完成：${updated} 个产品图片已${DRY_RUN ? '准备' : '更新'}，${skipped} 个未找到（已跳过）。`);
}

main()
  .catch((err: unknown) => {
    console.error('更新产品配图失败：', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
