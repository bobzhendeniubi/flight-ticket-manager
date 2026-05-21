/**
 * 一键打包护照图片 zip — 签证组 / 票务组用
 *
 * 输入：订单 + 该订单的所有乘客（含 passportPhotoUrl）
 * 输出：zip Buffer，结构：
 *   FTM2026...../{LASTNAME}_{passportNumber}.{ext}
 *   FTM2026...../README.txt  （列出哪些乘客缺照片）
 *
 * 缺失照片不报错 —— 写到 README.txt 让签证员一眼看到缺谁的。
 */
import JSZip from 'jszip';
import type { Passenger } from '@prisma/client';

function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

function extFromUrl(u: string): string {
  const m = u.match(/\.(jpe?g|png|webp|heic|gif)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

async function fetchPhoto(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

export async function buildPassportPhotoZip(args: {
  orderNumber: string;
  passengers: Passenger[];
}): Promise<Buffer> {
  const zip = new JSZip();
  const folder = zip.folder(args.orderNumber) ?? zip;

  const missing: string[] = [];
  const ok: string[] = [];

  for (const p of args.passengers) {
    const slug = sanitize(`${p.lastName ?? ''}_${p.firstName ?? p.fullName}_${p.documentNumber}`);
    if (!p.passportPhotoUrl) {
      missing.push(`${slug}  — 该乘客没传护照照片`);
      continue;
    }
    const buf = await fetchPhoto(p.passportPhotoUrl);
    if (!buf) {
      missing.push(`${slug}  — 下载失败 (${p.passportPhotoUrl})`);
      continue;
    }
    folder.file(`${slug}.${extFromUrl(p.passportPhotoUrl)}`, buf);
    ok.push(slug);
  }

  const readme = [
    `订单：${args.orderNumber}`,
    `打包时间：${new Date().toISOString()}`,
    `乘客总数：${args.passengers.length}`,
    `成功打包：${ok.length}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(ok.length ? ['✓ 已打包：', ...ok.map((s) => `  · ${s}`), ''] : []),
    ...(missing.length ? ['⚠ 缺照片：', ...missing.map((s) => `  · ${s}`)] : []),
  ].join('\n');
  folder.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

export function passportZipFilename(orderNumber: string): string {
  return `${orderNumber}-passports.zip`;
}
