/**
 * 邮件发送 — nodemailer + SMTP。
 *
 * SMTP_HOST 未配置时 sendMail() 静默返回 `{ skipped: true }`，
 * worker 仍继续走完业务流，便于 demo 环境无邮件服务也能运行。
 *
 * 生产推荐：
 *   - Alibaba DirectMail (smtpdm.aliyun.com:465, SSL)
 *   - AWS SES (email-smtp.{region}.amazonaws.com:587, STARTTLS)
 *   - Mailtrap（测试）、Postmark / Sendgrid（海外）
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  cc?: string;
  bcc?: string;
}

export interface SendMailResult {
  skipped?: boolean;
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}

// 懒加载单例 —— worker 每次 job 不重建连接
let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!env.SMTP_HOST || !env.SMTP_PORT) return null;
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASS
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined,
    // 本地 demo 可能用自签证书
    tls: { rejectUnauthorized: env.NODE_ENV === 'production' },
  });
  return transporter;
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const tx = getTransporter();
  if (!tx) {
    // eslint-disable-next-line no-console
    console.log(`[mailer] SMTP not configured — skipping mail to ${input.to} "${input.subject}"`);
    return { skipped: true };
  }

  const info = await tx.sendMail({
    from: env.SMTP_FROM,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });

  // eslint-disable-next-line no-console
  console.log(`[mailer] ✓ sent to ${input.to} · messageId=${info.messageId}`);
  return {
    messageId: info.messageId,
    accepted: (info.accepted as string[] | undefined) ?? [],
    rejected: (info.rejected as string[] | undefined) ?? [],
  };
}

/** 关闭连接池（server shutdown 时调用） */
export async function closeMailer(): Promise<void> {
  if (transporter) {
    transporter.close();
    transporter = null;
  }
}
