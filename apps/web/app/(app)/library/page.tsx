'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Lib { id: string; code: string; version: string; name_ar: string; name_en: string; issuer_ar: string | null; active: boolean; item_count: string; leaf_count: string }

/** Platform admin: the national compliance libraries (FR-10-01). A new version is a new framework, so past assessments stay. */
export default function Library() {
  const { t, nm } = useI18n();
  const [list, setList] = useState<Lib[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [nf, setNf] = useState({ code: '', version: '', name_ar: '', name_en: '', issuer_ar: '' });
  const load = useCallback(() => { api<Lib[]>('/compliance/frameworks').then(setList); }, []);
  useEffect(load, [load]);

  async function upload(id: string, file: File) {
    setMsg(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api<{ created: number; updated: number }>(`/compliance/frameworks/${id}/import`, { method: 'POST', body: fd });
      setMsg({ kind: 'ok', text: t('lib.imported', { c: r.created, u: r.updated }) }); load();
    } catch (e) {
      const errs = (e as { errors?: { key?: string; message: string }[] }).errors ?? [];
      setMsg({ kind: 'error', text: `${(e as Error).message}${errs.length ? ` — ${errs.slice(0, 8).map((x) => `${t('io.row')} ${x.key}: ${x.message}`).join(t('list.sep'))}` : ''}` });
    }
  }

  return (
    <>
      <div className="page-head"><div><h1>{t('lib.title')}</h1><p>{t('lib.subtitle')}</p></div></div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>{t('cmp.framework')}</th><th className="num">{t('lib.items')}</th><th className="num">{t('cmp.items')}</th><th>{t('studio.activeShort')}</th><th /></tr></thead>
        <tbody>{list.map((l) => (
          <tr key={l.id}>
            <td>{nm(l)} <span className="hint" dir="ltr">{l.code}-{l.version}</span>{l.issuer_ar && <span className="hint" style={{ display: 'block' }}>{l.issuer_ar}</span>}</td>
            <td className="num">{l.item_count}</td>
            <td className="num">{l.leaf_count}</td>
            <td><input type="checkbox" checked={l.active} aria-label={t('studio.activeShort')} onChange={async (e) => { await api(`/compliance/frameworks/${l.id}`, { method: 'PATCH', json: { active: e.target.checked } }); load(); }} /></td>
            <td className="row">
              <button className="btn" onClick={() => download(`/compliance/frameworks/${l.id}/template`, `${l.code}-${l.version.replace(':', '-')}.xlsx`)}>{t('lib.download')}</button>
              <label className="btn">{t('lib.upload')}<input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(l.id, f); e.target.value = ''; }} /></label>
            </td>
          </tr>))}
        </tbody>
      </table></div>
      <p className="hint" style={{ marginTop: 'var(--s-2)' }}>{t('lib.templateHint')}</p>

      <section className="section">
        <h2>{t('lib.add')}</h2>
        <div className="form-grid" style={{ marginTop: 'var(--s-3)' }}>
          <label className="field">{t('lib.code')}<input dir="ltr" placeholder="CCC" value={nf.code} onChange={(e) => setNf({ ...nf, code: e.target.value })} /></label>
          <label className="field">{t('lib.version')}<input dir="ltr" placeholder="2:2024" value={nf.version} onChange={(e) => setNf({ ...nf, version: e.target.value })} /></label>
          <label className="field">{t('studio.nameAr')}<input dir="rtl" value={nf.name_ar} onChange={(e) => setNf({ ...nf, name_ar: e.target.value })} /></label>
          <label className="field">{t('studio.nameEn')}<input dir="ltr" value={nf.name_en} onChange={(e) => setNf({ ...nf, name_en: e.target.value })} /></label>
          <label className="field">{t('lib.issuer')}<input value={nf.issuer_ar} onChange={(e) => setNf({ ...nf, issuer_ar: e.target.value })} /></label>
        </div>
        <button className="btn primary" style={{ marginTop: 'var(--s-3)' }} disabled={!nf.code || !nf.version || !nf.name_ar || !nf.name_en}
          onClick={async () => {
            try { await api('/compliance/frameworks', { method: 'POST', json: { ...nf, issuer_ar: nf.issuer_ar || undefined } }); setNf({ code: '', version: '', name_ar: '', name_en: '', issuer_ar: '' }); setMsg({ kind: 'ok', text: t('lib.created') }); load(); }
            catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
          }}>{t('lib.create')}</button>
      </section>
    </>
  );
}
