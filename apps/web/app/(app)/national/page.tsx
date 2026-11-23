'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Entity { id: string; tenant: string; total: number; approved: number; approvedRatio: number; domains: Record<string, number> }
interface Nat { scope: 'national' | 'sector' | 'entity'; average: number; entities: Entity[] | number; mine?: Entity | null }

const DOMS = ['applications', 'technology', 'security'];

export default function National() {
  const { t, pct } = useI18n();
  const [d, setD] = useState<Nat | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Nat>('/viewpoints/national').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <p className="hint">{t('common.loading')}</p>;

  if (d.scope === 'entity') {
    return (
      <>
        <div className="page-head"><div><h1>{t('nat.entityTitle')}</h1><p>{t('nat.entitySubtitle', { n: d.entities as number })}</p></div></div>
        <div className="figures">
          <div className="figure"><b>{pct(d.mine?.approvedRatio ?? 0)}</b><span>{t('nat.yourRatio')}</span></div>
          <div className="figure"><b>{pct(d.average)}</b><span>{t('nat.nationalAverage')}</span></div>
        </div>
      </>
    );
  }
  const list = (d.entities as Entity[]).slice().sort((a, b) => b.approvedRatio - a.approvedRatio);
  return (
    <>
      <div className="page-head"><div>
        <h1>{t(d.scope === 'national' ? 'nat.title' : 'nat.sectorTitle')}</h1>
        <p>{t('nat.subtitle')}</p>
      </div></div>
      <div className="figures">
        <div className="figure"><b>{list.length}</b><span>{t('nat.entities')}</span></div>
        <div className="figure"><b>{pct(d.average)}</b><span>{t('nat.averageRatio')}</span></div>
      </div>
      <div className="section table-wrap"><table>
        <thead><tr><th>{t('nat.entity')}</th>{DOMS.map((k) => <th key={k} className="num">{t(`domain.${k}`)}</th>)}<th className="num">{t('nat.total')}</th><th>{t('nat.ratio')}</th></tr></thead>
        <tbody>{list.map((e) => (
          <tr key={e.id}><td>{e.tenant}</td>
            {DOMS.map((k) => <td key={k} className="num">{e.domains[k] ?? 0}</td>)}
            <td className="num">{e.total}</td>
            <td>{pct(e.approvedRatio)}<span className={`gauge${e.approvedRatio < 0.5 ? ' low' : ''}`}><i style={{ width: `${e.approvedRatio * 100}%` }} /></span></td>
          </tr>))}
        </tbody>
      </table></div>
    </>
  );
}
