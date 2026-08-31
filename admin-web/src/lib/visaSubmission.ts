/**
 * 乘客送签进度的文案 / 徽章（三档），签证台与订单列表共用——
 * 两处展示同一状态，文案必须一致，改档位只改这一处。
 */
import type { VisaSubmissionStatus } from './api';

export const SUBMISSION_LABEL: Record<VisaSubmissionStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '材料准备',
  CONFIRMED: '已送签',
};

export const SUBMISSION_BADGE: Record<VisaSubmissionStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
};
