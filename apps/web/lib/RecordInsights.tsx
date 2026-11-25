'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, Model } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface ImpactNode { id: string; name: string; block_code: string; status: string; depth: number; via: string | null; verb: string | null; relation_ar: string | null }
interface Impact { root: { id: string; name: string }; depth: number; truncated: boolean; total: number; byBlock: Record<string, number>; nodes: ImpactNode[] }

/** Impact analysis: what is affected, directly and indirectly, if this record changes or is retired. */
export function ImpactPanel({ id, model }: { id: string; model: Model }) {
  const { t, nm, locale } = useI18n();
  const [depth, setDepth] = useState(2);
  const [data, setData] = useState<Impact | null>(null);
  const [err, setErr] = useState('');
  const [only, setOnly] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setErr('');
    api<Impact>(`/records/${id}/impact?depth=${depth}`).then(setData).catch((e) => setErr(e.message));
  }, [id, depth]);

  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c)) || c;
  const domainOf = (c: string) => model.blocks.find((b) => b.code === c)?.domain_code ?? '';
  const names = new Map<string, string>(data ? [[data.root.id, data.root.name], ...data.nodes.map((n) => [n.id, n.name] as [string, string])] : []);
  const rows = data?.nodes.filter((n) => !only || n.block_code === only) ?? [];

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
        <p className="hint" style={{ maxWidth: 560 }}>{t('impact.hint')}</p>
        <label className="row hint">{t('impact.depth')}
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} style={{ width: 'auto' }}>
            {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{t(`impact.depth${d}`)}</option>)}
          </select>
        </label>
      </div>
      {err && <div className="banner error">{err}</div>}
      {!data && !err && <p className="hint">{t('common.loading')}</p>}
      {data && (
        <>
          <div className="figures" style={{ marginBottom: 'var(--s-4)' }}>
            <div className="figure"><b>{data.total}</b><span>{t('impact.affected')}</span></div>
            <div className="figure"><b>{data.nodes.filter((n) => n.depth === 1).length}</b><span>{t('impact.direct')}</span></div>
            <div className="figure"><b>{data.nodes.filter((n) => n.depth > 1).length}</b><span>{t('impact.indirect')}</span></div>
          </div>
          {data.total === 0 ? <p className="empty">{t('impact.none')}</p> : (
            <>
              <div className="chips" style={{ marginBottom: 'var(--s-3)' }}>
                <button className="chip" aria-pressed={!only} onClick={() => setOnly(null)}>{t('impact.all')} · {data.total}</button>
                {Object.entries(data.byBlock).sort((a, b) => b[1] - a[1]).map(([b, n]) => (
                  <button key={b} className="chip" aria-pressed={only === b} onClick={() => setOnly(only === b ? null : b)}
                    style={{ ['--c' as string]: `var(--d-${domainOf(b)})` }}>{blockName(b)} · {n}</button>
                ))}
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('impact.record')}</th><th>{t('impact.block')}</th><th>{t('impact.distance')}</th><th>{t('impact.through')}</th></tr></thead>
                  <tbody>{rows.map((n) => (
                    <tr key={n.id}>
                      <td><Link href={`/records/${n.id}`}>{n.name || t('common.unnamed')}</Link></td>
                      <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${domainOf(n.block_code)})` }} /> {blockName(n.block_code)}</td>
                      <td>{n.depth === 1 ? t('impact.directOne') : t('impact.hops', { n: n.depth })}</td>
                      <td className="hint">{(locale === 'ar' ? n.relation_ar ?? n.verb : n.verb)}{n.depth > 1 && n.via ? ` — ${names.get(n.via) ?? ''}` : ''}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
              {data.truncated && <p className="hint">{t('impact.truncated')}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

interface Change {
  id: string; action: string; at: string; user_name: string | null;
  fields?: { key: string; before: unknown; after: unknown }[];
  other?: { id: string; name: string | null; block_code: string | null };
  status?: string | null; comment?: string | null;
}

/** Field-level change history from the audit log. */
export function ChangesPanel({ id, model, blockCode }: { id: string; model: Model; blockCode: string }) {
  const { t, nm, date } = useI18n();
  const [list, setList] = useState<Change[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Change[]>(`/records/${id}/changes`).then(setList).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <div className="banner error">{err}</div>;
  if (!list) return <p className="hint">{t('common.loading')}</p>;
  if (!list.length) return <p className="empty">{t('changes.none')}</p>;
  const block = model.blocks.find((b) => b.code === blockCode);
  const attrName = (k: string) => nm(block?.attributes.find((a) => a.key === k)) || k;
  const show = (v: unknown) => (v === null || v === undefined ? '—' : Array.isArray(v) ? v.join('، ') : String(v));

  return (
    <ol className="timeline changes">
      {list.map((c) => (
        <li key={c.id}>
          <time>{date(c.at)}</time>
          <strong>{c.user_name ?? t('changes.system')}</strong> — {t(`changes.${c.action}`, { name: c.other?.name ?? '' })}
          {c.status && <> <span className={`status st-${c.status}`}>{t(`status.${c.status}`)}</span></>}
          {c.comment && <div className="hint">«{c.comment}»</div>}
          {c.other?.id && c.other.name && <div><Link href={`/records/${c.other.id}`}>{c.other.name}</Link></div>}
          {c.fields && c.fields.length > 0 && (
            <table className="diff">
              <tbody>{c.fields.map((f) => (
                <tr key={f.key}><th>{attrName(f.key)}</th>
                  {c.action === 'create' ? <td colSpan={2}>{show(f.after)}</td> : <><td><del>{show(f.before)}</del></td><td><ins>{show(f.after)}</ins></td></>}
                </tr>))}
              </tbody>
            </table>
          )}
        </li>
      ))}
    </ol>
  );
}
