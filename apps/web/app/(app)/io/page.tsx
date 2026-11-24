'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError, canInScope, download } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Report { dryRun: boolean; created: number; updated: number; errors: { sheet: string; row: number; key?: string; message: string }[] }

export default function ImportExport() {
  const { user, model, reloadModel } = useSession();
  const { t, nm } = useI18n();
  const [chosen, setChosen] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!model) return null;
  const blocks = model.blocks.filter((b) => b.active && canInScope(user, 'records.import', b));
  const attrName = (key?: string) => {
    if (!key) return '';
    for (const b of model.blocks) { const a = b.attributes.find((x) => x.key === key); if (a) return nm(a); }
    return key;
  };

  async function upload(dry: boolean) {
    if (!file) return;
    setBusy(true); setErr(''); setReport(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      setReport(await api<Report>(`/io/import${dry ? '?dryRun=true' : ''}`, { method: 'POST', body: fd }));
      if (!dry) reloadModel();
    } catch (e) {
      if (e instanceof ApiError && (e.body as Report)?.errors) setReport(e.body as Report);
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><div>
        <h1>{t('io.title')}</h1>
        <p>{t('io.subtitle')}</p>
      </div></div>

      <section className="section">
        <h2>{t('io.step1')}</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('io.step1Hint')}</p>
        <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
          {blocks.map((b) => (
            <label key={b.code} className="row" style={{ gap: 6, fontSize: 14, minWidth: 200 }}>
              <input type="checkbox" checked={chosen.includes(b.code)} onChange={(e) => setChosen(e.target.checked ? [...chosen, b.code] : chosen.filter((c) => c !== b.code))} />
              {nm(b)}
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn" disabled={!chosen.length} onClick={() => download(`/io/export?blocks=${chosen.join(',')}`, 'bunyan-template.xlsx')}>{t('io.blank')}</button>
          <button className="btn" disabled={!chosen.length} onClick={() => download(`/io/export?blocks=${chosen.join(',')}&withData=true`, 'bunyan-data.xlsx')}>{t('io.withData')}</button>
        </div>
      </section>

      <section className="section">
        <h2>{t('io.step2')}</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('io.step2Hint')}</p>
        <div className="row">
          <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }} style={{ maxWidth: 360 }} aria-label={t('io.file')} />
          <button className="btn" disabled={!file || busy} onClick={() => upload(true)}>{t('io.check')}</button>
          <button className="btn primary" disabled={!file || busy} onClick={() => upload(false)}>{t('io.import')}</button>
        </div>
        {err && <div className="banner error" style={{ marginTop: 'var(--s-3)' }}>{err}</div>}
        {report && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            {report.errors.length ? (
              <>
                <div className="banner error">{t('io.failed', { n: report.errors.length })}</div>
                <div className="table-wrap"><table>
                  <thead><tr><th>{t('io.sheet')}</th><th className="num">{t('io.row')}</th><th>{t('io.attribute')}</th><th>{t('io.error')}</th></tr></thead>
                  <tbody>{report.errors.map((e, i) => <tr key={i}><td>{e.sheet}</td><td className="num">{e.row}</td><td>{attrName(e.key)}</td><td>{e.message}</td></tr>)}</tbody>
                </table></div>
              </>
            ) : (
              <div className="banner ok">{t(report.dryRun ? 'io.dryOk' : 'io.done', { c: report.created, u: report.updated })}</div>
            )}
          </div>
        )}
      </section>

      <section className="section">
        <h2>{t('io.wizardTitle')}</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('io.wizardHint')}</p>
        <Link className="btn primary" href="/io/wizard">{t('io.wizardOpen')}</Link>
      </section>
    </>
  );
}
