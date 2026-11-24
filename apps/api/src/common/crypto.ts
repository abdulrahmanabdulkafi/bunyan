import crypto from 'node:crypto';
import { config } from './config.js';

// ───────────── Secrets at rest: AES-256-GCM ─────────────
function key(): Buffer {
  if (config.connectorKey) {
    const k = Buffer.from(config.connectorKey, 'base64');
    if (k.length !== 32) throw new Error('CONNECTOR_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  return crypto.createHash('sha256').update(`bunyan-connectors:${config.jwtSecret}`).digest();
}
export function seal(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
export function unseal<T = Record<string, string>>(s: string | null): T {
  if (!s) return {} as T;
  const [v, iv, tag, data] = s.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
}

// ───────────── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) — works with any authenticator app ─────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export function totp(secretB32: string, at = Date.now()): string {
  return hotp(unbase32(secretB32), Math.floor(at / 30_000));
}
/** Accept the current step and one step either side, to allow for clock drift. */
export function verifyTotp(secretB32: string, code: string, at = Date.now()): boolean {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(at / 30_000);
  const secret = unbase32(secretB32);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(hotp(secret, step + d)), Buffer.from(c)));
}
export function newTotpSecret(): string {
  return base32(crypto.randomBytes(20));
}

// ───────────── Password policy ─────────────
/** Returns a list of unmet rules (empty = acceptable). Messages are Arabic; the error filter translates them. */
export function passwordProblems(pw: string, email = ''): string[] {
  const p: string[] = [];
  if (pw.length < config.passwordMinLength) p.push(`يجب ألا تقل كلمة المرور عن ${config.passwordMinLength} حرفاً`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) p.push('يجب أن تجمع كلمة المرور ثلاثة على الأقل من: حروف صغيرة، حروف كبيرة، أرقام، رموز');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && pw.toLowerCase().includes(local)) p.push('يجب ألا تتضمن كلمة المرور اسم المستخدم');
  return p;
}
/** Readable temporary password that meets the policy. */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 7)}-${s.slice(7)}#9a`;
}
