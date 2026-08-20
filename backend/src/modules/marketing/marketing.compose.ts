/**
 * 海报服务端合成层。
 *
 * 生图模型只提供背景；所有航班号、时刻、航线、生效日期、行李额和运营文案
 * 都在这里由代码绘制。该模块不做网络调用，给定相同输入会产生相同的绘制结果。
 */
import { existsSync } from 'node:fs';
import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import type { FlightRouteSummary, LegSummary } from './marketing.facts.js';
import type { PosterTemplateKey } from './marketing.templates.js';

export const POSTER_WIDTH = 1080;
export const POSTER_HEIGHT = 1440;
export const POSTER_FONT_FAMILY = 'PosterCJK';

type PosterTextAlign = 'left' | 'center' | 'right';

export interface PosterTextLayout {
  /** 相对卡片或画布左上角的 x 坐标 */
  x: number;
  /** 相对卡片或画布左上角的 y 坐标 */
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: PosterTextAlign;
  lineHeight: number;
  maxLines?: number;
  /** 可读字号下限；关键字段低于此字号会让合成失败。 */
  minFontSize?: number;
  critical?: boolean;
}

export interface PosterPanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface PosterCardLayout extends PosterPanelLayout {}

export interface PosterLayout {
  key: PosterTemplateKey;
  header: PosterPanelLayout;
  title: PosterTextLayout;
  effectiveFrom: PosterTextLayout;
  card: {
    single: PosterCardLayout;
    two: readonly [PosterCardLayout, PosterCardLayout];
  };
  cardLabel: PosterTextLayout;
  cardFlightNumber: PosterTextLayout;
  cardRoute: PosterTextLayout;
  cardTime: PosterTextLayout;
  footer: PosterPanelLayout;
  baggage: PosterTextLayout;
  extraNote: PosterTextLayout;
}

export interface PosterLegContent {
  flightNumber: string;
  route: string;
  time: string;
}

export interface PosterContent {
  title: string;
  effectiveFrom: string | null;
  outbound: PosterLegContent;
  inbound: PosterLegContent | null;
  baggageText: string | null;
  extraNote: string | null;
}

export interface ComposePosterResult {
  png: Buffer;
  truncated: string[];
}
const OCEAN_CARD: PosterCardLayout = {
  x: 54,
  y: 370,
  width: 455,
  height: 360,
  radius: 28,
  fill: 'rgba(7, 26, 58, 0.88)',
  stroke: '#dfb86c',
  strokeWidth: 3,
};
const OCEAN_CARD_RIGHT: PosterCardLayout = {
  ...OCEAN_CARD,
  x: 571,
};

const SUNNY_CARD: PosterCardLayout = {
  x: 54,
  y: 370,
  width: 446,
  height: 370,
  radius: 34,
  fill: 'rgba(255, 255, 255, 0.84)',
  stroke: 'rgba(255, 255, 255, 0.98)',
  strokeWidth: 3,
};
const SUNNY_CARD_RIGHT: PosterCardLayout = {
  ...SUNNY_CARD,
  x: 580,
};

const MINIMAL_CARD: PosterCardLayout = {
  x: 54,
  y: 382,
  width: 446,
  height: 360,
  radius: 18,
  fill: 'rgba(248, 241, 226, 0.94)',
  stroke: '#29483e',
  strokeWidth: 2,
};
const MINIMAL_CARD_RIGHT: PosterCardLayout = {
  ...MINIMAL_CARD,
  x: 580,
};

const TEXT_WIDTH = 402;

export const POSTER_LAYOUTS: Record<PosterTemplateKey, PosterLayout> = {
  OCEAN_GOLD: {
    key: 'OCEAN_GOLD',
    header: {
      x: 54,
      y: 52,
      width: 972,
      height: 230,
      radius: 32,
      fill: 'rgba(3, 18, 45, 0.8)',
      stroke: '#dfb86c',
      strokeWidth: 2,
    },
    title: {
      x: 86,
      y: 78,
      width: 908,
      height: 88,
      fontSize: 70,
      fontWeight: 700,
      color: '#fff8e6',
      align: 'center',
      lineHeight: 1.08,
      maxLines: 2,
    },
    effectiveFrom: {
      x: 86,
      y: 178,
      width: 908,
      height: 64,
      fontSize: 42,
      fontWeight: 700,
      color: '#f2c875',
      align: 'center',
      lineHeight: 1.12,
      maxLines: 1,
    },
    card: { single: { ...OCEAN_CARD, x: 170, y: 390, width: 740 }, two: [OCEAN_CARD, OCEAN_CARD_RIGHT] },
    cardLabel: {
      x: 30,
      y: 28,
      width: TEXT_WIDTH,
      height: 38,
      fontSize: 25,
      fontWeight: 700,
      color: '#f2c875',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 1,
    },
    cardFlightNumber: {
      x: 30,
      y: 70,
      width: TEXT_WIDTH,
      height: 66,
      fontSize: 54,
      fontWeight: 700,
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.08,
      maxLines: 1,
      minFontSize: 32,
      critical: true,
    },
    cardRoute: {
      x: 30,
      y: 151,
      width: TEXT_WIDTH,
      height: 70,
      fontSize: 34,
      fontWeight: 700,
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.12,
      maxLines: 2,
    },
    cardTime: {
      x: 30,
      y: 238,
      width: TEXT_WIDTH,
      height: 62,
      fontSize: 32,
      fontWeight: 700,
      color: '#f2c875',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 2,
      minFontSize: 22,
      critical: true,
    },
    footer: {
      x: 54,
      y: 900,
      width: 972,
      height: 220,
      radius: 30,
      fill: 'rgba(3, 18, 45, 0.84)',
      stroke: '#dfb86c',
      strokeWidth: 2,
    },
    baggage: {
      x: 34,
      y: 34,
      width: 904,
      height: 64,
      fontSize: 31,
      fontWeight: 700,
      color: '#fff8e6',
      align: 'left',
      lineHeight: 1.15,
      maxLines: 2,
    },
    extraNote: {
      x: 34,
      y: 112,
      width: 904,
      height: 76,
      fontSize: 25,
      fontWeight: 500,
      color: '#f2c875',
      align: 'left',
      lineHeight: 1.22,
      maxLines: 2,
    },
  },
  SUNNY_TROPICAL: {
    key: 'SUNNY_TROPICAL',
    header: {
      x: 48,
      y: 46,
      width: 984,
      height: 236,
      radius: 38,
      fill: 'rgba(255, 255, 255, 0.78)',
      stroke: '#ffffff',
      strokeWidth: 2,
    },
    title: {
      x: 78,
      y: 74,
      width: 924,
      height: 90,
      fontSize: 72,
      fontWeight: 800,
      color: '#103c52',
      align: 'center',
      lineHeight: 1.08,
      maxLines: 2,
    },
    effectiveFrom: {
      x: 78,
      y: 178,
      width: 924,
      height: 64,
      fontSize: 40,
      fontWeight: 800,
      color: '#ee8d2d',
      align: 'center',
      lineHeight: 1.12,
      maxLines: 1,
    },
    card: { single: { ...SUNNY_CARD, x: 170, y: 390, width: 740 }, two: [SUNNY_CARD, SUNNY_CARD_RIGHT] },
    cardLabel: {
      x: 30,
      y: 28,
      width: TEXT_WIDTH,
      height: 38,
      fontSize: 25,
      fontWeight: 800,
      color: '#ee8d2d',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 1,
    },
    cardFlightNumber: {
      x: 30,
      y: 70,
      width: TEXT_WIDTH,
      height: 66,
      fontSize: 54,
      fontWeight: 800,
      color: '#103c52',
      align: 'left',
      lineHeight: 1.08,
      maxLines: 1,
      minFontSize: 32,
      critical: true,
    },
    cardRoute: {
      x: 30,
      y: 151,
      width: TEXT_WIDTH,
      height: 72,
      fontSize: 34,
      fontWeight: 700,
      color: '#103c52',
      align: 'left',
      lineHeight: 1.12,
      maxLines: 2,
    },
    cardTime: {
      x: 30,
      y: 244,
      width: TEXT_WIDTH,
      height: 64,
      fontSize: 32,
      fontWeight: 800,
      color: '#0b7c88',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 2,
      minFontSize: 22,
      critical: true,
    },
    footer: {
      x: 48,
      y: 900,
      width: 984,
      height: 220,
      radius: 34,
      fill: 'rgba(255, 255, 255, 0.84)',
      stroke: '#ffffff',
      strokeWidth: 2,
    },
    baggage: {
      x: 34,
      y: 34,
      width: 916,
      height: 64,
      fontSize: 31,
      fontWeight: 800,
      color: '#103c52',
      align: 'left',
      lineHeight: 1.15,
      maxLines: 2,
    },
    extraNote: {
      x: 34,
      y: 112,
      width: 916,
      height: 76,
      fontSize: 25,
      fontWeight: 600,
      color: '#0b7c88',
      align: 'left',
      lineHeight: 1.22,
      maxLines: 2,
    },
  },
  MINIMAL_EDITORIAL: {
    key: 'MINIMAL_EDITORIAL',
    header: {
      x: 68,
      y: 58,
      width: 944,
      height: 224,
      radius: 18,
      fill: 'rgba(248, 241, 226, 0.92)',
      stroke: '#29483e',
      strokeWidth: 2,
    },
    title: {
      x: 96,
      y: 82,
      width: 888,
      height: 84,
      fontSize: 64,
      fontWeight: 700,
      color: '#29483e',
      align: 'center',
      lineHeight: 1.08,
      maxLines: 2,
    },
    effectiveFrom: {
      x: 96,
      y: 180,
      width: 888,
      height: 60,
      fontSize: 36,
      fontWeight: 700,
      color: '#b96e3d',
      align: 'center',
      lineHeight: 1.12,
      maxLines: 1,
    },
    card: { single: { ...MINIMAL_CARD, x: 170, y: 400, width: 740 }, two: [MINIMAL_CARD, MINIMAL_CARD_RIGHT] },
    cardLabel: {
      x: 28,
      y: 28,
      width: TEXT_WIDTH,
      height: 36,
      fontSize: 23,
      fontWeight: 700,
      color: '#b96e3d',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 1,
    },
    cardFlightNumber: {
      x: 28,
      y: 70,
      width: TEXT_WIDTH,
      height: 64,
      fontSize: 52,
      fontWeight: 700,
      color: '#29483e',
      align: 'left',
      lineHeight: 1.08,
      maxLines: 1,
      minFontSize: 32,
      critical: true,
    },
    cardRoute: {
      x: 28,
      y: 148,
      width: TEXT_WIDTH,
      height: 72,
      fontSize: 33,
      fontWeight: 700,
      color: '#29483e',
      align: 'left',
      lineHeight: 1.12,
      maxLines: 2,
    },
    cardTime: {
      x: 28,
      y: 238,
      width: TEXT_WIDTH,
      height: 64,
      fontSize: 31,
      fontWeight: 700,
      color: '#b96e3d',
      align: 'left',
      lineHeight: 1.1,
      maxLines: 2,
      minFontSize: 22,
      critical: true,
    },
    footer: {
      x: 68,
      y: 900,
      width: 944,
      height: 220,
      radius: 18,
      fill: 'rgba(248, 241, 226, 0.94)',
      stroke: '#29483e',
      strokeWidth: 2,
    },
    baggage: {
      x: 30,
      y: 32,
      width: 884,
      height: 64,
      fontSize: 30,
      fontWeight: 700,
      color: '#29483e',
      align: 'left',
      lineHeight: 1.15,
      maxLines: 2,
    },
    extraNote: {
      x: 30,
      y: 112,
      width: 884,
      height: 76,
      fontSize: 24,
      fontWeight: 500,
      color: '#b96e3d',
      align: 'left',
      lineHeight: 1.22,
      maxLines: 2,
    },
  },
};

const FONT_CANDIDATES = [
  '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/PingFang.ttc',
] as const;

let registeredFontPath: string | null = null;

/** 找到并注册中文字体；模块级缓存保证一个进程只注册一次。 */
export function getPosterFontPath(): string {
  if (registeredFontPath) return registeredFontPath;

  const configured = process.env.POSTER_FONT_PATH?.trim();
  const candidates = configured ? [configured] : FONT_CANDIDATES;
  const fontPath = candidates.find((candidate) => existsSync(candidate));
  if (!fontPath) {
    const source = configured ? `POSTER_FONT_PATH=${configured}` : '默认候选路径';
    throw new Error(
      `未找到中文海报字体（${source}）。请安装 NotoSansCJK 或配置有效的 POSTER_FONT_PATH，` +
        '否则海报无法安全渲染。',
    );
  }

  const key = GlobalFonts.registerFromPath(fontPath, POSTER_FONT_FAMILY);
  if (!key || !GlobalFonts.has(POSTER_FONT_FAMILY)) {
    throw new Error(`中文海报字体注册失败：${fontPath}。请检查字体文件和运行环境。`);
  }

  const smoke = createCanvas(320, 96);
  const smokeCtx = smoke.getContext('2d');
  smokeCtx.font = `48px ${POSTER_FONT_FAMILY}`;
  const glyphs = ['中', '文', '海', '报', '→', '0', '9', '\u0378'];
  const widths = glyphs.map((glyph) => smokeCtx.measureText(glyph).width);
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) {
    throw new Error(`中文海报字体字形检查失败：${fontPath} 未提供可用的中文、箭头或数字字形。`);
  }
  const signatures: string[] = [];
  for (const glyph of glyphs) {
    smokeCtx.clearRect(0, 0, 320, 96);
    smokeCtx.fillText(glyph, 8, 60);
    const pixels = smokeCtx.getImageData(0, 0, 320, 96).data;
    let ink = 0;
    let weight = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      ink += pixels[index] > 0 ? 1 : 0;
      weight += pixels[index];
    }
    signatures.push(`${ink}:${weight}`);
  }
  const missingSignature = signatures[signatures.length - 1];
  const cjkSignatures = signatures.slice(0, 4);
  if (cjkSignatures.every((signature) => signature === missingSignature)) {
    throw new Error(`中文海报字体字形检查失败：${fontPath} 不含中文字形，请安装中文字体或配置正确的 POSTER_FONT_PATH。`);
  }

  registeredFontPath = fontPath;
  return fontPath;
}

export function getPosterLayout(templateKey: string): PosterLayout {
  return POSTER_LAYOUTS[templateKey as PosterTemplateKey] ?? POSTER_LAYOUTS.OCEAN_GOLD;
}

function legContent(leg: LegSummary): PosterLegContent {
  return {
    flightNumber: leg.flightNumber,
    route: `${leg.originName} → ${leg.destinationName}`,
    time: `${leg.departTime}-${leg.arriveTime}`,
  };
}

export function buildPosterContent(
  summary: FlightRouteSummary,
  title: string,
  extraNote?: string,
): PosterContent {
  return {
    title,
    effectiveFrom: summary.effectiveFrom,
    outbound: legContent(summary.outbound),
    inbound: summary.inbound ? legContent(summary.inbound) : null,
    baggageText: summary.baggageText,
    extraNote: extraNote?.trim() || null,
  };
}

function roundedPanel(ctx: SKRSContext2D, panel: PosterPanelLayout): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(panel.x, panel.y, panel.width, panel.height, panel.radius);
  ctx.fillStyle = panel.fill;
  ctx.fill();
  if (panel.strokeWidth > 0) {
    ctx.strokeStyle = panel.stroke;
    ctx.lineWidth = panel.strokeWidth;
    ctx.stroke();
  }
  ctx.restore();
}

function fontString(layout: PosterTextLayout, size = layout.fontSize): string {
  return `${layout.fontWeight} ${size}px ${POSTER_FONT_FAMILY}`;
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line || ' ');
  }
  return lines.length > 0 ? lines : [' '];
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  const suffix = '…';
  let result = text;
  while (result.length > 0 && ctx.measureText(result + suffix).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + suffix;
}

interface FittedText {
  size: number;
  lines: string[];
  lineHeight: number;
  truncated: boolean;
}

function minimumReadableSize(fieldName: string, layout: PosterTextLayout): number {
  if (layout.minFontSize) return layout.minFontSize;
  if (fieldName.endsWith('flightNumber')) return 32;
  if (fieldName.endsWith('time')) return 22;
  if (fieldName.endsWith('route')) return 20;
  if (fieldName === 'title') return 28;
  if (fieldName === 'effectiveFrom') return 22;
  if (fieldName === 'baggage') return 18;
  if (fieldName === 'extraNote') return 14;
  return 16;
}

function fitText(
  ctx: SKRSContext2D,
  text: string,
  layout: PosterTextLayout,
  fieldName: string,
): FittedText {
  const minimumSize = Math.max(10, minimumReadableSize(fieldName, layout));
  const maxLines = layout.maxLines ?? Math.max(1, Math.floor(layout.height / (layout.fontSize * layout.lineHeight)));
  for (let size = layout.fontSize; size >= minimumSize; size -= 2) {
    ctx.font = fontString(layout, size);
    const lineHeight = size * layout.lineHeight;
    const allowedLines = Math.max(1, Math.min(maxLines, Math.floor(layout.height / lineHeight)));
    const lines = wrapText(ctx, text, layout.width);
    if (lines.length <= allowedLines) return { size, lines, lineHeight, truncated: false };
  }

  const size = minimumSize;
  ctx.font = fontString(layout, size);
  const lineHeight = size * layout.lineHeight;
  const allowedLines = Math.max(1, Math.min(maxLines, Math.floor(layout.height / lineHeight)));
  const wrapped = wrapText(ctx, text, layout.width);
  if (layout.critical) {
    throw new Error(`关键字段「${fieldName}」过长，无法在可读字号内完整排版`);
  }
  const lines = wrapped.slice(0, allowedLines);
  const last = lines.length - 1;
  if (last >= 0) lines[last] = ellipsize(ctx, lines[last], layout.width);
  return { size, lines, lineHeight, truncated: true };
}

function drawText(
  ctx: SKRSContext2D,
  text: string,
  layout: PosterTextLayout,
  fieldName: string,
  truncated: string[],
  originX = 0,
  originY = 0,
): void {
  if (!text.trim()) return;
  const fitted = fitText(ctx, text, layout, fieldName);
  if (fitted.truncated) truncated.push(fieldName);
  ctx.save();
  ctx.font = fontString(layout, fitted.size);
  ctx.fillStyle = layout.color;
  ctx.textAlign = layout.align;
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  const x = layout.align === 'center'
    ? originX + layout.x + layout.width / 2
    : layout.align === 'right'
      ? originX + layout.x + layout.width
      : originX + layout.x;
  for (const [index, line] of fitted.lines.entries()) {
    ctx.fillText(line, x, originY + layout.y + index * fitted.lineHeight);
  }
  ctx.restore();
}

function drawCover(ctx: SKRSContext2D, image: Image): void {
  const scale = Math.max(POSTER_WIDTH / image.width, POSTER_HEIGHT / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = (POSTER_WIDTH - drawWidth) / 2;
  const offsetY = (POSTER_HEIGHT - drawHeight) / 2;
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

function drawCard(
  ctx: SKRSContext2D,
  card: PosterCardLayout,
  label: string,
  leg: PosterLegContent,
  layout: PosterLayout,
  fieldPrefix: 'outbound' | 'inbound',
  truncated: string[],
): void {
  roundedPanel(ctx, card);
  drawText(ctx, label, layout.cardLabel, `${fieldPrefix}.label`, truncated, card.x, card.y);
  drawText(ctx, leg.flightNumber, layout.cardFlightNumber, `${fieldPrefix}.flightNumber`, truncated, card.x, card.y);
  drawText(ctx, leg.route, layout.cardRoute, `${fieldPrefix}.route`, truncated, card.x, card.y);
  drawText(ctx, leg.time, layout.cardTime, `${fieldPrefix}.time`, truncated, card.x, card.y);
}

function drawFooter(ctx: SKRSContext2D, layout: PosterLayout, content: PosterContent, truncated: string[]): void {
  const rows: Array<{ field: string; text: string; style: PosterTextLayout }> = [];
  if (content.baggageText) rows.push({ field: 'baggage', text: `免费托运行李：${content.baggageText}`, style: layout.baggage });
  if (content.extraNote) rows.push({ field: 'extraNote', text: `补充说明：${content.extraNote}`, style: layout.extraNote });
  if (rows.length === 0) return;
  const footer = { ...layout.footer, height: 34 + rows.reduce((height, row) => height + row.style.height + 18, -18) };
  roundedPanel(ctx, footer);
  let offsetY = 24;
  for (const row of rows) {
    drawText(ctx, row.text, { ...row.style, y: offsetY }, row.field, truncated, footer.x, footer.y);
    offsetY += row.style.height + 18;
  }
}

export async function composePosterWithReport(
  backgroundPng: Buffer,
  layout: PosterLayout,
  content: PosterContent,
): Promise<ComposePosterResult> {
  getPosterFontPath();
  const image = await loadImage(backgroundPng);
  const canvas: Canvas = createCanvas(POSTER_WIDTH, POSTER_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawCover(ctx, image);
  const truncated: string[] = [];
  roundedPanel(ctx, layout.header);
  drawText(ctx, content.title, layout.title, 'title', truncated);
  if (content.effectiveFrom) drawText(ctx, content.effectiveFrom, layout.effectiveFrom, 'effectiveFrom', truncated);

  if (content.inbound) {
    drawCard(ctx, layout.card.two[0], '去程', content.outbound, layout, 'outbound', truncated);
    drawCard(ctx, layout.card.two[1], '回程', content.inbound, layout, 'inbound', truncated);
  } else {
    drawCard(ctx, layout.card.single, '航线', content.outbound, layout, 'outbound', truncated);
  }
  drawFooter(ctx, layout, content, truncated);
  return { png: canvas.toBuffer('image/png'), truncated };
}

export async function composePoster(
  backgroundPng: Buffer,
  layout: PosterLayout,
  content: PosterContent,
): Promise<Buffer> {
  const result = await composePosterWithReport(backgroundPng, layout, content);
  return result.png;
}
