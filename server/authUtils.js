// Password/PIN hashing + verification.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// Legacy hash used by older versions of this app (SHA-256, no salt).
// Kept only to verify and migrate pre-existing accounts on their next login.
export function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

export async function hashPassword(password) {
  return bcrypt.hash(String(password), 10);
}

// PIN never has a legacy plaintext/SHA-256 form to migrate — always bcrypt,
// always hashed with hashPassword() before storage. `storedHash` is null for
// a staff member who hasn't set a PIN yet.
export async function verifyPin(pin, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(String(pin), storedHash);
}

// Returns { ok, needsRehash } - ok is true if `password` matches `storedHash`,
// which may be a bcrypt hash or a legacy SHA-256 hash.
export async function verifyPassword(password, storedHash) {
  if (!storedHash) return { ok: false, needsRehash: false };
  if (storedHash.startsWith('$2')) {
    return { ok: await bcrypt.compare(String(password), storedHash), needsRehash: false };
  }
  const ok = legacySha256(password) === storedHash;
  return { ok, needsRehash: ok };
}
