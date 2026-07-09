/**
 * PassengerPassportModal — 我的订单 · 出行人护照资料补充弹窗
 *
 * 上传护照图（压缩 + tesseract OCR 自动回填）→ 核对/手改表单 → PATCH 自助补录。
 * - OCR 只回填「空字段或用户未改过的字段」，并提示「已自动识别，请核对」
 * - fullName 只读展示（改名请联系客服；后端 schema 也不收 fullName）
 * - 保存只发「改动过且非空」的字段 + 新上传的护照图；后端至少要求一个字段
 * - 409 ORDER_LOCKED → 弹窗内提示订单状态不可修改
 *
 * 使用方（MyOrdersPage）按 passenger 条件渲染（每次打开都是新挂载），
 * 所以初始状态直接从 props.passenger 取，无需同步 effect。
 */
import { useState } from 'react';
import {
  api,
  ApiError,
  type OrderPassengerDetail,
  type UpdatePassengerInput,
} from '../lib/api';
import { ocrPassport } from '../lib/passportOcr';
import { passportFileToDataUrl } from '../lib/passportImage';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface PassengerPassportModalProps {
  token: string;
  orderId: string;
  passenger: OrderPassengerDetail;
  onClose: () => void;
  /** 保存成功：回传后端最新 passenger（含 hasPassportPhoto），由父组件更新 detailCache 并关弹窗 */
  onSaved: (passenger: OrderPassengerDetail) => void;
}

/** 常用国籍/地区（同 CheckoutPage 惯例）+「其他」自填 ISO-2 码 */
const NATIONALITY_PRESETS = [
  { value: 'MO', label: '中国澳门 MO' },
  { value: 'HK', label: '中国香港 HK' },
  { value: 'CN', label: '中国 CN' },
  { value: 'TW', label: '中国台湾 TW' },
];

type FormState = {
  chineseName: string;
  gender: '' | 'M' | 'F' | 'X';
  documentNumber: string;
  dateOfBirth: string;
  nationality: string;
  passportExpiry: string;
  passportIssueDate: string;
  passportIssueCountry: string;
  passportIssuePlace: string;
};

/** @db.Date 字段过 JSON 是完整 ISO 串（如 1990-01-31T00:00:00.000Z）→ 取前 10 位喂 date input */
function toDateInput(v?: string | null): string {
  return v ? v.slice(0, 10) : '';
}

export function PassengerPassportModal({
  token,
  orderId,
  passenger,
  onClose,
  onSaved,
}: PassengerPassportModalProps) {
  const initial: FormState = {
    chineseName: passenger.chineseName ?? '',
    gender: (passenger.gender ?? '') as FormState['gender'],
    documentNumber: passenger.documentNumber ?? '',
    dateOfBirth: toDateInput(passenger.dateOfBirth),
    nationality: passenger.nationality ?? '',
    passportExpiry: toDateInput(passenger.passportExpiry),
    passportIssueDate: toDateInput(passenger.passportIssueDate),
    passportIssueCountry: passenger.passportIssueCountry ?? '',
    passportIssuePlace: passenger.passportIssuePlace ?? '',
  };

  const [form, setForm] = useState<FormState>(initial);
  // 用户手改过的字段：OCR 回填时跳过，避免覆盖用户输入
  const [touched, setTouched] = useState<Set<keyof FormState>>(() => new Set());
  // 国籍下拉「其他」模式（当前值不在预设列表时进入，自填 ISO-2 码）
  const [natOther, setNatOther] = useState(
    initial.nationality !== '' && !NATIONALITY_PRESETS.some((o) => o.value === initial.nationality),
  );

  // 护照图上传 / OCR 状态
  const [newPhotoUrl, setNewPhotoUrl] = useState<string | null>(null);
  const [ocring, setOcring] = useState(false);
  const [ocrStage, setOcrStage] = useState<{ pct: number; label: string } | null>(null);
  const [ocrNotice, setOcrNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  /** OCR 回填：仅填「当前为空 或 用户未改过」的字段（不覆盖用户手输） */
  const applyOcrPatch = (patch: Partial<FormState>) => {
    setForm((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(patch) as Array<
        [keyof FormState, FormState[keyof FormState]]
      >) {
        if (v === undefined || v === '') continue;
        if (prev[k] === '' || !touched.has(k)) {
          next[k] = v as never;
        }
      }
      // 国籍被 OCR 填成非预设值 → 切到「其他」模式展示
      if (
        next.nationality !== prev.nationality &&
        !NATIONALITY_PRESETS.some((o) => o.value === next.nationality)
      ) {
        setNatOther(next.nationality !== '');
      }
      return next;
    });
  };

  const handleFile = async (file: File) => {
    setOcring(true);
    setOcrNotice(null);
    setError(null);

    // 1) 压缩为 data-URL（预览 + 保存时上传；压缩后仍超限返回 ''，不存）
    try {
      const url = await passportFileToDataUrl(file);
      if (url) setNewPhotoUrl(url);
    } catch {
      // 读取失败不阻断 OCR
    }

    // 2) OCR 识别 → 回填表单
    try {
      const result = await ocrPassport(file, (pct, label) => setOcrStage({ pct, label }));
      const suggested = result.success ? result.suggested : {};
      applyOcrPatch({
        chineseName: result.fallback?.chineseName ?? undefined,
        gender: suggested.gender,
        documentNumber: suggested.passportNumber ?? result.fallback?.passportNumber,
        dateOfBirth: suggested.dateOfBirth ?? result.fallback?.dateOfBirth,
        nationality: suggested.nationality ?? result.fallback?.nationality,
        passportExpiry: suggested.passportExpiry,
        passportIssueCountry: suggested.passportIssueCountry,
        passportIssuePlace: suggested.passportIssuePlace,
      });
      setOcrNotice(
        result.success
          ? { ok: true, msg: '已自动识别，请核对下方信息后保存' }
          : { ok: false, msg: '仅部分识别成功，请手工核对并补全字段' },
      );
    } catch (err) {
      setOcrNotice({
        ok: false,
        msg: `识别失败：${err instanceof Error ? err.message : '未知错误'}。照片已保留，可手工填写。`,
      });
    } finally {
      setOcring(false);
      setOcrStage(null);
    }
  };

  const save = async () => {
    setError(null);

    // 只发「改动过且非空」的字段（后端全可选但至少一个；不发空串防校验失败）
    const body: UpdatePassengerInput = {};
    const trimmed = {
      ...form,
      chineseName: form.chineseName.trim(),
      documentNumber: form.documentNumber.trim(),
      nationality: form.nationality.trim().toUpperCase(),
      passportIssueCountry: form.passportIssueCountry.trim().toUpperCase(),
      passportIssuePlace: form.passportIssuePlace.trim(),
    };
    if (trimmed.chineseName && trimmed.chineseName !== initial.chineseName)
      body.chineseName = trimmed.chineseName;
    if (trimmed.gender && trimmed.gender !== initial.gender) body.gender = trimmed.gender;
    if (trimmed.documentNumber && trimmed.documentNumber !== initial.documentNumber)
      body.documentNumber = trimmed.documentNumber;
    if (trimmed.dateOfBirth && trimmed.dateOfBirth !== initial.dateOfBirth)
      body.dateOfBirth = trimmed.dateOfBirth;
    if (trimmed.nationality && trimmed.nationality !== initial.nationality)
      body.nationality = trimmed.nationality;
    if (trimmed.passportExpiry && trimmed.passportExpiry !== initial.passportExpiry)
      body.passportExpiry = trimmed.passportExpiry;
    if (trimmed.passportIssueDate && trimmed.passportIssueDate !== initial.passportIssueDate)
      body.passportIssueDate = trimmed.passportIssueDate;
    if (trimmed.passportIssueCountry && trimmed.passportIssueCountry !== initial.passportIssueCountry)
      body.passportIssueCountry = trimmed.passportIssueCountry;
    if (trimmed.passportIssuePlace && trimmed.passportIssuePlace !== initial.passportIssuePlace)
      body.passportIssuePlace = trimmed.passportIssuePlace;
    if (newPhotoUrl) body.passportPhotoUrl = newPhotoUrl;

    if (Object.keys(body).length === 0) {
      setError('还没有需要保存的修改：请上传护照或修改下方资料');
      return;
    }
    if (body.nationality && !/^[A-Z]{2}$/.test(body.nationality)) {
      setError('国籍请填 2 位国家/地区代码（如 CN / HK / MO）');
      return;
    }
    if (body.passportIssueCountry && !/^[A-Z]{2}$/.test(body.passportIssueCountry)) {
      setError('签发国请填 2 位国家/地区代码（如 CN / HK / MO）');
      return;
    }
    if (body.documentNumber && body.documentNumber.length < 3) {
      setError('证件号至少 3 位，请检查');
      return;
    }

    setSaving(true);
    try {
      const r = await api.updateOrderPassenger(token, orderId, passenger.id, body);
      onSaved(r.passenger);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ORDER_LOCKED') {
        setError('当前订单状态不可修改，请联系客服');
      } else {
        setError(e instanceof Error ? e.message : '保存失败，请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const natSelectValue = natOther ? 'OTHER' : form.nationality;

  return (
    <Modal open onClose={() => !saving && onClose()} title="补充护照资料" size="lg">
      <div className="space-y-4 p-5 text-sm">
        {/* 出行人（只读）：改名不开放自助，避免误换人 */}
        <div className="rounded-xl bg-canvas px-3.5 py-3">
          <div className="text-xs font-bold uppercase tracking-wide text-ink-muted">出行人</div>
          <div className="mt-0.5 font-semibold text-ink">{passenger.fullName}</div>
          <div className="mt-0.5 text-xs text-ink-muted">
            姓名以下单时护照信息为准；如需修改姓名或更换出行人，请联系客服。
          </div>
        </div>

        {/* 上传护照（压缩 + OCR 自动回填） */}
        <div className="rounded-2xl border border-dashed border-brand-200 bg-brand-50/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-ink">护照照片</div>
            <label className="chip cursor-pointer text-brand-700 transition hover:bg-brand-50 hover:text-brand-dark">
              {ocring
                ? `识别中… ${ocrStage?.pct.toFixed(0) ?? 0}%`
                : newPhotoUrl || passenger.hasPassportPhoto
                  ? '重新上传护照'
                  : '上传护照并自动识别'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={ocring || saving}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            上传后自动识别并回填下方表单，出票与签证材料都会用到这张照片。
          </p>
          {ocring && ocrStage && (
            <div className="mt-2.5 rounded-xl border border-brand-200 bg-surface px-3 py-2 text-xs text-brand-800">
              <div className="mb-1 flex items-center justify-between">
                <span>{ocrStage.label}</span>
                <span className="font-semibold nums">{ocrStage.pct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-brand-100">
                <div className="h-full bg-brand transition-all" style={{ width: `${ocrStage.pct}%` }} />
              </div>
            </div>
          )}
          {ocrNotice && (
            <div
              className={`mt-2.5 flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium ${
                ocrNotice.ok
                  ? 'border border-brand-200 bg-surface text-brand-800'
                  : 'border border-sun/40 bg-sun-light text-amber-800'
              }`}
            >
              <Icon name={ocrNotice.ok ? 'check' : 'info'} className="h-3.5 w-3.5 shrink-0" />
              {ocrNotice.msg}
            </div>
          )}
          {newPhotoUrl && (
            <img
              src={newPhotoUrl}
              alt="护照预览"
              className="mt-2.5 max-h-28 rounded-xl border border-slate-200"
            />
          )}
          {!newPhotoUrl && passenger.hasPassportPhoto && (
            <div className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              <Icon name="check" className="h-3.5 w-3.5" /> 已有护照照片，可不重复上传
            </div>
          )}
        </div>

        {/* 资料表单（预填当前值） */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label text-xs">中文姓名</label>
            <input
              className="input"
              value={form.chineseName}
              onChange={(e) => setField('chineseName', e.target.value)}
              placeholder="如 陈文豪"
              maxLength={120}
            />
          </div>
          <div>
            <label className="label text-xs">性别</label>
            <select
              className="input"
              value={form.gender}
              onChange={(e) => setField('gender', e.target.value as FormState['gender'])}
            >
              <option value="">未填写</option>
              <option value="M">男</option>
              <option value="F">女</option>
              <option value="X">其他</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">证件号（护照号）</label>
            <input
              className="input"
              value={form.documentNumber}
              onChange={(e) => setField('documentNumber', e.target.value)}
              placeholder="如 EA1234567"
              maxLength={40}
            />
          </div>
          <div>
            <label className="label text-xs">出生日期</label>
            <input
              type="date"
              className="input"
              value={form.dateOfBirth}
              onChange={(e) => setField('dateOfBirth', e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">国籍 / 地区</label>
            <select
              className="input"
              value={natSelectValue}
              onChange={(e) => {
                if (e.target.value === 'OTHER') {
                  setNatOther(true);
                  setField('nationality', '');
                } else {
                  setNatOther(false);
                  setField('nationality', e.target.value);
                }
              }}
            >
              <option value="" disabled>
                请选择
              </option>
              {NATIONALITY_PRESETS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option value="OTHER">其他（填 2 位代码）</option>
            </select>
            {natOther && (
              <input
                className="input mt-1.5"
                value={form.nationality}
                onChange={(e) => setField('nationality', e.target.value.toUpperCase().slice(0, 2))}
                placeholder="2 位国家/地区代码，如 SG"
                maxLength={2}
              />
            )}
          </div>
          <div>
            <label className="label text-xs">护照有效期至</label>
            <input
              type="date"
              className="input"
              value={form.passportExpiry}
              onChange={(e) => setField('passportExpiry', e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">护照签发日期</label>
            <input
              type="date"
              className="input"
              value={form.passportIssueDate}
              onChange={(e) => setField('passportIssueDate', e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">护照签发国/地区</label>
            <input
              className="input uppercase"
              value={form.passportIssueCountry}
              onChange={(e) => setField('passportIssueCountry', e.target.value.toUpperCase())}
              placeholder="2 位代码，如 CN / HK / MO"
              maxLength={2}
            />
          </div>
          <div>
            <label className="label text-xs">护照签发地</label>
            <input
              className="input"
              value={form.passportIssuePlace}
              onChange={(e) => setField('passportIssuePlace', e.target.value)}
              placeholder="如 广东省广州市"
              maxLength={120}
            />
          </div>
        </div>

        {error && (
          <div
            className="flex items-center gap-1.5 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 text-sm font-medium text-deal-dark"
            role="alert"
          >
            <Icon name="info" className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t border-slate-200/80 bg-canvas px-5 py-4">
        <button type="button" onClick={onClose} disabled={saving} className="btn-secondary">
          取消
        </button>
        <button type="button" onClick={save} disabled={saving || ocring} className="btn-primary">
          {saving ? '保存中…' : '保存护照资料'}
        </button>
      </footer>
    </Modal>
  );
}
