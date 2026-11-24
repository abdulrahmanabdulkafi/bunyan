'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { CMP_STATUSES, StatusBar } from './shared';

interface Domain { id: string; code: string; title_ar: string; title_en: string | null; total: number; covered: number; counts: Record<string, number> }
interface Fw { id: string; code: string; version: string; name_ar: string; name_en: string; total: number; covered: number; counts: Record<string, number>; score: number; domains: Domain[] }
interface Summary { frameworks: Fw[]; unprotected: { id: string; name: string; block_code: string }[] }
interface Lib { id: string; code: string; version: string; name_ar: string; name_en: string; enabled: boolean; active: boolean; leaf_count: string }

export default function Compliance() {
  const { user, model } = useSession();
  const { t, nm, pct } = useI18n();
  const [sum, setSum] = useState<Summary | null>(null);
  const [lib, setLib] = useState<Lib[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api<Summary>('/compliance/summary').then(setSum).catch((e) => setErr(e.message));
    api<Lib[]>('/compliance/frameworks').then(setLib);
  }, []);
  useEffect(load, [load]);
  if (!sum || !model) return err ? <div className="banner error">{err}</div> : <p className="hint">{t('common.loading')}</p>;
  const isOwner = !!user?.roles.includes('R2');
  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('cmp.title')}</h1>
          <p>{t('cmp.subtitle')}</p>
        </div>
        {sum.frameworks.length > 0 && <button className="btn" onClick={() => download('/compliance/report.xlsx', 'compliance-report.xlsx')}>{t('cmp.export')}</button>}
      </div>
      {err && <div className="banner error">{err}</div>}

      {sum.frameworks.length === 0 && <div className="banner warn">{t('cmp.noneEnabled')}</div>}

      {sum.frameworks.map((f) => (
        <section key={f.id} className="section">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{nm(f)} <span className="hint" dir="ltr">{f.code}-{f.version}</span></h2>
            <Link className="btn" href={`/compliance/${f.id}`}>{t('cmp.openControls')}</Link>
          </div>
          <div className="figures">
            <div className="figure"><b>{pct(f.total ? f.covered / f.total : 0)}</b><span>{t('cmp.coverage', { c: f.covered, n: f.total })}</span></div>
            <div className="figure"><b>{pct(f.score)}</b><span>{t('cmp.score')}</span></div>
            <div className="figure"><b>{f.counts.non_compliant}</b><span>{t('cmp.nonCompliant')}</span></div>
            <div className="figure"><b>{f.counts.not_assessed}</b><span>{t('cmp.notAssessed')}</span></div>
          </div>
          <div className="table-wrap" style={{ marginTop: 'var(--s-4)' }}><table>
            <thead><tr><th>{t('cmp.domain')}</th><th className="num">{t('cmp.items')}</th><th className="num">{t('cmp.covered')}</th><th style={{ width: '40%' }}>{t('cmp.statusSplit')}</th></tr></thead>
            <tbody>{f.domains.map((d) => (
              <tr key={d.id}>
                <td><span className="hint" dir="ltr">{d.code}</span> {nm(d, 'title')}</td>
                <td className="num">{d.total}</td>
                <td className="num">{d.covered}</td>
                <td><StatusBar counts={d.counts} total={d.total} /></td>
              </tr>))}
            </tbody>
          </table></div>
          <p className="row hint" style={{ marginTop: 'var(--s-2)' }}>
            {CMP_STATUSES.map((s) => <span key={s}><span className={`swatch sw-${s}`} />{t(`cmp.st.${s}`)}</span>)}
          </p>
        </section>
      ))}

      <section className="section">
        <h2>{t('cmp.unprotected')}</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('cmp.unprotectedHint')}</p>
        {sum.unprotected.length === 0 ? <p className="hint">{t('cmp.allProtected')}</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{t('dash.item')}</th><th>{t('common.block')}</th></tr></thead>
            <tbody>{sum.unprotected.map((x) => <tr key={x.id}><td><Link href={`/records/${x.id}`}>{x.name}</Link></td><td>{blockName(x.block_code)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>

      <section className="section">
        <h2>{t('cmp.frameworks')}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('cmp.framework')}</th><th className="num">{t('cmp.items')}</th><th>{t('cmp.adopted')}</th></tr></thead>
          <tbody>{lib.filter((l) => l.active).map((l) => (
            <tr key={l.id}>
              <td>{nm(l)} <span className="hint" dir="ltr">{l.code}-{l.version}</span></td>
              <td className="num">{l.leaf_count}</td>
              <td><label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={l.enabled} disabled={!isOwner}
                  onChange={async (e) => { await api(`/compliance/frameworks/${l.id}/enabled`, { method: 'PUT', json: { enabled: e.target.checked } }); load(); }} />
                {t(l.enabled ? 'studio.active' : 'studio.inactive')}</label></td>
            </tr>))}
          </tbody>
        </table></div>
        {!isOwner && <p className="hint" style={{ marginTop: 'var(--s-2)' }}>{t('cmp.ownerAdopts')}</p>}
      </section>
    </>
  );
}
