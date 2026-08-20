import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  POSTER_HEIGHT,
  POSTER_WIDTH,
  buildPosterContent,
  composePoster,
  composePosterWithReport,
  getPosterLayout,
} from './marketing.compose.js';
import type { FlightRouteSummary } from './marketing.facts.js';

const summary: FlightRouteSummary = {
  outbound: {
    flightNumber: 'QH9589',
    originCode: 'MFM',
    destinationCode: 'DAD',
    originName: '澳门',
    destinationName: '岘港',
    departTime: '15:45',
    arriveTime: '16:30',
  },
  inbound: null,
  effectiveFrom: '8月21日起',
  baggageText: '20KG+手提7KG',
};

function backgroundPng(): Buffer {
  const canvas = createCanvas(POSTER_WIDTH, POSTER_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3b7890';
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);
  return canvas.toBuffer('image/png');
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<number[]> {
  const image = await loadImage(png);
  const canvas = createCanvas(POSTER_WIDTH, POSTER_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

describe('composePoster — 服务端确定性叠字', () => {
  it('三套版式都输出固定尺寸，长文本自动缩放/换行且不抛错', async () => {
    const content = buildPosterContent(
      {
        ...summary,
        baggageText: '超长行李说明'.repeat(40),
      },
      '这是一个非常长的运营海报标题'.repeat(20),
      '这是一个长度不可控的补充要求，用于验证服务端会自动换行或缩小字号而不会溢出画布。'.repeat(20),
    );

    for (const key of ['OCEAN_GOLD', 'SUNNY_TROPICAL', 'MINIMAL_EDITORIAL'] as const) {
      const report = await composePosterWithReport(backgroundPng(), getPosterLayout(key), content);
      const output = report.png;
      const image = await loadImage(output);
      expect(image.width).toBe(POSTER_WIDTH);
      expect(image.height).toBe(POSTER_HEIGHT);
      expect((await pixelAt(output, 540, 150)).some((value) => value > 0)).toBe(true);
      expect((await pixelAt(output, 540, 540)).some((value) => value > 0)).toBe(true);
      expect(report.truncated).toEqual(expect.arrayContaining(['title', 'baggage', 'extraNote']));
    }
  });

  it('关键航班号或时刻放不下时让合成失败，不印残缺值', async () => {
    const longFlight = buildPosterContent(
      { ...summary, outbound: { ...summary.outbound, flightNumber: 'QH12345678901234567890' } },
      '关键字段测试',
    );
    await expect(composePosterWithReport(backgroundPng(), getPosterLayout('OCEAN_GOLD'), longFlight))
      .rejects.toThrow('关键字段');
  });

  it('单程只绘制一张居中的卡片', async () => {
    const output = await composePoster(
      backgroundPng(),
      getPosterLayout('OCEAN_GOLD'),
      buildPosterContent(summary, '单程航线'),
    );

    const outsideCard = await pixelAt(output, 100, 540);
    const insideCard = await pixelAt(output, 200, 540);
    expect(insideCard).not.toEqual(outsideCard);
  });

  it('相同入参产出稳定图像，并且关键叠字区域非空', async () => {
    const content = buildPosterContent(summary, '稳定性测试');
    const layout = getPosterLayout('MINIMAL_EDITORIAL');
    const first = await composePoster(backgroundPng(), layout, content);
    const second = await composePoster(backgroundPng(), layout, content);

    expect(first.equals(second)).toBe(true);
    expect((await pixelAt(first, 200, 500)).some((value) => value > 0)).toBe(true);
    expect((await pixelAt(first, 540, 930)).some((value) => value > 0)).toBe(true);
  });
});
