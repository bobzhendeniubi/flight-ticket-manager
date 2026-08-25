/**
 * 录单出行人联想输入框（姓名 / 证件号两处共用）。
 *
 * 输入 ≥2 字符（300ms debounce）→ GET /travelers/profiles/suggest → 输入框下方浮层
 * 展示常旅客候选（最多 8 条）；点选后由父组件 onPick 整行回填 PassengerRow。
 *
 * 角色门禁：仅 ADMIN/STAFF 发起联想请求（后端对 AGENT 也是 403，前端直接不打），
 * AGENT 下退化为普通受控 input。
 *
 * 浮层用 position:fixed 定位（按输入框实时 rect 计算），避免被出行人表格的
 * overflow 容器裁剪；点击外部 / Escape 关闭；候选项用 onMouseDown 抢在 blur 前触发。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TravelerProfileSuggestion } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from './Icon';

const SUGGEST_DEBOUNCE_MS = 300;
const SUGGEST_LIMIT = 8;
const SUGGEST_MIN_QUERY = 2;
/** 护照临期阈值：不足 180 天红字警示（多数目的地要求 6 个月有效期） */
const PASSPORT_EXPIRY_WARN_DAYS = 180;
/** blur 后延迟关闭浮层的兜底时长（主路径是候选项 onMouseDown preventDefault） */
const BLUR_CLOSE_DELAY_MS = 150;

const DOC_LABELS: Record<string, string> = {
  PASSPORT: '护照',
  ID_CARD: '身份证',
  TRAVEL_PERMIT: '通行证',
  OTHER: '其他',
};

const CABIN_LABELS: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '高端经济',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

const BED_LABELS: Record<string, string> = {
  SINGLE: '单人间',
  DOUBLE: '大床',
  TWIN: '双床',
  SHARE_OK: '可拼房',
};

/** 证件号打码展示：前 5 位 + ****（联想浮层里不整串裸奔） */
function maskDocNumber(n: string): string {
  return n.length > 5 ? `${n.slice(0, 5)}****` : n;
}

/** 距护照到期天数；无有效期返回 null */
function passportExpiryDays(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

interface SuggestionSubline {
  text: string;
  needsWheelchair: boolean;
}

/** 候选第二行：证件 + 飞行次数 + 偏好段（没有的偏好不显示） */
function suggestionSubline(s: TravelerProfileSuggestion): SuggestionSubline {
  const parts: string[] = [
    `${DOC_LABELS[s.documentType] ?? s.documentType} ${maskDocNumber(s.documentNumber)}`,
    `飞过 ${s.tripCount} 次`,
  ];
  if (s.prefCabin && s.prefCabin !== 'ECONOMY') parts.push(CABIN_LABELS[s.prefCabin] ?? s.prefCabin);
  if (s.prefBed) parts.push(BED_LABELS[s.prefBed] ?? s.prefBed);
  if (s.prefMeal) parts.push(s.prefMeal);
  if (s.prefSingleRoom) parts.push('单住');
  return { text: parts.join(' · '), needsWheelchair: s.needsWheelchair };
}

/** 护照临期/过期红字；正常返回 null */
function expiryWarning(s: TravelerProfileSuggestion): { text: string } | null {
  const days = passportExpiryDays(s.passportExpiry);
  if (days === null || days >= PASSPORT_EXPIRY_WARN_DAYS) return null;
  const ymd = (s.passportExpiry ?? '').slice(0, 10);
  return { text: days < 0 ? `护照 ${ymd} 已过期` : `护照 ${ymd} 到期` };
}

interface PopoverPos {
  top: number;
  left: number;
  width: number;
}

export interface PassengerSuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  /** 点选候选：由父组件用 fillFields / 档案摘要整行回填 */
  onPick: (suggestion: TravelerProfileSuggestion) => void;
  className?: string;
  placeholder?: string;
}

export function PassengerSuggestInput({
  value,
  onChange,
  onPick,
  className,
  placeholder,
}: PassengerSuggestInputProps) {
  const tokens = useAuth((s) => s.tokens);
  const role = useAuth((s) => s.user)?.role;
  // 仅 ADMIN/STAFF 可用联想（AGENT 完全不发请求、不渲染浮层）
  const suggestEnabled = role === 'ADMIN' || role === 'STAFF';

  const [suggestions, setSuggestions] = useState<TravelerProfileSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 请求竞态防护：旧响应不覆盖新输入的结果（AbortController + 序号双保险）
  const seqRef = useRef(0);

  const closePanel = useCallback(() => {
    setOpen(false);
    setSuggestions([]);
  }, []);

  const updatePos = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 320) });
  }, []);

  const runSearch = useCallback(
    (q: string) => {
      const token = tokens?.accessToken;
      if (!token) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const seq = ++seqRef.current;
      api
        .suggestTravelerProfiles(token, q, SUGGEST_LIMIT, { signal: ctrl.signal })
        .then((r) => {
          if (seq !== seqRef.current) return;
          setSuggestions(r.suggestions);
          if (r.suggestions.length > 0) {
            updatePos();
            setOpen(true);
          } else {
            setOpen(false);
          }
        })
        .catch(() => {
          // 中止或请求失败：联想静默降级，不打扰录单主流程
        });
    },
    [tokens?.accessToken, updatePos],
  );

  // 只在用户输入时触发联想（OCR/回填等外部改 value 不触发）
  const handleInput = (raw: string): void => {
    onChange(raw);
    if (!suggestEnabled || !tokens?.accessToken) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const q = raw.trim();
    if (q.length < SUGGEST_MIN_QUERY) {
      abortRef.current?.abort();
      seqRef.current++; // 作废在途响应
      closePanel();
      return;
    }
    debounceRef.current = window.setTimeout(() => runSearch(q), SUGGEST_DEBOUNCE_MS);
  };

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrapRef.current?.contains(ev.target as Node)) closePanel();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, closePanel]);

  // 表格容器滚动 / 窗口缩放时让浮层跟随输入框
  useEffect(() => {
    if (!open) return;
    const onReflow = () => updatePos();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, updatePos]);

  // 卸载清理：debounce / blur 定时器 + 在途请求
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            closePanel();
          }
        }}
        onBlur={() => {
          // 失焦不立刻关：点击候选前会先 blur，候选项 onMouseDown preventDefault 已保住焦点，
          // 这里再留 150ms 兜底给其它路径
          if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
          blurTimerRef.current = window.setTimeout(() => {
            if (!wrapRef.current?.contains(document.activeElement)) closePanel();
          }, BLUR_CLOSE_DELAY_MS);
        }}
      />
      {suggestEnabled && open && pos && suggestions.length > 0 && (
        <div
          className="fixed z-[80] max-h-64 overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {suggestions.map((s) => {
            const warn = expiryWarning(s);
            const subline = suggestionSubline(s);
            return (
              <button
                key={s.id}
                type="button"
                className="block w-full px-2.5 py-1.5 text-left hover:bg-slate-50"
                onMouseDown={(e) => {
                  // 抢在 input blur 之前触发，且不让浮层点击夺走焦点
                  e.preventDefault();
                  onPick(s);
                  closePanel();
                }}
              >
                <div className="text-sm text-slate-900">
                  <span className="font-mono text-xs text-brand">{s.travelerNo}</span>
                  <span className="ml-1.5 font-medium">{s.fullName}</span>
                  {s.chineseName && <span className="text-slate-500">（{s.chineseName}）</span>}
                </div>
                <div className="text-xs text-slate-500">
                  {subline.text}
                  {subline.needsWheelchair && <span className="ml-1 inline-flex items-center gap-1"><Icon name="wheelchair" size={14} /> 轮椅</span>}
                </div>
                {warn && <div className="inline-flex items-center gap-1 text-xs text-red-600"><Icon name="alert" size={14} /> {warn.text}</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
