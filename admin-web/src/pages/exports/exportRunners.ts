/**
 * 导出中心 · 参数默认值 / 校验 / 摘要 / 下载动作
 *
 * 一句话：把散在各页的「点导出 → 调 api.ts → 拼文件名 → 触发下载」这段收成一份按 entry.id
 * 分派的调度表。参数默认值与文件名**逐条照抄各页现状**（注释里标了来源），运营在导出中心
 * 导出的文件与在原页面导出的文件同名同内容 —— 两个入口不能出两种表。
 *
 * 纪律：
 *   · 只调 lib/api.ts 现有函数，不新增后端端点；
 *   · 需要先勾选订单的导出（签证名单 / 护照包 / PNR）不在这里，目录里给跳转；
 *   · 各页原按钮一个不删，这里是并列的第二入口。
 */
import { api, hotelControlOpsApi, type OrderExportTemplate } from '../../lib/api';
import { localDateStamp } from '../../lib/csvExport';
import type { ExportEntry } from '../../lib/exportCatalog';

/** 三模板导出的模板名（与 OrdersPage 的 TEMPLATE_LABEL 同一份文案，文件名靠它）。 */
export const EXPORT_TEMPLATE_LABEL: Record<OrderExportTemplate, string> = {
  full: '全岗可用',
  ticketing: '票务专用',
  visa: '签证专用',
};

/** 分房表两种口径：按入住区间 / 按出发日（照抄房控页 RoomAllocationExport）。 */
export type RoomAllocationMode = 'range' | 'depart';

/**
 * 一张卡片的参数。字段按 entry.param 分组用，存在同一个扁平对象里 ——
 * 卡片之间各持一份，互不影响。
 */
export interface ExportParams {
  /** 主日期区间（房态/财务/报表/no-show/控位＝出发或业务日；三模板/全岗总表＝出行日期） */
  from: string;
  to: string;
  /** 下单时间区间（全岗总表 / 进单统计专用，语义与出行日期不同，绝不混用） */
  createdFrom: string;
  createdTo: string;
  flightNumber: string;
  template: OrderExportTemplate;
  scheduleId: string;
  roomMode: RoomAllocationMode;
  departDate: string;
}

/** 选中班次的展示信息（整班机导出的文件名要用），由页面从班次列表里带进来。 */
export interface ScheduleMeta {
  flightNumber: string;
  /** 当地出发日 YYYY-MM-DD */
  date: string;
}

// ── 日期小工具（本地日，不用 toISOString，避免 00:00–08:00 写成前一天）────
function todayStr(): string {
  return localDateStamp();
}

function shiftDaysStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateStamp(d);
}

/**
 * 各条导出的默认参数 —— 逐条照抄原页面的初始值：
 *   房态销控     房控页 BoardExport：今天 → +30 天
 *   分房表       房控页 RoomAllocationExport：今天 → 今天，按出发日默认今天
 *   销售控位表   座位统计页：今天 → +30 天
 *   财务三张     财务页：近 30 天（今天往前 29 天 → 今天）
 *   经营报表     经营报表页：近 30 天
 *   no-show 报表 no-show 报表页：今天往前 30 天 → 今天
 *   流水核对表   收款对账台：留空（＝全部）
 *   订单三张     订单页：留空（＝不按日期筛，导命中的全部）
 */
export function defaultExportParams(entry: ExportEntry): ExportParams {
  const base: ExportParams = {
    from: '',
    to: '',
    createdFrom: '',
    createdTo: '',
    flightNumber: '',
    template: 'full',
    scheduleId: '',
    roomMode: 'range',
    departDate: todayStr(),
  };
  switch (entry.id) {
    case 'hotel-board':
    case 'seat-stats':
      return { ...base, from: todayStr(), to: shiftDaysStr(30) };
    case 'room-allocation':
      return { ...base, from: todayStr(), to: todayStr() };
    case 'finance-master':
    case 'finance-by-flight':
    case 'finance-by-order':
    case 'reports':
      return { ...base, from: shiftDaysStr(-29), to: todayStr() };
    case 'no-show-report':
      return { ...base, from: shiftDaysStr(-30), to: todayStr() };
    default:
      return base;
  }
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 导出前的参数校验；返回 null = 可以导。
 * 只拦「一定导不出来」的（必填缺失 / 区间反了 / 后端硬上限），其余交给后端权威校验。
 */
export function exportParamsError(entry: ExportEntry, p: ExportParams): string | null {
  switch (entry.param) {
    case 'schedule':
      return p.scheduleId ? null : '请先选择班次';
    case 'roomAllocation':
      if (p.roomMode === 'depart') return p.departDate ? null : '请选择出发日期';
      if (!p.from || !p.to) return '请选择入住区间';
      if (p.from > p.to) return '入住起不能晚于入住止';
      // 后端对分房表入住区间的硬上限是 14 天，早点在前端说清楚，别等 400 回来
      if (daysBetween(p.from, p.to) > 13) return '按入住区间导出最长 14 天，请缩小范围';
      return null;
    case 'dateRange':
      if (!p.from || !p.to) return '请选择日期区间';
      return p.from > p.to ? '起始不能晚于截止' : null;
    case 'dateRangeOptional':
    case 'seatStats':
      return p.from && p.to && p.from > p.to ? '起始不能晚于截止' : null;
    case 'orderTemplate':
      return p.from && p.to && p.from > p.to ? '出行日期起不能晚于止' : null;
    case 'orderMaster':
    case 'orderIntake':
      if (p.from && p.to && p.from > p.to) return '出行日期起不能晚于止';
      if (p.createdFrom && p.createdTo && p.createdFrom > p.createdTo) {
        return '下单时间起不能晚于止';
      }
      return null;
    default:
      return null;
  }
}

function rangeLabel(from: string, to: string): string {
  if (!from && !to) return '全部';
  return `${from || '不限'} ~ ${to || '不限'}`;
}

/** 「最近导出」里那行参数摘要；无参数导出返回空串。 */
export function describeExportParams(
  entry: ExportEntry,
  p: ExportParams,
  schedule?: ScheduleMeta,
): string {
  switch (entry.param) {
    case 'none':
      return '';
    case 'schedule':
      return schedule ? `${schedule.flightNumber} · ${schedule.date}` : '按班次';
    case 'roomAllocation':
      return p.roomMode === 'depart'
        ? `出发日 ${p.departDate}`
        : `入住 ${rangeLabel(p.from, p.to)}`;
    case 'seatStats':
      return [rangeLabel(p.from, p.to), p.flightNumber && `航班 ${p.flightNumber}`]
        .filter(Boolean)
        .join(' · ');
    case 'orderTemplate':
      return [
        `《${EXPORT_TEMPLATE_LABEL[p.template]}》`,
        `出行 ${rangeLabel(p.from, p.to)}`,
        p.flightNumber && `航班 ${p.flightNumber}`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'orderMaster':
      return [
        `出行 ${rangeLabel(p.from, p.to)}`,
        (p.createdFrom || p.createdTo) && `下单 ${rangeLabel(p.createdFrom, p.createdTo)}`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'orderIntake':
      return `下单 ${rangeLabel(p.createdFrom, p.createdTo)}`;
    default:
      return rangeLabel(p.from, p.to);
  }
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

/**
 * 真正发请求 + 拼文件名。文件名逐条照抄原页面（导出中心与原按钮出同名文件）。
 * 未登记的 id 直接抛错 —— 目录加了条目却忘了接线，宁可当场报错，也别默默下一个空文件。
 */
export async function runExport(
  token: string,
  entry: ExportEntry,
  p: ExportParams,
  schedule?: ScheduleMeta,
): Promise<ExportResult> {
  switch (entry.id) {
    case 'roster-template':
      return {
        blob: await api.downloadRosterTemplate(token),
        filename: `名单模版-${localDateStamp()}.xlsx`,
      };

    case 'orders-templates': {
      const blob = await api.downloadOrdersTemplateExport(token, {
        template: p.template,
        travelFrom: p.from || undefined,
        travelTo: p.to || undefined,
        flightNumber: p.flightNumber.trim() || undefined,
      });
      // 票务模板文件名对齐出发日（票务岗口径），其余用今天 —— 与订单页 handleTemplateExport 一致
      const dateLabel = p.template === 'ticketing' && p.from ? p.from : localDateStamp();
      return { blob, filename: `订单导出-${EXPORT_TEMPLATE_LABEL[p.template]}-${dateLabel}.xlsx` };
    }

    case 'orders-master': {
      const blob = await api.exportMaster(token, {
        role: 'all', // 代理由服务端强制裁成 agent 视图，这里传什么都不影响
        travelFrom: p.from || undefined,
        travelTo: p.to || undefined,
        from: p.createdFrom || undefined,
        to: p.createdTo || undefined,
      });
      const label =
        p.from || p.to
          ? `${p.from || '全部'}_${p.to || '全部'}`
          : p.createdFrom || p.createdTo
            ? `${p.createdFrom || '全部'}_${p.createdTo || '全部'}`
            : '全部_全部';
      return { blob, filename: `全岗总表_${label}.xlsx` };
    }

    case 'orders-intake': {
      const blob = await api.exportIntake(token, {
        from: p.createdFrom || undefined,
        to: p.createdTo || undefined,
      });
      const label =
        p.createdFrom || p.createdTo
          ? `${p.createdFrom || '起始'}_${p.createdTo || '至今'}`
          : '全部';
      return { blob, filename: `进单统计_${label}.xlsx` };
    }

    case 'orders-by-schedule': {
      const blob = await api.downloadOrdersBySchedule(token, p.scheduleId);
      const fn = schedule?.flightNumber ?? '整班';
      const date = schedule?.date ?? localDateStamp();
      return { blob, filename: `订单明细_${fn}_${date}.xlsx` };
    }

    case 'seat-stats': {
      const blob = await api.exportSeatStats(token, {
        from: p.from || undefined,
        to: p.to || undefined,
        flightNumber: p.flightNumber.trim() || undefined,
      });
      return {
        blob,
        filename: `销售控位表_${p.from || '全部'}_${p.to || p.from || '全部'}.xlsx`,
      };
    }

    case 'room-allocation': {
      const params =
        p.roomMode === 'depart' ? { departDate: p.departDate } : { from: p.from, to: p.to };
      const blob = await api.downloadRoomAllocation(token, params);
      return {
        blob,
        filename:
          p.roomMode === 'depart' ? `分房表-出发${p.departDate}.xlsx` : `分房表-${p.from}.xlsx`,
      };
    }

    case 'hotel-board':
      return {
        blob: await hotelControlOpsApi.downloadBoardExport(token, { from: p.from, to: p.to }),
        filename: `房控导出-${p.from}_${p.to}.xlsx`,
      };

    case 'finance-master':
      return {
        blob: await api.downloadFinanceExport(token, { from: p.from, to: p.to }),
        filename: `财务核对_${p.from}_${p.to}.xlsx`,
      };

    case 'finance-by-flight':
      return {
        blob: await api.downloadFinanceExportByFlight(token, { from: p.from, to: p.to }),
        filename: `按航班_${p.from}_${p.to}.xlsx`,
      };

    case 'finance-by-order':
      return {
        blob: await api.downloadFinanceExportByOrder(token, { from: p.from, to: p.to }),
        filename: `按订单毛利_${p.from}_${p.to}.xlsx`,
      };

    case 'receipt-statement':
      return {
        blob: await api.exportReceiptStatement(token, {
          ...(p.from ? { from: p.from } : {}),
          ...(p.to ? { to: p.to } : {}),
        }),
        filename: `流水核对表${p.from ? `-${p.from}` : ''}${p.to ? `~${p.to}` : ''}.xlsx`,
      };

    case 'reports':
      return {
        blob: await api.downloadReportsXlsx(token, { from: p.from, to: p.to }),
        filename: `经营报表-${p.from}_${p.to}.xlsx`,
      };

    case 'no-show-report':
      return {
        blob: await api.noShow.exportReport(token, {
          from: p.from || undefined,
          to: p.to || undefined,
        }),
        filename: `no-show报表_${p.from || '全部'}_${p.to || p.from || '全部'}.xlsx`,
      };

    default:
      throw new Error(`导出「${entry.name}」还没接上下载动作`);
  }
}

/** Blob → 触发浏览器下载（各页同一套写法，收在这里一份）。 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
