import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

/**
 * Connectors call addresses configured by entity admins, so outbound calls are checked at connect time
 * (after DNS, so rebinding cannot bypass it): cloud metadata / link-local addresses are always refused,
 * and loopback only when CONNECTOR_ALLOW_LOOPBACK=true (tests, single-host installs).
 */
export function blockedAddress(ip: string): boolean {
  const v4 = net.isIPv6(ip) && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 169 && b === 254) return true;          // link-local, cloud metadata
    if (a === 0) return true;
    if (a === 127) return process.env.CONNECTOR_ALLOW_LOOPBACK !== 'true';
    return false;
  }
  const low = v4.toLowerCase();
  if (low.startsWith('fe80') || low === '::') return true;
  if (low === '::1') return process.env.CONNECTOR_ALLOW_LOOPBACK !== 'true';
  return false;
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
    if (err) return callback(err, '', 0);
    if (blockedAddress(String(address))) return callback(new Error(`blocked address ${address}`), '', 0);
    callback(null, address as string, family as number);
  });
};

export interface HttpOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** vCenter appliances often use an internal CA; allow it per connector rather than globally. */
  allowSelfSigned?: boolean;
  ca?: string;
  timeoutMs?: number;
}

/** Minimal JSON-over-HTTP client with per-request TLS settings (global fetch cannot change them per call). */
export function requestJson<T = unknown>(url: string, o: HttpOpts = {}): Promise<{ status: number; body: T }> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.reject(new Error('unsupported protocol'));
  const lib = u.protocol === 'https:' ? https : http;
  // Literal IPs skip DNS lookup, so check them here too.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && blockedAddress(host)) return Promise.reject(new Error(`blocked address ${host}`));
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: o.method ?? 'GET',
      headers: { accept: 'application/json', ...(o.body ? { 'content-type': 'application/json' } : {}), ...o.headers },
      rejectUnauthorized: !o.allowSelfSigned,
      lookup: guardedLookup,
      ca: o.ca || undefined,
      timeout: o.timeoutMs ?? 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 50 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body: body as T });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** Read a dotted path such as "memory.size_MiB" or "guest.os[0].name" from an object. */
export function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    const m = part.match(/^(.+?)\[(\d+)\]$/);
    if (m) return ((acc as Record<string, unknown>)[m[1]] as unknown[] | undefined)?.[Number(m[2])];
    return (acc as Record<string, unknown>)[part];
  }, obj);
}
