/**
 * 企业微信群机器人 webhook —— markdown 消息推送。
 *
 * 未配置 WECOM_WEBHOOK_URL 时直接 no-op（{skipped:true}），不报错、不重试——群推送是
 * 增强能力，没配置地址不该拖垮任何业务流程（提醒生成 / 工单创建 / 履约指派都要在
 * 没配置时表现如常）。是否真的发送还额外受 REMINDER_WEBHOOK_PUSH feature flag 控制，
 * 那道闸由各调用方在调本函数前自己判——本文件只管「配没配、发没发成功」。
 *
 * 每次真正尝试发送（配置了 URL）都落一行 NotificationLog（channel WECHAT），
 * 便于事后追查「有没有真的推过、群那边为什么没收到」；未配置 URL 的 no-op 不落日志
 * （没有任何动作发生，落一条「跳过」记录只会污染统计）。
 */
import { NotificationChannel, NotificationStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma.js';
import { env } from '../config/env.js';

export interface WecomPushResult {
  /** true = 未配置 WECOM_WEBHOOK_URL，本次调用什么都没做 */
  skipped: boolean;
  /** skipped=false 时才有意义：请求是否成功 */
  ok?: boolean;
  error?: string;
}

/** 企业微信群机器人 markdown 消息体官方上限：4096 字节（UTF-8）。 */
const WECOM_MARKDOWN_BYTE_LIMIT = 4096;
const TRUNCATE_SUFFIX = '\n…（内容过长已截断）';

/** 按字节上限截断文本，不切断多字节字符（逐字符收窄，比正则安全）。 */
export function truncateToByteLimit(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const budget = Math.max(0, limit - Buffer.byteLength(TRUNCATE_SUFFIX, 'utf8'));
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > budget) {
    end -= 1;
  }
  return `${text.slice(0, end)}${TRUNCATE_SUFFIX}`;
}

/**
 * 推一条 markdown 消息到企业微信群机器人。
 *
 * @param text markdown 正文（超出企业微信 4096 字节上限会自动截断）
 * @param purpose 落 NotificationLog.template 的用途标签（如 'reminder-daily-summary' /
 *   'work-order-created' / 'fulfillment-assigned'），便于按场景过滤留痕。
 * @param client 可选注入 Prisma client（测试用）；缺省用全局单例。
 */
export async function pushWecomMarkdown(
  text: string,
  purpose: string,
  client: PrismaClient = defaultPrisma,
): Promise<WecomPushResult> {
  const url = env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true };

  const body = truncateToByteLimit(text, WECOM_MARKDOWN_BYTE_LIMIT);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: body } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const respText = await resp.text().catch(() => '');
      const error = `HTTP ${resp.status}${respText ? `: ${respText.slice(0, 300)}` : ''}`;
      await logNotification(client, { purpose, text: body, status: 'FAILED', error });
      return { skipped: false, ok: false, error };
    }
    await logNotification(client, { purpose, text: body, status: 'SENT', error: null });
    return { skipped: false, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logNotification(client, { purpose, text: body, status: 'FAILED', error: message });
    return { skipped: false, ok: false, error: message };
  }
}

async function logNotification(
  client: PrismaClient,
  input: { purpose: string; text: string; status: 'SENT' | 'FAILED'; error: string | null },
): Promise<void> {
  try {
    await client.notificationLog.create({
      data: {
        channel: NotificationChannel.WECHAT,
        recipient: 'wecom-webhook',
        template: input.purpose,
        payload: input.text,
        status: input.status === 'SENT' ? NotificationStatus.SENT : NotificationStatus.FAILED,
        lastError: input.error,
        sentAt: input.status === 'SENT' ? new Date() : null,
      },
    });
  } catch (err) {
    // 落日志失败不该反过来让推送结果失真（fetch 可能是成功的）；控制台留痕即可。
    // eslint-disable-next-line no-console
    console.error('[wecom-webhook] failed to write NotificationLog', err);
  }
}
