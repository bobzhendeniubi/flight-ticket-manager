import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const prismaLogLevels =
  env.NODE_ENV === 'development' ? (['warn', 'error'] as const) : (['error'] as const);

export const prisma = new PrismaClient({
  log: [...prismaLogLevels],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
