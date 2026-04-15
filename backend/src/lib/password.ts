import argon2 from 'argon2';

/**
 * Argon2id parameters tuned for interactive login latency (~50ms on modern server).
 * Adjust memoryCost / timeCost based on production hardware benchmarks.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
