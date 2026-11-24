'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { OneTimePassword } from '@/lib/OneTimePassword';

interface U {
  id: string; tenant_id: string | null; tenant_name_ar: string | null; tenant_name_en: string | null; email: string; display_name: string;
  roles: string[]; scope: { domains?: string[] }; active: boolean; mfa_enabled: boolean; must_change_password: boolean; locked: boolean; last_login_at: string | null;
}
interface T { id: string; name_ar: string; name_en: string | null; kind: string }
const ENTITY_ROLES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const PLATFORM_ROLES = ['R1', 'R8', 'R9'];
const SCOPED = ['R4', 'R5'];
const DOMAINS = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'];

export default function Users() {
  const { user } = useSession();
  const { t, nm, date } = useI18n();
  const [list, setList] = useState<U[] | null>(null);
  const [tenants, setTenants] = useState<T[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [otp, setOtp] = useState<{ email: string; pw: string } | null>(null);
  const [edit, setEdit] = useState<U | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const platform = !!user?.roles.includes('R0');
  const load = useCallback(() => { api<U[]>('/users').then(setList).catch((e) => setMsg({ kind: 'error', text: e.message })); }, []);
  useEffect(() => { load(); api<T[]>('/tenants').then(setTenants); }, [load]);
  const shown = useMemo(() => (list ?? []).filter((u) => !q || `${u.email} ${u.display_name}`.toLowerCase().includes(q.toLowerCase())), [list, q]);
  if (!user) return null;

  async function act(path: string, ok: string, body?: object) {
    setMsg(null);
    try {
      const r = await api<{ temporary_password?: string }>(path, { method: body ? 'PATCH' : 'POST', json: body });
      if (r?.temporary_password) setOtp({ email: edit?.email ?? '', pw: r.temporary_password });
      setMsg({ kind: 'ok', text: ok }); load();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>{t('users.title')}</h1><p>{t(platform ? 'users.subtitlePlatform' : 'users.subtitle')}</p></div>
        <button className="btn primary" onClick={() => { setEdit(null); dlg.current?.showModal(); }}>{t('users.add')}</button>
      </div>
      {otp && <OneTimePassword email={otp.email} pw={otp.pw} onClose={() => setOtp(null)} />}
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <input type="search" placeholder={t('users.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 'var(--s-3)' }} aria-label={t('repo.searchLabel')} />
      <div className="table-wrap"><table>
        <thead><tr><th>{t('common.name')}</th>{platform && <th>{t('nat.entity')}</th>}<th>{t('users.roles')}</th><th>{t('common.status')}</th><th>{t('users.lastLogin')}</th><th /></tr></thead>
        <tbody>{shown.map((u) => (
          <tr key={u.id} style={u.active ? undefined : { color: 'var(--ink-3)' }}>
            <td>{u.display_name}<span className="hint" style={{ display: 'block' }} dir="ltr">{u.email}</span></td>
            {platform && <td>{u.tenant_id ? nm({ name_ar: u.tenant_name_ar, name_en: u.tenant_name_en }) : t('nav.nationalPlatform')}</td>}
            <td>{u.roles.map((r) => t(`role.${r}`)).join(t('list.sep'))}{u.scope?.domains?.length ? <span className="hint" style={{ display: 'block' }}>{u.scope.domains.map((d) => t(`domain.${d}`)).join(t('list.sep'))}</span> : null}</td>
            <td><span className="row" style={{ gap: 4 }}>
              {!u.active && <span className="status st-archived">{t('users.disabled')}</span>}
              {u.locked && <span className="status st-rejected">{t('users.locked')}</span>}
              {u.must_change_password && <span className="status st-submitted">{t('users.mustChange')}</span>}
              {u.mfa_enabled && <span className="status st-approved">{t('users.mfa')}</span>}
            </span></td>
            <td>{u.last_login_at ? date(u.last_login_at) : <span className="hint">{t('users.never')}</span>}</td>
            <td><button className="btn quiet" onClick={() => { setEdit(u); dlg.current?.showModal(); }}>{t('users.manage')}</button></td>
          </tr>))}
        </tbody>
      </table></div>
      <dialog ref={dlg} aria-labelledby="ud" onClose={() => setEdit(null)}>
        <UserForm key={edit?.id ?? 'new'} u={edit} platform={platform} tenants={tenants} selfId={user.id}
          onCreated={(email, pw) => { dlg.current?.close(); if (pw) setOtp({ email, pw }); setMsg({ kind: 'ok', text: t('users.created') }); load(); }}
          onSave={(body) => { const id = edit!.id; dlg.current?.close(); act(`/users/${id}`, t('users.saved'), body); }}
          onAction={(path, ok) => { const e = edit!; dlg.current?.close(); setEdit(e); act(`/users/${e.id}/${path}`, ok); }}
          onCancel={() => dlg.current?.close()} />
      </dialog>
    </>
  );
}

function UserForm({ u, platform, tenants, selfId, onCreated, onSave, onAction, onCancel }: {
  u: U | null; platform: boolean; tenants: T[]; selfId: string;
  onCreated: (email: string, pw: string | null) => void; onSave: (b: object) => void; onAction: (path: string, ok: string) => void; onCancel: () => void;
}) {
  const { t, nm } = useI18n();
  const [email, setEmail] = useState(u?.email ?? '');
  const [name, setName] = useState(u?.display_name ?? '');
  const [roles, setRoles] = useState<string[]>(u?.roles ?? (platform ? ['R1'] : ['R6']));
  const [domains, setDomains] = useState<string[]>(u?.scope?.domains ?? []);
  const [tenantId, setTenantId] = useState(u?.tenant_id ?? '');
  const [sso, setSso] = useState(false);
  const [active, setActive] = useState(u?.active ?? true);
  const [err, setErr] = useState('');
  const options = platform ? PLATFORM_ROLES : ENTITY_ROLES;
  const needsTenant = platform && roles.some((r) => r !== 'R8');
  const scoped = roles.some((r) => SCOPED.includes(r)) && !roles.some((r) => ['R2', 'R3'].includes(r));

  async function create() {
    setErr('');
    try {
      const r = await api<{ temporary_password: string | null }>('/users', { method: 'POST', json: {
        email, display_name: name, roles, scope: scoped ? { domains } : {}, sso_only: sso, ...(platform && tenantId ? { tenant_id: tenantId } : {}),
      } });
      onCreated(email, r.temporary_password);
    } catch (e) { setErr(e instanceof ApiError && e.errors.length ? e.errors.map((x) => x.message).join(t('list.sep')) : (e as Error).message); }
  }

  return (
    <>
      <h2 id="ud" style={{ marginBottom: 'var(--s-4)' }}>{u ? u.display_name : t('users.add')}</h2>
      {err && <div className="banner error">{err}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label className="field">{t('login.email')}<input dir="ltr" type="email" value={email} disabled={!!u} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">{t('common.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {platform && !u && (
          <label className="field wide">{t('users.tenant')}
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">{t('nav.nationalPlatform')}</option>
              {tenants.map((x) => <option key={x.id} value={x.id}>{nm(x)}</option>)}
            </select>
            {needsTenant && !tenantId && <span className="field-error">{t('users.tenantNeeded')}</span>}
          </label>
        )}
      </div>
      <fieldset style={{ border: 'none', padding: 0, margin: 'var(--s-4) 0 0' }}>
        <legend className="hint">{t('users.roles')}</legend>
        <div className="row">{options.map((r) => (
          <label key={r} className="row" style={{ gap: 6, minWidth: 210 }}>
            <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{t(`role.${r}`)}
          </label>))}
        </div>
      </fieldset>
      {scoped && (
        <fieldset style={{ border: 'none', padding: 0, margin: 'var(--s-3) 0 0' }}>
          <legend className="hint">{t('users.scope')}</legend>
          <div className="row">{DOMAINS.map((d) => (
            <label key={d} className="row" style={{ gap: 6, minWidth: 160 }}>
              <input type="checkbox" checked={domains.includes(d)} onChange={(e) => setDomains(e.target.checked ? [...domains, d] : domains.filter((x) => x !== d))} />{t(`domain.${d}`)}
            </label>))}
          </div>
        </fieldset>
      )}
      {!u && <label className="row" style={{ gap: 6, marginTop: 'var(--s-3)' }}><input type="checkbox" checked={sso} onChange={(e) => setSso(e.target.checked)} />{t('users.ssoOnly')}</label>}
      {u && u.id !== selfId && <label className="row" style={{ gap: 6, marginTop: 'var(--s-3)' }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('users.active')}</label>}
      {u && (
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <button className="btn" onClick={() => onAction('reset-password', t('users.resetDone'))}>{t('users.resetPassword')}</button>
          {u.locked && <button className="btn" onClick={() => onAction('unlock', t('users.unlocked'))}>{t('users.unlock')}</button>}
          {u.mfa_enabled && <button className="btn" onClick={() => onAction('reset-mfa', t('users.mfaReset'))}>{t('users.resetMfa')}</button>}
        </div>
      )}
      <div className="row" style={{ marginTop: 'var(--s-5)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={onCancel}>{t('common.cancel')}</button>
        {u
          ? <button className="btn primary" disabled={!roles.length || !name} onClick={() => onSave({ roles, display_name: name, scope: scoped ? { domains } : {}, ...(u.id !== selfId ? { active } : {}) })}>{t('common.save')}</button>
          : <button className="btn primary" disabled={!email || !name || !roles.length || (needsTenant && !tenantId)} onClick={create}>{t('users.create')}</button>}
      </div>
    </>
  );
}
