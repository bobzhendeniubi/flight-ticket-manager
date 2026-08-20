import { buildApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma, prisma } from './db/prisma.js';
import { disconnectRedis } from './db/redis.js';

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await disconnectPrisma();
      await disconnectRedis();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`🛫 backend listening on http://${env.HOST}:${env.PORT}`);
    let visionConfigured = Boolean(env.DASHSCOPE_API_KEY);
    try {
      const dbAiConfig = await prisma.aiOcrConfig.findFirst({
        select: { enabled: true, apiKey: true },
      });
      visionConfigured = Boolean(
        (dbAiConfig?.enabled !== false && dbAiConfig?.apiKey) || env.DASHSCOPE_API_KEY,
      );
    } catch {
      // 自检不能阻断服务启动；环境变量仍可用于给出保守提示。
      app.log.warn('AI 配置自检无法读取 AiOcrConfig 表，将只按环境变量判断');
    }

    // AI 配置自检：只打印端点/模型/key 长度，绝不打印 key 本身。
    // 存在的坑：宿主机 shell（~/.zshenv 等）里 export 的 OPENAI_API_KEY 会
    // 静默覆盖 .env —— dotenv 默认不覆盖已有的 process.env。曾导致 chat
    // 悄悄回落到 mock 而没有任何报错。这行日志让生效配置一眼可见。
    app.log.info(
      {
        chatModel: env.OPENAI_MODEL,
        chatBaseUrl: env.OPENAI_BASE_URL,
        chatKeyLen: env.OPENAI_API_KEY?.length ?? 0,
        ocrModel: env.QWEN_VL_MODEL,
        ocrBaseUrl: env.QWEN_BASE_URL,
        ocrKeyConfigured: visionConfigured,
      },
      env.OPENAI_API_KEY ? '🤖 AI 已启用' : '🤖 AI 未配 key —— /ai/chat 走本地 mock',
    );

    const chatConfigured = Boolean(env.OPENAI_API_KEY);
    if (chatConfigured && !visionConfigured) {
      app.log.warn('AI 配置不一致：对话助手可用，但护照 OCR 和营销海报不可用');
    } else if (!chatConfigured && visionConfigured) {
      app.log.warn('AI 配置不一致：护照 OCR 和营销海报可用，但对话助手将使用本地 mock');
    }
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', err);
  process.exit(1);
});
