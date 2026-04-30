// Build docs/presentation/week-2/DECK.pptx — today's 30-45 min demo deck.
// Run: NODE_PATH=$(npm root -g) node scripts/build-presentation/build_pptx.js
const pptxgen = require('pptxgenjs');
const path = require('path');
const fs = require('fs');

const OUT = '/Users/bobwang/Documents/Flight Ticket Manager/docs/presentation/week-2/DECK.pptx';

const COLOR = {
  navy: '1E2761', ice: 'CADCFC', white: 'FFFFFF', cream: 'F8F9FA',
  coral: 'F96167', gold: 'F9E795', charcoal: '36454F', green: '028090',
  amber: 'FFA500', red: 'D32F2F', text: '212121', muted: '666666',
};

const FONT_HEAD = 'Calibri';
const FONT_BODY = 'Calibri';

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_16x9';
pptx.title = '世途旅行 · Week 2 Demo';
pptx.author = 'Bob Wang';
pptx.company = '世途旅行 Citur Travel';

const W = 13.33;

pptx.defineSlideMaster({
  title: 'CONTENT',
  background: { color: COLOR.white },
  objects: [
    { rect: { x: 0, y: 0, w: W, h: 0.18, fill: { color: COLOR.navy } } },
    { text: {
        text: '世途旅行 · Citur Travel  ·  Week 2 Demo  ·  2026-04-29',
        options: { x: 0.5, y: 7.1, w: 8, h: 0.3, fontSize: 9, color: COLOR.muted, fontFace: FONT_BODY },
    } },
  ],
  slideNumber: { x: 12.6, y: 7.1, w: 0.4, h: 0.3, fontSize: 9, color: COLOR.muted, fontFace: FONT_BODY, align: 'right' },
});

function title(s, text) {
  s.addText(text, {
    x: 0.5, y: 0.45, w: W - 1, h: 0.85,
    fontSize: 32, bold: true, fontFace: FONT_HEAD, color: COLOR.navy,
  });
}
function subtitle(s, text) {
  s.addText(text, {
    x: 0.5, y: 1.35, w: W - 1, h: 0.4,
    fontSize: 16, fontFace: FONT_BODY, color: COLOR.muted, italic: true,
  });
}

// ─── 1: Title ───
{
  const s = pptx.addSlide();
  s.background = { color: COLOR.navy };
  s.addText('世途旅行 · Citur Travel', {
    x: 1, y: 2.2, w: W - 2, h: 0.9,
    fontSize: 56, bold: true, color: COLOR.white, fontFace: FONT_HEAD,
  });
  s.addText('Week 2 Demo · 内部演示 + 公司测试启动', {
    x: 1, y: 3.3, w: W - 2, h: 0.5,
    fontSize: 22, color: COLOR.ice, fontFace: FONT_BODY,
  });
  s.addShape(pptx.ShapeType.line, { x: 1, y: 4.0, w: 2.5, h: 0, line: { color: COLOR.coral, width: 4 } });
  s.addText('澳门 ↔ 岘港直飞航线 · 客户 / 代理 / 后台 三视角 SaaS', {
    x: 1, y: 4.3, w: W - 2, h: 0.5,
    fontSize: 16, color: COLOR.ice, fontFace: FONT_BODY, italic: true,
  });
  s.addText('2026-04-29  ·  Bob Wang', {
    x: 1, y: 6.3, w: W - 2, h: 0.4,
    fontSize: 14, color: COLOR.ice, fontFace: FONT_BODY,
  });
}

// ─── 2: Agenda ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '今天的议程');
  subtitle(s, '30–45 分钟，分三段 + 成本 + Q&A');

  const cards = [
    { label: '开场',         detail: '业务介绍\n(2 分钟)',           color: COLOR.charcoal },
    { label: '客户视角',     detail: '搜机票 → 下单 → AI 助手\n(10 分钟)', color: COLOR.green },
    { label: '代理视角',     detail: '团队管理 + 分成查看\n(10 分钟)',     color: COLOR.navy },
    { label: '管理员视角',   detail: '订单批量 + 审计日志\n(15 分钟)',     color: COLOR.coral },
    { label: '收尾 + Q&A',   detail: '成本 + 反馈\n(3 分钟)',         color: COLOR.amber },
  ];
  const cardW = 2.2, cardH = 3.2, gap = 0.3;
  const totalW = cardW * cards.length + gap * (cards.length - 1);
  const startX = (W - totalW) / 2;
  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap);
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.0, w: cardW, h: cardH, fill: { color: COLOR.cream }, line: { color: c.color, width: 1 }, rectRadius: 0.08 });
    s.addShape(pptx.ShapeType.rect, { x, y: 2.0, w: cardW, h: 0.5, fill: { color: c.color }, line: { color: c.color, width: 0 } });
    s.addText(`${i + 1}`, { x, y: 2.05, w: cardW, h: 0.4, fontSize: 16, bold: true, color: COLOR.white, fontFace: FONT_HEAD, align: 'center' });
    s.addText(c.label, { x, y: 2.7, w: cardW, h: 0.6, fontSize: 18, bold: true, color: c.color, fontFace: FONT_HEAD, align: 'center' });
    s.addText(c.detail, { x: x + 0.15, y: 3.5, w: cardW - 0.3, h: 1.5, fontSize: 11, color: COLOR.text, fontFace: FONT_BODY, align: 'center', valign: 'top' });
  });
}

// ─── 3: 业务介绍 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '我们做的是什么');
  subtitle(s, '一句话：澳门 ↔ 岘港 自营航线 + 一站式旅游 SaaS');

  s.addText('三个角色 · 三个界面', { x: 0.5, y: 1.95, w: 6, h: 0.4, fontSize: 18, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  const roles = [
    { icon: '🛒', title: '客户', text: '搜机票 / 酒店 / 接送 / 签证 / 套餐\nAI 助手对话下单' },
    { icon: '🤝', title: '代理（三级）', text: '管下级代理\n看自己 + 下级的分成结算' },
    { icon: '⚙️', title: '管理员', text: '订单管理 + 财务结算\n定价 + 履约 + 审计' },
  ];
  roles.forEach((r, i) => {
    const y = 2.5 + i * 1.4;
    s.addText(r.icon, { x: 0.5, y, w: 0.6, h: 1, fontSize: 36, align: 'center' });
    s.addText(r.title, { x: 1.2, y, w: 5, h: 0.4, fontSize: 16, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
    s.addText(r.text, { x: 1.2, y: y + 0.4, w: 5, h: 0.7, fontSize: 12, color: COLOR.text, fontFace: FONT_BODY });
  });

  s.addShape(pptx.ShapeType.roundRect, { x: 7.8, y: 1.95, w: 5, h: 4.5, fill: { color: COLOR.navy }, line: { color: COLOR.navy, width: 0 }, rectRadius: 0.1 });
  s.addText('今天演示的 staging 环境', { x: 7.95, y: 2.1, w: 4.7, h: 0.4, fontSize: 14, color: COLOR.ice, fontFace: FONT_HEAD });
  const stats = [
    { n: '5', label: '测试账号（admin / 三级代理 / 客户）' },
    { n: '6', label: 'demo 订单（覆盖全部状态）' },
    { n: '3', label: '语言（中 / 英 / 越）' },
    { n: '0', label: '元（沙盒支付，不会扣钱）' },
  ];
  stats.forEach((st, i) => {
    const y = 2.65 + i * 0.85;
    s.addText(st.n, { x: 7.95, y, w: 1, h: 0.7, fontSize: 36, bold: true, color: COLOR.coral, fontFace: FONT_HEAD });
    s.addText(st.label, { x: 9.0, y: y + 0.15, w: 3.7, h: 0.5, fontSize: 12, color: COLOR.ice, fontFace: FONT_BODY });
  });
}

// ─── 4: Section · 客户 ───
{
  const s = pptx.addSlide();
  s.background = { color: COLOR.green };
  s.addText('1', { x: 0.5, y: 0.5, w: 1, h: 1, fontSize: 96, bold: true, color: COLOR.gold, fontFace: FONT_HEAD });
  s.addText('客户视角', { x: 0.5, y: 2.8, w: W - 1, h: 1, fontSize: 64, bold: true, color: COLOR.white, fontFace: FONT_HEAD });
  s.addText('搜机票 → 结账 → AI 助手下单 (10 分钟)', { x: 0.5, y: 3.9, w: W - 1, h: 0.5, fontSize: 22, color: COLOR.gold, fontFace: FONT_BODY, italic: true });
  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 4.6, w: 3, h: 0, line: { color: COLOR.gold, width: 5 } });
}

// ─── 5: 客户三步骤 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '客户视角 · 三步');
  subtitle(s, '不登录也能搜，下单时才要登入；AI 助手是亮点');

  const steps = [
    { num: '01', label: '搜机票（不登录）', bullets: ['首页五大块：机票/酒店/接送/签证/套餐', '搜索 MFM → DAD，点商务舱', '动态价格 + 限时优惠标识', '加购 → 进结账'] },
    { num: '02', label: '登入下单', bullets: ['账号 customer@ftm.local', '填联系信息 + 乘客信息', '乘客数 = 票数（少了系统拦）', '沙盒支付成功 → 我的订单'] },
    { num: '03', label: 'AI 助手对话', bullets: ['「明天 2 个人去岘港，要往返」', 'AI 给方案 + 价格', '点 OK · 看详情 → 确认下单', '一句话搞定，不用打开 5 个页面'] },
  ];
  const cardW = 4.0, cardH = 4.8, gap = 0.4;
  const totalW = cardW * 3 + gap * 2;
  const startX = (W - totalW) / 2;
  steps.forEach((st, i) => {
    const x = startX + i * (cardW + gap);
    s.addShape(pptx.ShapeType.roundRect, { x, y: 1.95, w: cardW, h: cardH, fill: { color: COLOR.cream }, line: { color: COLOR.green, width: 1 }, rectRadius: 0.1 });
    s.addText(st.num, { x: x + 0.3, y: 2.05, w: 1, h: 0.7, fontSize: 36, bold: true, color: COLOR.green, fontFace: FONT_HEAD });
    s.addText(st.label, { x: x + 0.3, y: 2.75, w: cardW - 0.6, h: 0.5, fontSize: 17, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
    s.addText(st.bullets.map(b => ({ text: b, options: { bullet: true } })), { x: x + 0.3, y: 3.3, w: cardW - 0.6, h: cardH - 1.5, fontSize: 12, color: COLOR.text, fontFace: FONT_BODY, paraSpaceAfter: 4 });
  });
}

// ─── 6: Section · 代理 ───
{
  const s = pptx.addSlide();
  s.background = { color: COLOR.navy };
  s.addText('2', { x: 0.5, y: 0.5, w: 1, h: 1, fontSize: 96, bold: true, color: COLOR.coral, fontFace: FONT_HEAD });
  s.addText('代理视角', { x: 0.5, y: 2.8, w: W - 1, h: 1, fontSize: 64, bold: true, color: COLOR.white, fontFace: FONT_HEAD });
  s.addText('团队管理 + 我的分成（核心新功能）(10 分钟)', { x: 0.5, y: 3.9, w: W - 1, h: 0.5, fontSize: 22, color: COLOR.ice, fontFace: FONT_BODY, italic: true });
  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 4.6, w: 3, h: 0, line: { color: COLOR.coral, width: 5 } });
}

// ─── 7: 我的分成 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '我的分成 · 核心新功能');
  subtitle(s, '按层级看自己 + 全部下级的结算单 + 佣金明细');

  const kpis = [
    { val: 'KPI 1', label: '我的应得佣金', color: COLOR.green },
    { val: 'KPI 2', label: '下级累计佣金', color: COLOR.navy },
    { val: 'KPI 3', label: '待打款金额',   color: COLOR.amber },
    { val: 'KPI 4', label: '结算单总数',   color: COLOR.charcoal },
  ];
  const kw = 2.85, gap = 0.2;
  kpis.forEach((k, i) => {
    const x = 0.5 + i * (kw + gap);
    s.addShape(pptx.ShapeType.rect, { x, y: 2.0, w: kw, h: 0.18, fill: { color: k.color }, line: { color: k.color, width: 0 } });
    s.addShape(pptx.ShapeType.rect, { x, y: 2.18, w: kw, h: 1.1, fill: { color: COLOR.cream }, line: { color: COLOR.cream, width: 0 } });
    s.addText(k.label, { x: x + 0.15, y: 2.25, w: kw - 0.3, h: 0.4, fontSize: 11, color: COLOR.muted, fontFace: FONT_BODY });
    s.addText(k.val, { x: x + 0.15, y: 2.65, w: kw - 0.3, h: 0.6, fontSize: 20, bold: true, color: k.color, fontFace: FONT_HEAD });
  });

  s.addText('三级 RBAC：每个层级看到不同的范围', { x: 0.5, y: 3.6, w: W - 1, h: 0.4, fontSize: 16, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  const rbac = [
    { tier: '一级代理', see: '自己 + 二级 + 三级\n（看全网）', color: COLOR.coral },
    { tier: '二级代理', see: '自己 + 三级\n（看不到一级）',     color: COLOR.amber },
    { tier: '三级代理', see: '只看自己\n（不看下级）',           color: COLOR.green },
  ];
  const rw = 4.0, rgap = 0.3;
  const rTotal = rw * 3 + rgap * 2;
  const rStart = (W - rTotal) / 2;
  rbac.forEach((r, i) => {
    const x = rStart + i * (rw + rgap);
    s.addShape(pptx.ShapeType.roundRect, { x, y: 4.1, w: rw, h: 2.4, fill: { color: COLOR.white }, line: { color: r.color, width: 2 }, rectRadius: 0.08 });
    s.addShape(pptx.ShapeType.ellipse, { x: x + rw / 2 - 0.4, y: 4.3, w: 0.8, h: 0.8, fill: { color: r.color }, line: { color: r.color, width: 0 } });
    s.addText(`${i + 1}`, { x: x + rw / 2 - 0.4, y: 4.32, w: 0.8, h: 0.8, fontSize: 32, bold: true, color: COLOR.white, fontFace: FONT_HEAD, align: 'center' });
    s.addText(r.tier, { x: x + 0.2, y: 5.25, w: rw - 0.4, h: 0.4, fontSize: 16, bold: true, color: r.color, fontFace: FONT_HEAD, align: 'center' });
    s.addText(r.see, { x: x + 0.2, y: 5.7, w: rw - 0.4, h: 0.7, fontSize: 12, color: COLOR.text, fontFace: FONT_BODY, align: 'center' });
  });
}

// ─── 8: Section · 管理员 ───
{
  const s = pptx.addSlide();
  s.background = { color: COLOR.coral };
  s.addText('3', { x: 0.5, y: 0.5, w: 1, h: 1, fontSize: 96, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  s.addText('管理员视角', { x: 0.5, y: 2.8, w: W - 1, h: 1, fontSize: 64, bold: true, color: COLOR.white, fontFace: FONT_HEAD });
  s.addText('订单批量管理 + 审计日志中文化 (15 分钟)', { x: 0.5, y: 3.9, w: W - 1, h: 0.5, fontSize: 22, color: COLOR.cream, fontFace: FONT_BODY, italic: true });
  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 4.6, w: 3, h: 0, line: { color: COLOR.navy, width: 5 } });
}

// ─── 9: 批量改状态 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '订单批量改状态 · 核心新功能');
  subtitle(s, '一次最多 100 单；支持强制模式绕过状态机校验');

  s.addText('支持的操作', { x: 0.5, y: 1.95, w: 6, h: 0.4, fontSize: 16, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  const ops = [
    { icon: '☑', txt: '表头全选 / 反选 / indeterminate' },
    { icon: '🎯', txt: '批量工具条选目标状态 + 应用' },
    { icon: '⚡', txt: '行内"改状态…"下拉单条快改' },
    { icon: '🔓', txt: '强制模式（绕过状态机）' },
    { icon: '📊', txt: '失败明细面板（per-id 报错）' },
    { icon: '📝', txt: '所有操作进 audit log（WARNING）' },
  ];
  ops.forEach((o, i) => {
    const y = 2.45 + i * 0.55;
    s.addText(o.icon, { x: 0.6, y, w: 0.45, h: 0.45, fontSize: 20, color: COLOR.coral, fontFace: FONT_HEAD, align: 'center' });
    s.addText(o.txt, { x: 1.15, y: y + 0.05, w: 5.4, h: 0.4, fontSize: 13, color: COLOR.text, fontFace: FONT_BODY });
  });

  s.addShape(pptx.ShapeType.roundRect, { x: 7.2, y: 1.95, w: 5.6, h: 4.6, fill: { color: COLOR.cream }, line: { color: COLOR.navy, width: 1 }, rectRadius: 0.1 });
  s.addText('订单状态机', { x: 7.4, y: 2.1, w: 5.2, h: 0.4, fontSize: 14, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  const states = [
    { lbl: '待支付', color: COLOR.amber },
    { lbl: '已支付', color: COLOR.green },
    { lbl: '处理中', color: COLOR.navy  },
    { lbl: '已出票', color: COLOR.green },
    { lbl: '已完成', color: COLOR.charcoal },
  ];
  states.forEach((st, i) => {
    const y = 2.65 + i * 0.7;
    s.addShape(pptx.ShapeType.roundRect, { x: 7.5, y, w: 1.5, h: 0.55, fill: { color: st.color }, line: { color: st.color, width: 0 }, rectRadius: 0.05 });
    s.addText(st.lbl, { x: 7.5, y, w: 1.5, h: 0.55, fontSize: 13, bold: true, color: COLOR.white, fontFace: FONT_BODY, align: 'center', valign: 'middle' });
  });
  s.addText('强制模式 = 绕过整个流程图', { x: 9.5, y: 4.5, w: 3.2, h: 0.4, fontSize: 12, italic: true, color: COLOR.coral, fontFace: FONT_BODY, bold: true });
  s.addText('（仅 ADMIN 可用，进 WARNING 审计）', { x: 9.5, y: 4.85, w: 3.2, h: 0.4, fontSize: 11, italic: true, color: COLOR.muted, fontFace: FONT_BODY });
}

// ─── 10: 审计日志 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '审计日志中文化 · 核心新功能');
  subtitle(s, '后端记录的还是结构化数据；前端这层负责翻译成人话');

  s.addText('改之前', { x: 0.5, y: 1.95, w: 6, h: 0.4, fontSize: 16, bold: true, color: COLOR.red, fontFace: FONT_HEAD });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 2.45, w: 6, h: 4.0, fill: { color: 'FFF1F0' }, line: { color: COLOR.red, width: 1 }, rectRadius: 0.08 });
  s.addText([
    { text: 'BATCH_FORCE_ORDER_STATUS\n', options: { fontFace: 'Consolas', fontSize: 13, color: COLOR.red, bold: true } },
    { text: '{\n  "toStatus":"PAID",\n  "force":true,\n  "requestedCount":3,\n  "successCount":3,\n  "failureCount":0\n}', options: { fontFace: 'Consolas', fontSize: 11, color: COLOR.charcoal } },
  ], { x: 0.7, y: 2.65, w: 5.6, h: 3.2, valign: 'top' });
  s.addText('看不懂、没法 audit、找不到事故。', { x: 0.7, y: 6.0, w: 5.6, h: 0.4, fontSize: 12, italic: true, color: COLOR.red, fontFace: FONT_BODY });

  s.addText('改之后', { x: 6.85, y: 1.95, w: 6, h: 0.4, fontSize: 16, bold: true, color: COLOR.green, fontFace: FONT_HEAD });
  s.addShape(pptx.ShapeType.roundRect, { x: 6.85, y: 2.45, w: 6, h: 4.0, fill: { color: 'F0F9F4' }, line: { color: COLOR.green, width: 1 }, rectRadius: 0.08 });
  s.addText([
    { text: '⚠️ 批量强制改状态\n\n', options: { fontSize: 16, color: COLOR.amber, bold: true, fontFace: FONT_HEAD } },
    { text: '· 目标状态: 已支付\n', options: { fontSize: 14, color: COLOR.text, fontFace: FONT_BODY } },
    { text: '+ 强制模式: 是（绕过状态机）\n', options: { fontSize: 14, color: COLOR.green, fontFace: FONT_BODY } },
    { text: '· 请求条数: 3\n· 成功: 3\n· 失败: 0\n', options: { fontSize: 14, color: COLOR.text, fontFace: FONT_BODY } },
  ], { x: 7.05, y: 2.65, w: 5.6, h: 3.2, valign: 'top' });
  s.addText('一眼看懂；点开抽屉有彩色 diff + 原始 JSON 折叠区。', { x: 7.05, y: 6.0, w: 5.6, h: 0.4, fontSize: 12, italic: true, color: COLOR.green, fontFace: FONT_BODY });
}

// ─── 11: 成本核算 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '成本核算');
  subtitle(s, '已花 ~$5,000；公测期月成本 ~$1,000；稳定期 ~$5,000');

  s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 2.0, w: 4.0, h: 1.4, fill: { color: COLOR.navy }, line: { color: COLOR.navy, width: 0 }, rectRadius: 0.1 });
  s.addText('已花成本（开发期）', { x: 0.7, y: 2.15, w: 3.6, h: 0.3, fontSize: 12, color: COLOR.ice, fontFace: FONT_BODY });
  s.addText('$5,000+', { x: 0.7, y: 2.5, w: 3.6, h: 0.7, fontSize: 36, bold: true, color: COLOR.coral, fontFace: FONT_HEAD });
  s.addText('AI 占 64% · 服务器 ~4% · 工具/其他 32%', { x: 0.7, y: 3.1, w: 3.6, h: 0.3, fontSize: 11, color: COLOR.ice, fontFace: FONT_BODY });

  const stages = [
    { lbl: '阶段 A · 内部测试',   ai: '$20-50',     server: '$32',    cdn: '$0',    other: '$5',         total: '~$60',   color: COLOR.green },
    { lbl: '阶段 B · 公测期',     ai: '$300-800',   server: '$80-120', cdn: '$0-20', other: '$130-220',   total: '~$1,000', color: COLOR.navy },
    { lbl: '阶段 C · 稳定期',     ai: '$2K-5K',     server: '$200-300', cdn: '$20-200', other: '$630-1,130', total: '~$5,000', color: COLOR.coral },
  ];
  const cols = [
    { x: 4.7, w: 2.4, label: '阶段' },
    { x: 7.1, w: 1.4, label: 'AI/Token' },
    { x: 8.5, w: 1.2, label: '服务器' },
    { x: 9.7, w: 1.0, label: 'CDN' },
    { x: 10.7, w: 1.2, label: '其他' },
    { x: 11.9, w: 0.95, label: '合计' },
  ];
  cols.forEach(c => {
    s.addShape(pptx.ShapeType.rect, { x: c.x, y: 2.0, w: c.w, h: 0.4, fill: { color: COLOR.navy }, line: { color: COLOR.navy, width: 0 } });
    s.addText(c.label, { x: c.x, y: 2.0, w: c.w, h: 0.4, fontSize: 11, bold: true, color: COLOR.white, fontFace: FONT_HEAD, align: 'center', valign: 'middle' });
  });
  stages.forEach((st, i) => {
    const y = 2.4 + i * 0.5;
    const cells = [st.lbl, st.ai, st.server, st.cdn, st.other, st.total];
    cols.forEach((c, ci) => {
      s.addShape(pptx.ShapeType.rect, { x: c.x, y, w: c.w, h: 0.5, fill: { color: i % 2 === 0 ? COLOR.cream : COLOR.white }, line: { color: 'CCCCCC', width: 0.5 } });
      s.addText(cells[ci], { x: c.x + 0.05, y, w: c.w - 0.1, h: 0.5, fontSize: ci === cols.length - 1 ? 12 : 10, bold: ci === cols.length - 1 || ci === 0, color: ci === cols.length - 1 ? st.color : COLOR.text, fontFace: FONT_BODY, align: ci === 0 ? 'left' : 'center', valign: 'middle' });
    });
  });

  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 4.5, w: W - 1, h: 0, line: { color: COLOR.navy, width: 1 } });
  s.addText('单位经济学（毛利 vs 成本）', { x: 0.5, y: 4.65, w: W - 1, h: 0.4, fontSize: 16, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  const ue = [
    { stage: '公测期', profit: '$3,900',  cost: '$1,000', cover: '4×' },
    { stage: '稳定期', profit: '$42,000', cost: '$5,000', cover: '8×' },
    { stage: '规模化', profit: '$220K',   cost: '$10K',   cover: '22×' },
  ];
  const ueW = 4.0, ueGap = 0.3;
  const ueTotal = ueW * 3 + ueGap * 2;
  const ueStart = (W - ueTotal) / 2;
  ue.forEach((u, i) => {
    const x = ueStart + i * (ueW + ueGap);
    s.addShape(pptx.ShapeType.roundRect, { x, y: 5.15, w: ueW, h: 1.4, fill: { color: COLOR.cream }, line: { color: COLOR.green, width: 1 }, rectRadius: 0.08 });
    s.addText(u.stage, { x: x + 0.2, y: 5.25, w: ueW - 0.4, h: 0.3, fontSize: 12, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
    s.addText(`月毛利 ${u.profit}`, { x: x + 0.2, y: 5.55, w: ueW - 0.4, h: 0.3, fontSize: 11, color: COLOR.green, fontFace: FONT_BODY });
    s.addText(`月成本 ${u.cost}`, { x: x + 0.2, y: 5.85, w: ueW - 0.4, h: 0.3, fontSize: 11, color: COLOR.muted, fontFace: FONT_BODY });
    s.addText(`覆盖 ${u.cover}`, { x: x + 0.2, y: 6.15, w: ueW - 0.4, h: 0.3, fontSize: 14, bold: true, color: COLOR.coral, fontFace: FONT_HEAD });
  });
}

// ─── 12: AI Token ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, 'AI 成本拆解 · 主要是 token');
  subtitle(s, 'Claude Sonnet 4.6：输入 $3 / 1M，输出 $15 / 1M。Prompt caching 可省 36%');

  s.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 2.0, w: 6, h: 4.5, fill: { color: COLOR.cream }, line: { color: COLOR.navy, width: 1 }, rectRadius: 0.1 });
  s.addText('单次对话成本（5 轮平均）', { x: 0.7, y: 2.15, w: 5.6, h: 0.4, fontSize: 16, bold: true, color: COLOR.navy, fontFace: FONT_HEAD });
  s.addText('不带缓存', { x: 0.7, y: 2.7, w: 5.6, h: 0.3, fontSize: 12, italic: true, color: COLOR.muted, fontFace: FONT_BODY });
  s.addText([
    { text: '输入 ', options: { fontSize: 13, color: COLOR.text } },
    { text: '10K tokens', options: { fontSize: 13, color: COLOR.navy, bold: true } },
    { text: ' × $3 = ', options: { fontSize: 13, color: COLOR.text } },
    { text: '$0.030', options: { fontSize: 13, color: COLOR.green, bold: true } },
  ], { x: 0.7, y: 3.0, w: 5.6, h: 0.35 });
  s.addText([
    { text: '输出 ', options: { fontSize: 13, color: COLOR.text } },
    { text: '2.5K tokens', options: { fontSize: 13, color: COLOR.navy, bold: true } },
    { text: ' × $15 = ', options: { fontSize: 13, color: COLOR.text } },
    { text: '$0.038', options: { fontSize: 13, color: COLOR.green, bold: true } },
  ], { x: 0.7, y: 3.35, w: 5.6, h: 0.35 });
  s.addText('合计 ~$0.067', { x: 0.7, y: 3.7, w: 5.6, h: 0.4, fontSize: 16, bold: true, color: COLOR.coral, fontFace: FONT_HEAD });

  s.addText('启用 prompt caching', { x: 0.7, y: 4.3, w: 5.6, h: 0.3, fontSize: 12, italic: true, color: COLOR.muted, fontFace: FONT_BODY });
  s.addText('缓存命中（90%）打 1 折 + 全价输入 + 输出', { x: 0.7, y: 4.6, w: 5.6, h: 0.35, fontSize: 12, color: COLOR.text, fontFace: FONT_BODY });
  s.addText('合计 ~$0.043 （省 36%）', { x: 0.7, y: 5.0, w: 5.6, h: 0.4, fontSize: 16, bold: true, color: COLOR.green, fontFace: FONT_HEAD });
  s.addText('实际经验值：$0.013 ~ $0.05 / 对话', { x: 0.7, y: 5.7, w: 5.6, h: 0.4, fontSize: 12, italic: true, color: COLOR.muted, fontFace: FONT_BODY });

  s.addShape(pptx.ShapeType.roundRect, { x: 6.85, y: 2.0, w: 6.0, h: 4.5, fill: { color: COLOR.navy }, line: { color: COLOR.navy, width: 0 }, rectRadius: 0.1 });
  s.addText('对话量 → 月成本（含缓存）', { x: 7.05, y: 2.15, w: 5.6, h: 0.4, fontSize: 16, bold: true, color: COLOR.ice, fontFace: FONT_HEAD });
  const scale = [
    { d: '50 / 天',    m: '$65',    stage: '内测' },
    { d: '500 / 天',   m: '$650',   stage: '公测' },
    { d: '2,000 / 天', m: '$2,600', stage: '稳定' },
    { d: '5,000 / 天', m: '$6,500', stage: '规模化' },
  ];
  scale.forEach((sc, i) => {
    const y = 2.85 + i * 0.85;
    s.addText(sc.d, { x: 7.05, y, w: 1.8, h: 0.5, fontSize: 14, bold: true, color: COLOR.gold, fontFace: FONT_HEAD, valign: 'middle' });
    s.addText(sc.m, { x: 8.95, y, w: 1.8, h: 0.5, fontSize: 18, bold: true, color: COLOR.white, fontFace: FONT_HEAD, align: 'center', valign: 'middle' });
    s.addText(sc.stage, { x: 10.85, y, w: 1.8, h: 0.5, fontSize: 12, italic: true, color: COLOR.ice, fontFace: FONT_BODY, valign: 'middle' });
  });
}

// ─── 13: 反馈 ───
{
  const s = pptx.addSlide({ masterName: 'CONTENT' });
  title(s, '怎么报问题');
  subtitle(s, 'GitHub 仓库 docs/presentation/week-2/FEEDBACK.docx → 紧急直接微信');

  const levels = [
    { lvl: 'P0', label: '阻断公测', eg: '登入失败 / 下单按钮没反应 / 后台白屏', color: COLOR.red },
    { lvl: 'P1', label: '严重缺陷', eg: '价格算错 / 状态流转出错 / 中文乱码',   color: COLOR.amber },
    { lvl: 'P2', label: '一般缺陷', eg: 'UI 错位 / 翻译不全 / loading 不消失',  color: COLOR.green },
    { lvl: 'P3', label: '改进建议', eg: '文案不顺 / 按钮位置可优化',            color: COLOR.charcoal },
  ];
  levels.forEach((lv, i) => {
    const y = 2.0 + i * 1.0;
    s.addShape(pptx.ShapeType.rect, { x: 0.5, y, w: 0.9, h: 0.85, fill: { color: lv.color }, line: { color: lv.color, width: 0 } });
    s.addText(lv.lvl, { x: 0.5, y, w: 0.9, h: 0.85, fontSize: 28, bold: true, color: COLOR.white, fontFace: FONT_HEAD, align: 'center', valign: 'middle' });
    s.addText(lv.label, { x: 1.55, y, w: 2.5, h: 0.4, fontSize: 16, bold: true, color: lv.color, fontFace: FONT_HEAD, valign: 'top' });
    s.addText(lv.eg, { x: 1.55, y: y + 0.4, w: 11, h: 0.45, fontSize: 13, color: COLOR.text, fontFace: FONT_BODY });
  });

  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 6.2, w: W - 1, h: 0, line: { color: COLOR.navy, width: 1 } });
  s.addText('Bob 每天 EOD 看一次 → 改一波 → 周末重 deploy', { x: 0.5, y: 6.4, w: W - 1, h: 0.4, fontSize: 14, italic: true, color: COLOR.muted, fontFace: FONT_BODY, align: 'center' });
}

// ─── 14: Q&A ───
{
  const s = pptx.addSlide();
  s.background = { color: COLOR.navy };
  s.addShape(pptx.ShapeType.line, { x: 0.5, y: 1.0, w: 2.5, h: 0, line: { color: COLOR.coral, width: 4 } });
  s.addText('Q & A', { x: 0.5, y: 1.4, w: W - 1, h: 1.5, fontSize: 84, bold: true, color: COLOR.white, fontFace: FONT_HEAD });
  s.addText('一句话给团队听：', { x: 0.5, y: 3.4, w: W - 1, h: 0.4, fontSize: 18, color: COLOR.gold, fontFace: FONT_BODY });
  s.addText([
    { text: '前期开发烧了 ~$5,000，主要是 AI 调用。\n', options: { fontSize: 22, color: COLOR.white, fontFace: FONT_BODY } },
    { text: '公测期月成本 ~$1,000；稳定后 ~$5,000。\n', options: { fontSize: 22, color: COLOR.white, fontFace: FONT_BODY } },
    { text: '公测预计 100 单/月，月毛利 ~$3,900，覆盖成本 4×。\n', options: { fontSize: 22, color: COLOR.white, fontFace: FONT_BODY } },
    { text: '\n', options: {} },
    { text: '关键不是控成本，是订单量做起来。', options: { fontSize: 26, color: COLOR.coral, bold: true, italic: true, fontFace: FONT_BODY } },
  ], { x: 0.5, y: 3.85, w: W - 1, h: 2.5 });
  s.addText('Bob Wang  ·  2026-04-29  ·  staging http://47.83.249.163/', { x: 0.5, y: 6.7, w: W - 1, h: 0.4, fontSize: 12, color: COLOR.ice, italic: true, fontFace: FONT_BODY, align: 'center' });
}

pptx.writeFile({ fileName: OUT }).then(() => {
  const stat = fs.statSync(OUT);
  console.log(`Saved: ${OUT}  (${stat.size.toLocaleString()} bytes)`);
});
