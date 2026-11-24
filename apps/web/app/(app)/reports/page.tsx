'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, can, download } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

const CODES = ['inventory', 'quality', 'lifecycle', 'relations', 'cost', 'workflow'] as const;
type Code = (typeof CODES)[number];
/* eslint-disable @typescript-eslint/no-explicit-any */
type Data = any;

export default function Reports() {
  const { user, model } = useSession();
  const { t, nm, pct, num } = useI18n();
  const codes = CODES.filter((c) => c !== 'cost' || can(user, 'cost.read'));
  const [code, setCode] = useState<Code>('inventory');
  const [loaded, setLoaded] = useState<{ code: Code; data: Data } | null>(null);
  // Only render data that belongs to the selected tab (the previous tab's data is still in state for one render).
  const data = loaded?.code === code ? loaded.data : null;
  const [err, setErr] = useState('');
  const [issueFilter, setIssueFilter] = useState('');

  useEffect(() => {
    setErr('');
    let live = true;
    api<Data>(`/reports/${code}`).then((d) => live && setLoaded({ code, data: d })).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [code]);

  if (!model) return null;
  const bn = (c: string) => nm(model.blocks.find((b) => b.code === c)) || c;
  const an = (b: string, k: string) => nm(model.blocks.find((x) => x.code === b)?.attributes.find((a) => a.key === k)) || k;
  const rec = (id: string, name: string) => <Link href={`/records/${id}`}>{name || t('common.unnamed')}</Link>;
  const bar = (x: number) => <>{pct(x)}<span className={`gauge${x < 0.5 ? ' low' : ''}`}><i style={{ width: `${x * 100}%` }} /></span></>;
  const money = (n: number) => num(Math.round(n));

  return (
    <>
      <div className="page-head">
        <div><h1>{t('rep.title')}</h1><p>{t('rep.subtitle')}</p></div>
        {can(user, 'reports.export') && (
          <div className="row">
            <button className="btn" onClick={() => download(`/reports/${code}/xlsx?lang=ar`, `bunyan-${code}-ar.xlsx`)}>{t('rep.excelAr')}</button>
            <button className="btn" onClick={() => download(`/reports/${code}/xlsx?lang=en`, `bunyan-${code}-en.xlsx`)}>{t('rep.excelEn')}</button>
          </div>
        )}
      </div>

      <div className="tabs" role="tablist">
        {codes.map((c) => <button key={c} role="tab" aria-selected={c === code} onClick={() => setCode(c)}>{t(`rep.${c}`)}</button>)}
      </div>
      <p className="hint" style={{ marginBottom: 'var(--s-4)' }}>{t(`rep.${code}.hint`)}</p>
      {err && <div className="banner error">{err}</div>}
      {!data && !err && <p className="hint">{t('common.loading')}</p>}

      {data && code === 'inventory' && (
        <>
          <div className="figures">
            <div className="figure"><b>{num(data.total)}</b><span>{t('dash.records')}</span></div>
            <div className="figure"><b>{data.total ? pct(data.approved / data.total) : pct(0)}</b><span>{t('dash.approved')}</span></div>
            <div className="figure"><b>{data.blocks_used} / {data.blocks_active}</b><span>{t('rep.blocksUsed')}</span></div>
          </div>
          <div className="table-wrap section"><table>
            <thead><tr><th>{t('studio.domain')}</th><th>{t('common.block')}</th><th className="num">{t('dash.records')}</th>
              {['draft', 'submitted', 'approved', 'rejected'].map((s) => <th key={s} className="num">{t(`status.${s}`)}</th>)}
              <th>{t('common.completeness')}</th></tr></thead>
            <tbody>{data.rows.map((r: Data) => (
              <tr key={r.block} className={r.total ? '' : 'muted'}>
                <td>{nm({ name_ar: r.domain_ar, name_en: r.domain_en })}</td>
                <td><Link href={`/repo/${r.block}`}>{nm(r)}</Link></td>
                <td className="num">{r.total}</td>
                {['draft', 'submitted', 'approved', 'rejected'].map((s) => <td key={s} className="num">{r.by_status[s] ?? 0}</td>)}
                <td>{r.total ? bar(r.completeness) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}

      {data && code === 'quality' && (
        <>
          <div className="figures">
            <div className="figure"><b>{pct(data.score)}</b><span>{t('rep.score')}</span></div>
            <div className="figure"><b>{num(data.issues_total)}</b><span>{t('rep.issues')}</span></div>
            <div className="figure"><b>{num(data.total)}</b><span>{t('dash.records')}</span></div>
          </div>
          <p className="hint">{t('rep.scoreHint')}</p>
          <div className="table-wrap section"><table>
            <thead><tr><th>{t('common.block')}</th><th className="num">{t('dash.records')}</th><th>{t('common.completeness')}</th>
              {['missing_required', 'low_completeness', 'no_relations', 'stale', 'duplicate_name'].map((k) => <th key={k} className="num">{t(`rep.issue.${k}`, { days: data.stale_days })}</th>)}</tr></thead>
            <tbody>{data.blocks.map((b: Data) => (
              <tr key={b.block}>
                <td><Link href={`/repo/${b.block}`}>{nm(b)}</Link></td><td className="num">{b.total}</td><td>{bar(b.completeness)}</td>
                {[b.missing_required, b.low_completeness, b.no_relations, b.stale, b.duplicate_names].map((n: number, i: number) => <td key={i} className={`num${n ? ' warn-n' : ''}`}>{n}</td>)}
              </tr>
            ))}</tbody>
          </table></div>
          <section className="section">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2>{t('rep.issueList')}</h2>
              <select value={issueFilter} onChange={(e) => setIssueFilter(e.target.value)} style={{ maxWidth: 260 }} aria-label={t('rep.issueType')}>
                <option value="">{t('rep.allIssues')}</option>
                {['missing_required', 'low_completeness', 'no_relations', 'stale', 'duplicate_name'].map((k) => <option key={k} value={k}>{t(`rep.issue.${k}`, { days: data.stale_days })}</option>)}
              </select>
            </div>
            <div className="table-wrap"><table>
              <thead><tr><th>{t('common.block')}</th><th>{t('rep.record')}</th><th>{t('rep.issueType')}</th><th>{t('rep.detail')}</th></tr></thead>
              <tbody>{data.issues.filter((i: Data) => !issueFilter || i.issue === issueFilter).slice(0, 300).map((i: Data, k: number) => (
                <tr key={k}><td>{bn(i.block)}</td><td>{rec(i.record_id, i.name)}</td><td>{t(`rep.issue.${i.issue}`, { days: data.stale_days })}</td>
                  <td className="hint">{i.issue === 'missing_required' ? i.detail.split(',').map((x: string) => an(i.block, x)).join(t('list.sep')) : i.issue === 'low_completeness' ? `${i.detail}%` : i.detail ?? ''}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="hint">{t('rep.capped')}</p>
          </section>
        </>
      )}

      {data && code === 'lifecycle' && (
        <>
          <div className="figures">
            {['expired', 'd90', 'd180', 'd365'].map((k) => <div key={k} className={`figure${k === 'expired' && data.counts[k] ? ' bad' : ''}`}><b>{data.counts[k]}</b><span>{t(`rep.bucket.${k}`)}</span></div>)}
          </div>
          {data.tracked.some((x: Data) => x.with_date < x.total) && (
            <p className="hint" style={{ marginTop: 'var(--s-3)' }}>{t('rep.missingDates')} {data.tracked.filter((x: Data) => x.with_date < x.total).map((x: Data) => `${nm(x)} (${x.total - x.with_date})`).join(t('list.sep'))}</p>
          )}
          <div className="table-wrap section"><table>
            <thead><tr><th>{t('rep.record')}</th><th>{t('common.block')}</th><th>{t('rep.dateAttr')}</th><th>{t('common.date')}</th><th className="num">{t('rep.daysLeft')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>{data.items.filter((i: Data) => i.bucket !== 'later').map((i: Data) => (
              <tr key={i.record_id + i.key}><td>{rec(i.record_id, i.name)}</td><td>{bn(i.block)}</td><td>{an(i.block, i.key)}</td>
                <td dir="ltr" style={{ textAlign: 'end' }}>{i.date}</td><td className={`num${i.days < 0 ? ' bad-n' : i.days <= 90 ? ' warn-n' : ''}`}>{i.days}</td>
                <td><span className={`status st-${i.status}`}>{t(`status.${i.status}`)}</span></td></tr>
            ))}</tbody>
          </table>
          {!data.items.some((i: Data) => i.bucket !== 'later') && <div className="empty">{t('rep.noLifecycle')}</div>}</div>
        </>
      )}

      {data && code === 'relations' && (
        <>
          <div className="figures">
            <div className="figure"><b>{num(data.links)}</b><span>{t('rep.links')}</span></div>
            <div className="figure"><b>{num(data.orphans.length)}</b><span>{t('rep.orphans')}</span></div>
          </div>
          <div className="grid-2 section" style={{ gap: 'var(--s-5)', alignItems: 'start' }}>
            <div className="table-wrap"><table>
              <thead><tr><th>{t('common.block')}</th><th className="num">{t('dash.records')}</th><th>{t('rep.coverage')}</th></tr></thead>
              <tbody>{data.blocks.map((b: Data) => <tr key={b.block}><td>{nm(b)}</td><td className="num">{b.total}</td><td>{bar(b.total ? b.linked / b.total : 0)}</td></tr>)}</tbody>
            </table></div>
            <div className="table-wrap"><table>
              <thead><tr><th>{t('rep.relation')}</th><th className="num">{t('rep.links')}</th><th>{t('rep.sourceCoverage')}</th></tr></thead>
              <tbody>{data.relations.filter((r: Data) => r.links).map((r: Data) => (
                <tr key={r.id}><td>{bn(r.source)} <span className="hint">{nm({ name_ar: r.name_ar ?? r.verb, name_en: r.verb })}</span> {bn(r.target)}</td><td className="num">{r.links}</td><td>{bar(r.source_coverage)}</td></tr>
              ))}</tbody>
            </table></div>
          </div>
          <section className="section"><h2>{t('rep.orphans')}</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>{t('rep.record')}</th><th>{t('common.block')}</th><th>{t('common.status')}</th></tr></thead>
              <tbody>{data.orphans.slice(0, 300).map((o: Data) => <tr key={o.record_id}><td>{rec(o.record_id, o.name)}</td><td>{bn(o.block)}</td><td><span className={`status st-${o.status}`}>{t(`status.${o.status}`)}</span></td></tr>)}</tbody>
            </table></div>
          </section>
        </>
      )}

      {data && code === 'cost' && (
        <>
          <div className="figures">
            <div className="figure"><b>{money(data.capital)}</b><span>{t('rep.capital')}</span></div>
            <div className="figure"><b>{money(data.operating)}</b><span>{t('rep.operating')}</span></div>
            <div className="figure"><b>{money(data.capital + data.operating)}</b><span>{t('rep.totalCost')}</span></div>
          </div>
          <div className="table-wrap section"><table>
            <thead><tr><th>{t('common.block')}</th><th className="num">{t('dash.records')}</th><th className="num">{t('rep.capital')}</th><th className="num">{t('rep.operating')}</th><th className="num">{t('rep.noCost')}</th></tr></thead>
            <tbody>{data.blocks.map((b: Data) => <tr key={b.block}><td>{nm(b)}</td><td className="num">{b.total}</td><td className="num">{money(b.capital)}</td><td className="num">{money(b.operating)}</td><td className={`num${b.missing ? ' warn-n' : ''}`}>{b.missing}</td></tr>)}</tbody>
          </table></div>
        </>
      )}

      {data && code === 'workflow' && (
        <>
          <div className="figures">
            {['draft', 'submitted', 'reviewed', 'rejected'].map((s) => <div key={s} className="figure"><b>{data.counts[s]}</b><span>{t(`status.${s}`)}</span></div>)}
            <div className="figure"><b>{data.oldest_waiting_days}</b><span>{t('rep.oldest')}</span></div>
          </div>
          <div className="table-wrap section"><table>
            <thead><tr><th>{t('rep.record')}</th><th>{t('common.block')}</th><th>{t('common.status')}</th><th className="num">{t('rep.age')}</th></tr></thead>
            <tbody>{data.items.slice(0, 300).map((i: Data) => <tr key={i.record_id}><td>{rec(i.record_id, i.name)}</td><td>{bn(i.block)}</td><td><span className={`status st-${i.status}`}>{t(`status.${i.status}`)}</span></td><td className={`num${i.days > 14 ? ' warn-n' : ''}`}>{i.days}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
    </>
  );
}
