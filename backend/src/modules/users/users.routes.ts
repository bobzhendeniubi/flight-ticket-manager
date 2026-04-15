import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        displayName: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) throw new NotFoundError('User not found');
    return { user };
  });
};
