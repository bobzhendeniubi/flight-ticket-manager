import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[redis] connection error:', err.message);
});

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
