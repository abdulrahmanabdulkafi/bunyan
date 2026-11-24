'use client';

export interface User { id: string; tenantId: string | null; email: string; name: string; roles: string[]; scope: { domains?: string[]; blocks?: string[] } }
export interface Attr { key: string; name_ar: string; name_en: string; type: string; required: boolean; options: { value: string; label_ar?: string; label_en?: string }[]; multiple: boolean; strict: boolean; active: boolean; description: string | null; is_custom: boolean }
export interface Block { code: string; domain_code: string; name_ar: string; name_en: string; active: boolean; title_key: string | null; is_custom: boolean; attributes: Attr[] }
export interface Relation { id: string; source_code: string; verb: string; target_code: string; name_ar: string | null; description: string | null; active: boolean }
export interface Domain { code: string; name_ar: string; name_en: string; active: boolean }
export interface Model { domains: Domain[]; blocks: Block[]; relations: Relation[] }
export interface Rec { id: string; block_code: string; name: string; attrs: Record<string, unknown>; status: string; version: number; source: string; updated_at: string; completeness: number }

const KEY = 'bunyan.session';

function lang(): 'ar' | 'en' {
  try { return typeof window !== 'undefined' && localStorage.getItem('bunyan.lang') === 'en' ? 'en' : 'ar'; } catch { return 'ar'; }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(KEY);
}
export function setToken(t: string | null) {
  if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors: { key?: string; message: string; row?: number; sheet?: string }[] = [], public body: unknown = null) { super(message); }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  headers['accept-language'] = lang();
  let body = init.body;
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
  const res = await fetch(`/api${path}`, { ...init, headers, body });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken(null);
    if (typeof window !== 'undefined') window.location.href = '/login';
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = typeof data?.message === 'string' ? data.message : lang() === 'en' ? 'The request could not be completed' : 'تعذّر تنفيذ الطلب';
    throw new ApiError(res.status, msg, data?.errors ?? [], data);
  }
  return data as T;
}

export async function download(path: string, filename: string) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`/api${path}${sep}lang=${lang()}`, { headers: { authorization: `Bearer ${getToken()}`, 'accept-language': lang() } });
  if (!res.ok) throw new ApiError(res.status, lang() === 'en' ? 'The file could not be downloaded' : 'تعذّر تنزيل الملف');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Mirror of the server's permission matrix — used only to hide controls; the API still enforces every rule. */
const PERMS: Record<string, string[]> = {
  'users.manage': ['R0', 'R1'], 'metamodel.edit': ['R0', 'R2'], 'records.read': ['R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
  'records.write': ['R2', 'R3', 'R4', 'R5'], 'records.import': ['R2', 'R3', 'R4', 'R5'], 'records.review': ['R2', 'R3', 'R4'],
  'records.approve': ['R2'], 'records.archive': ['R2'], 'audit.read': ['R0', 'R1', 'R2', 'R7'],
  'dashboard.national': ['R2', 'R6', 'R8', 'R9'], 'integrations.manage': ['R1', 'R2'], 'compliance.read': ['R2', 'R3', 'R4', 'R6', 'R7'], 'compliance.library': ['R0'], 'cost.read': ['R2', 'R3', 'R4', 'R6', 'R7'],
};
export function can(u: User | null, perm: string) {
  return !!u && (PERMS[perm] ?? []).some((r) => u.roles.includes(r));
}
export function canInScope(u: User | null, perm: string, b: Block) {
  if (!can(u, perm)) return false;
  const unscoped = (PERMS[perm] ?? []).filter((r) => r !== 'R4' && r !== 'R5');
  if (unscoped.some((r) => u!.roles.includes(r))) return true;
  return !!(u!.scope.domains?.includes(b.domain_code) || u!.scope.blocks?.includes(b.code));
}


export interface VpMeta { code: string; domain: string; name_ar: string; name_en: string; purpose_ar: string; purpose_en: string; phase2?: boolean; kind: string; missing: string[] }
