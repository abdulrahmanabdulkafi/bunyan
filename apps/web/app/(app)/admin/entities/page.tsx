'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { OneTimePassword } from '@/lib/OneTimePassword';

interface T { id: string; code: string; name_ar: string; name_en: string | null; kind: 'sector' | 'entity'; parent_id: string | null; active: boolean; classification: string; users: string; records: string }
const CLASSES = ['top_secret', 'secret', 'restricted', 'public'];

/** Platform admin: sector offices and government entities, each with its own isolated repository. */
export default function Entities() {
  const { t, nm } = useI18n();
  const [list, setList] = useState<T[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [otp, setOtp] = useState<{ email: string; pw: string } | null>(null);
  const [nf, setNf] = useState({ kind: 'entity', code: '', name_ar: '', name_en: '', parent_id: '' });
  const [admin, setAdmin] = useState<{ tenant: string; email: string; name: string } | null>(null);
  const load = useCallback(() => { api<T[]>('/tenants').then(setList); }, []);
  useEffect(load, [load]);
  const sectors = list.filter((x) => x.kind === 'sector');

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); load(); }
    catch (e) { setMsg({ kind: 'error', text: e instanceof ApiError && e.errors.length ? e.errors.map((x) => `${x.key}: ${x.message}`).join(t('list.sep')) : (e as Error).message }); }
  }

  return (
    <>
      <div className="page-head"><div><h1>{t('ent.title')}</h1><p>{t('ent.subtitle')}</p></div></div>
      {otp && <OneTimePassword email={otp.email} pw={otp.pw} onClose={() => setOtp(null)} />}
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>{t('common.name')}</th><th>{t('ent.kind')}</th><th>{t('ent.parent')}</th><th>{t('ent.classification')}</th><th className="num">{t('ent.users')}</th><th className="num">{t('dash.colRecords')}</th><th>{t('studio.activeShort')}</th><th /></tr></thead>
        <tbody>{list.map((x) => (
          <tr key={x.id} style={x.active ? undefined : { color: 'var(--ink-3)' }}>
            <td>{nm(x)} <span className="hint" dir="ltr">{x.code}</span></td>
            <td>{t(`ent.kind.${x.kind}`)}</td>
            <td>{nm(list.find((p) => p.id === x.parent_id)) || '—'}</td>
            <td><select value={x.classification} style={{ width: 'auto' }} aria-label={t('ent.classification')}
              onChange={(e) => run(() => api(`/tenants/${x.id}`, { method: 'PATCH', json: { classification: e.target.value } }), t('ent.saved'))}>
              {CLASSES.map((c) => <option key={c} value={c}>{t(`cls.${c}`)}</option>)}</select></td>
            <td className="num">{x.users}</td>
            <td className="num">{x.records}</td>
            <td><input type="checkbox" checked={x.active} aria-label={t('studio.activeShort')} onChange={(e) => run(() => api(`/tenants/${x.id}`, { method: 'PATCH', json: { active: e.target.checked } }), t('ent.saved'))} /></td>
            <td>{x.kind === 'entity' && <button className="btn quiet" onClick={() => setAdmin({ tenant: x.id, email: '', name: '' })}>{t('ent.addAdmin')}</button>}</td>
          </tr>))}
        </tbody>
      </table></div>

      {admin && (
        <section className="section">
          <h2>{t('ent.addAdminTitle', { name: nm(list.find((x) => x.id === admin.tenant)) })}</h2>
          <p className="hint" style={{ margin: 'var(--s-2) 0 var(--s-3)' }}>{t('ent.addAdminHint')}</p>
          <div className="form-grid">
            <label className="field">{t('login.email')}<input dir="ltr" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></label>
            <label className="field">{t('common.name')}<input value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} /></label>
          </div>
          <div className="row" style={{ marginTop: 'var(--s-3)' }}>
            <button className="btn primary" disabled={!admin.email || !admin.name} onClick={() => run(async () => {
              const r = await api<{ temporary_password: string }>('/users', { method: 'POST', json: { email: admin.email, display_name: admin.name, roles: ['R1'], tenant_id: admin.tenant } });
              setOtp({ email: admin.email, pw: r.temporary_password }); setAdmin(null);
            }, t('users.created'))}>{t('users.create')}</button>
            <button className="btn quiet" onClick={() => setAdmin(null)}>{t('common.cancel')}</button>
          </div>
        </section>
      )}

      <section className="section">
        <h2>{t('ent.add')}</h2>
        <div className="form-grid" style={{ marginTop: 'var(--s-3)' }}>
          <label className="field">{t('ent.kind')}<select value={nf.kind} onChange={(e) => setNf({ ...nf, kind: e.target.value })}>
            <option value="entity">{t('ent.kind.entity')}</option><option value="sector">{t('ent.kind.sector')}</option></select></label>
          <label className="field">{t('ent.code')}<input dir="ltr" placeholder="seda" value={nf.code} onChange={(e) => setNf({ ...nf, code: e.target.value.toLowerCase() })} />
            <span className="hint">{t('ent.codeHint')}</span></label>
          <label className="field">{t('studio.nameAr')}<input dir="rtl" value={nf.name_ar} onChange={(e) => setNf({ ...nf, name_ar: e.target.value })} /></label>
          <label className="field">{t('studio.nameEn')}<input dir="ltr" value={nf.name_en} onChange={(e) => setNf({ ...nf, name_en: e.target.value })} /></label>
          {nf.kind === 'entity' && <label className="field">{t('ent.parent')}<select value={nf.parent_id} onChange={(e) => setNf({ ...nf, parent_id: e.target.value })}>
            <option value="">—</option>{sectors.map((s) => <option key={s.id} value={s.id}>{nm(s)}</option>)}</select></label>}
        </div>
        <p className="hint" style={{ marginTop: 'var(--s-2)' }}>{t('ent.templateHint')}</p>
        <button className="btn primary" style={{ marginTop: 'var(--s-3)' }} disabled={!nf.code || !nf.name_ar}
          onClick={() => run(() => api('/tenants', { method: 'POST', json: { kind: nf.kind, code: nf.code, name_ar: nf.name_ar, name_en: nf.name_en || undefined, parent_id: nf.parent_id || null } })
            .then(() => setNf({ kind: 'entity', code: '', name_ar: '', name_en: '', parent_id: '' })), t('ent.created'))}>{t('ent.create')}</button>
      </section>
    </>
  );
}
