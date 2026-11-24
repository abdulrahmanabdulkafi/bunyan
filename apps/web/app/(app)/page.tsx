'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, can } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Dash {
  blocks: { code: string; name_ar: string; domain: string; total: number; approved: number; pending: number; completeness: number; orphans: number }[];
  alerts: { id: string; name: string; block: string; kind: string; date?: string }[];
}

export default function Dashboard() {
  const { user, model } = useSession();
  const { t, nm, pct } = useI18n();
  const router = useRouter();
  const [d, setD] = useState<Dash | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!can(user, 'records.read')) { router.replace(can(user, 'dashboard.national') ? '/national' : can(user, 'compliance.library') ? '/library' : can(user, 'integrations.manage') ? '/integrations' : '/studio'); return; }
    api<Dash>('/viewpoints/dashboard').then(setD);
  }, [user, router]);

  if (!d || !model) return <p className="hint">{t('common.loading')}</p>;
  const total = d.blocks.reduce((s, b) => s + b.total, 0);
  const approved = d.blocks.reduce((s, b) => s + b.approved, 0);
  const pending = d.blocks.reduce((s, b) => s + b.pending, 0);
  const filled = d.blocks.filter((b) => b.total);
  const avg = filled.length ? filled.reduce((s, b) => s + b.completeness, 0) / filled.length : 0;
  const block = (c: string) => model.blocks.find((b) => b.code === c);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <p>{t('dash.subtitle')}</p>
        </div>
      </div>

      <div className="figures">
        <div className="figure"><b>{total}</b><span>{t('dash.records')}</span></div>
        <div className="figure"><b>{total ? pct(approved / total) : pct(0)}</b><span>{t('dash.approved')}</span></div>
        <div className="figure"><b>{pending}</b><span>{t('dash.pending')}</span></div>
        <div className="figure"><b>{pct(avg)}</b><span>{t('dash.completeness')}</span></div>
      </div>

      <section className="section">
        <h2>{t('dash.alerts')}</h2>
        {d.alerts.length === 0 ? <p className="hint">{t('dash.noAlerts', { days: 180 })}</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>{t('dash.item')}</th><th>{t('common.block')}</th><th>{t('common.date')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>{d.alerts.map((a) => (
              <tr key={a.id + a.date}>
                <td><Link href={`/records/${a.id}`}>{a.name}</Link></td>
                <td>{nm(block(a.block))}</td>
                <td dir="ltr" style={{ textAlign: 'end' }}>{a.date}</td>
                <td className={`alert-${a.kind}`}>{t(a.kind === 'expired' ? 'dash.expired' : 'dash.expiring')}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="section">
        <h2>{t('dash.inventory')}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('common.block')}</th><th className="num">{t('dash.colRecords')}</th><th className="num">{t('status.approved')}</th><th className="num">{t('dash.pending')}</th><th className="num">{t('dash.orphans')}</th><th>{t('common.completeness')}</th></tr></thead>
          <tbody>{d.blocks.map((b) => (
            <tr key={b.code}>
              <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${b.domain})` }} /><Link href={`/repo/${b.code}`}>{nm(block(b.code))}</Link></td>
              <td className="num">{b.total}</td>
              <td className="num">{b.approved}</td>
              <td className="num">{b.pending || '—'}</td>
              <td className="num">{b.orphans || '—'}</td>
              <td>{b.total ? <>{pct(b.completeness)}<span className={`gauge${b.completeness < 0.5 ? ' low' : ''}`}><i style={{ width: `${b.completeness * 100}%` }} /></span></> : <span className="hint">{t('dash.noRecords')}</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
