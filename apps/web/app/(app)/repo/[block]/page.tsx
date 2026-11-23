'use client';
import Link from 'next/link';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, canInScope, download, Rec } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AttrInput, display } from '@/lib/AttrInput';
import { useI18n } from '@/lib/i18n';

interface Page { total: number; page: number; size: number; items: Rec[] }
const STATUSES = ['draft', 'submitted', 'reviewed', 'approved', 'rejected', 'archived'];

export default function Repository({ params }: { params: Promise<{ block: string }> }) {
  const { block: code } = use(params);
  const { user, model } = useSession();
  const { t, nm, pct } = useI18n();
  const router = useRouter();
  const block = model?.blocks.find((b) => b.code === code);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Title attribute first, then up to five more columns.
  const columns = useMemo(() => {
    if (!block) return [];
    return block.attributes.filter((a) => a.active && a.key !== block.title_key && a.key !== 'description').slice(0, 5);
  }, [block]);

  useEffect(() => {
    if (!block) return;
    const p = new URLSearchParams({ block: code, page: String(page), size: '50' });
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    const timer = setTimeout(() => api<Page>(`/records?${p}`).then(setData).catch((e) => setError(e.message)), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [block, code, q, status, page]);

  if (!model) return <p className="hint">{t('common.loading')}</p>;
  if (!block) return <p>{t('repo.notFound')}</p>;
  const canWrite = canInScope(user, 'records.write', block);

  async function create() {
    setFieldErrors({});
    try {
      const r = await api<Rec>('/records', { method: 'POST', json: { block: code, attrs: draft } });
      dlg.current?.close();
      router.push(`/records/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.errors.length) setFieldErrors(Object.fromEntries(e.errors.map((x) => [x.key, x.message])));
      else setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{nm(block)}</h1>
          <p>{data ? t('repo.count', { n: data.total }) : ' '}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => download(`/io/export?blocks=${code}&withData=true`, `${code}.xlsx`)}>{t('repo.downloadExcel')}</button>
          {canWrite && <button className="btn primary" onClick={() => { setDraft({}); setFieldErrors({}); dlg.current?.showModal(); }}>{t('repo.add')}</button>}
        </div>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
        <input type="search" placeholder={t('repo.search')} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} aria-label={t('repo.searchLabel')} />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ maxWidth: 220 }} aria-label={t('common.status')}>
          <option value="">{t('repo.allStatuses')}</option>
          {STATUSES.map((k) => <option key={k} value={k}>{t(`status.${k}`)}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{nm(block.attributes.find((a) => a.key === block.title_key)) || t('common.name')}</th>
            {columns.map((c) => <th key={c.key}>{nm(c)}</th>)}
            <th>{t('common.status')}</th><th>{t('common.completeness')}</th>
          </tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/records/${r.id}`}>{r.name || t('common.unnamed')}</Link></td>
                {columns.map((c) => <td key={c.key}>{display(c, r.attrs[c.key], nm)}</td>)}
                <td><span className={`status st-${r.status}`}>{t(`status.${r.status}`)}</span></td>
                <td>{pct(r.completeness)}<span className={`gauge${r.completeness < 0.5 ? ' low' : ''}`}><i style={{ width: `${r.completeness * 100}%` }} /></span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && (
          <div className="empty">{q || status ? t('repo.noMatch') : canWrite ? t('repo.emptyWrite') : t('repo.empty')}</div>
        )}
      </div>
      {data && data.total > data.size && (
        <div className="row" style={{ marginTop: 'var(--s-3)' }}>
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('common.prev')}</button>
          <span className="hint">{t('common.pageOf', { p: page, n: Math.ceil(data.total / data.size) })}</span>
          <button className="btn" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>{t('common.next')}</button>
        </div>
      )}

      <dialog ref={dlg} aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 'var(--s-4)' }}>{t('repo.newTitle', { block: nm(block) })}</h2>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {block.attributes.filter((a) => a.active && (a.required || a.key === 'description' || a.key === 'code')).map((a) => (
            <label key={a.key} className={`field${a.key === 'description' ? ' wide' : ''}`} htmlFor={`f-${a.key}`}>
              <span>{nm(a)}{a.required && <span className="req"> *</span>}</span>
              <AttrInput a={a} value={draft[a.key]} onChange={(v) => setDraft({ ...draft, [a.key]: v })} />
              {fieldErrors[a.key] && <span className="field-error">{fieldErrors[a.key]}</span>}
            </label>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 'var(--s-3)' }}>{t('repo.draftHint')}</p>
        <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={() => dlg.current?.close()}>{t('common.cancel')}</button>
          <button className="btn primary" onClick={create}>{t('repo.createDraft')}</button>
        </div>
      </dialog>
    </>
  );
}
