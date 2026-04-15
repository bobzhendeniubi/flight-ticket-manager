import { createHash, randomBytes } from 'node:crypto';

/** Generate an opaque refresh token (returned to client) and its sha256 hash (stored in DB). */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(48).toString('base64url');
  const tokenHash = hashToken(token);
  return { token, tokenHash };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
