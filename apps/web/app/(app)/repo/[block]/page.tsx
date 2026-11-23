'use client';
import Link from 'next/link';
import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, canInScope, download, Rec, STATUS } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AttrInput, display } from '@/lib/AttrInput';

interface Page { total: number; page: number; size: number; items: Rec[] }

export default function Repository({ params }: { params: Promise<{ block: string }> }) {
  const { block: code } = use(params);
  const { user, model } = useSession();
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

  // Show the title attribute first, then up to five more filled-in columns.
  const columns = useMemo(() => {
    if (!block) return [];
    const act = block.attributes.filter((a) => a.active && a.key !== block.title_key && a.key !== 'description');
    return act.slice(0, 5);
  }, [block]);

  useEffect(() => {
    if (!block) return;
    const p = new URLSearchParams({ block: code, page: String(page), size: '50' });
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    const t = setTimeout(() => api<Page>(`/records?${p}`).then(setData).catch((e) => setError(e.message)), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [block, code, q, status, page]);

  if (!model) return <p className="hint">جارٍ التحميل…</p>;
  if (!block) return <p>وحدة البناء غير موجودة.</p>;
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
          <h1>{block.name_ar}</h1>
          <p>{data ? `${data.total} سجل` : ' '}</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => download(`/io/export?blocks=${code}&withData=true`, `${code}.xlsx`)}>تنزيل Excel</button>
          {canWrite && <button className="btn primary" onClick={() => { setDraft({}); setFieldErrors({}); dlg.current?.showModal(); }}>إضافة سجل</button>}
        </div>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}

      <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
        <input type="search" placeholder="ابحث بالاسم أو أي قيمة" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ maxWidth: 320 }} aria-label="بحث" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ maxWidth: 200 }} aria-label="الحالة">
          <option value="">كل الحالات (عدا المؤرشف)</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>{block.attributes.find((a) => a.key === block.title_key)?.name_ar ?? 'الاسم'}</th>
            {columns.map((c) => <th key={c.key}>{c.name_ar}</th>)}
            <th>الحالة</th><th>الاكتمال</th>
          </tr></thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/records/${r.id}`}>{r.name || '(بلا اسم)'}</Link></td>
                {columns.map((c) => <td key={c.key}>{display(c, r.attrs[c.key])}</td>)}
                <td><span className={`status st-${r.status}`}>{STATUS[r.status]}</span></td>
                <td>{Math.round(r.completeness * 100)}٪<span className={`gauge${r.completeness < 0.5 ? ' low' : ''}`}><i style={{ width: `${r.completeness * 100}%` }} /></span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.items.length === 0 && (
          <div className="empty">
            {q || status ? 'لا توجد سجلات تطابق البحث.' : canWrite ? 'لا توجد سجلات بعد. أضف أول سجل أو استورد قالب Excel.' : 'لا توجد سجلات بعد.'}
          </div>
        )}
      </div>
      {data && data.total > data.size && (
        <div className="row" style={{ marginTop: 'var(--s-3)' }}>
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</button>
          <span className="hint">صفحة {page} من {Math.ceil(data.total / data.size)}</span>
          <button className="btn" disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>التالي</button>
        </div>
      )}

      <dialog ref={dlg} aria-labelledby="new-title">
        <h2 id="new-title" style={{ marginBottom: 'var(--s-4)' }}>سجل جديد — {block.name_ar}</h2>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {block.attributes.filter((a) => a.active && (a.required || a.key === 'description' || a.key === 'code')).map((a) => (
            <label key={a.key} className={`field${a.key === 'description' ? ' wide' : ''}`} htmlFor={`f-${a.key}`}>
              <span>{a.name_ar}{a.required && <span className="req"> *</span>}</span>
              <AttrInput a={a} value={draft[a.key]} onChange={(v) => setDraft({ ...draft, [a.key]: v })} />
              {fieldErrors[a.key] && <span className="field-error">{fieldErrors[a.key]}</span>}
            </label>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 'var(--s-3)' }}>يُحفظ السجل مسودةً؛ تكمل بقية السمات من صفحته ثم ترسله للاعتماد.</p>
        <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={() => dlg.current?.close()}>إلغاء</button>
          <button className="btn primary" onClick={create}>إنشاء المسودة</button>
        </div>
      </dialog>
    </>
  );
}
