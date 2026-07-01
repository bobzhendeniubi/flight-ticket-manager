/**
 * AI 助手 OCR 出来的护照信息缓存
 *
 * 工作流：
 *   1. 用户在 AI 聊天里上传护照 → 浏览器 tesseract.js OCR → 这里 push
 *   2. 用户走结账 → CheckoutPage.tsx 从这里取出 → 自动填表
 *   3. 下单成功 → clear()
 *
 * 持久化：sessionStorage（关浏览器丢；不进 localStorage 防隐私）
 */
import { create } from 'zustand';

export interface OcrPassenger {
  fullName: string;
  passportNumber: string;
  dateOfBirth?: string;
  nationality?: string;
  /**
   * 护照全采集字段（客源地分析）—— 仅 AI 助手里 OCR 命中 MRZ 时带出，与结账页同步。
   * 全 optional：老缓存 / 未命中 MRZ 时缺失，下游按"不展示/不发送"处理。
   */
  gender?: 'M' | 'F' | 'X';
  passportExpiry?: string; // YYYY-MM-DD
  passportIssueCountry?: string; // ISO-2
  /**
   * 护照签发地点（自由文本，如「广东省广州市」）—— 与 ISO-2 签发国 passportIssueCountry 区分开。
   * 仅 OCR 命中时带出；全 optional，老缓存/未命中时缺失。
   */
  passportIssuePlace?: string;
  /** OCR 时间戳，前端展示用 */
  capturedAt: number;
}

interface PassengersState {
  pending: OcrPassenger[];
  add: (p: OcrPassenger) => void;
  remove: (idx: number) => void;
  clear: () => void;
  hydrate: () => void;
}

const KEY = 'ai_pending_passengers';

export const usePassengers = create<PassengersState>((set, get) => ({
  pending: [],
  add: (p) => {
    const next = [...get().pending, p];
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode */
    }
    set({ pending: next });
  },
  remove: (idx) => {
    const next = get().pending.filter((_, i) => i !== idx);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch { /* noop */ }
    set({ pending: next });
  },
  clear: () => {
    try { sessionStorage.removeItem(KEY); } catch { /* noop */ }
    set({ pending: [] });
  },
  hydrate: () => {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) set({ pending: JSON.parse(raw) as OcrPassenger[] });
    } catch { /* noop */ }
  },
}));
