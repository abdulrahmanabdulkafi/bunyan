'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, canInScope, fmtDate, Rec, Relation, STATUS } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AttrInput } from '@/lib/AttrInput';

interface LinkRow { id: string; relation_id: string; verb: string; relation_ar: string | null; direction: 'in' | 'out'; other_id: string; other_name: string; other_block: string; other_status: string }
interface Full extends Rec { links: LinkRow[]; history: { id: string; from_status: string; to_status: string; comment: string | null; actor_name: string; created_at: string }[]; updated_by: string }

const COST = /(cost|fees|budget)/i;

export default function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, model, refreshQueue } = useSession();
  const [rec, setRec] = useState<Full | null>(null);
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const linkDlg = useRef<HTMLDialogElement>(null);
  const rejectDlg = useRef<HTMLDialogElement>(null);
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    const r = await api<Full>(`/records/${id}`);
    setRec(r); setAttrs(r.attrs); setDirty(false); setFieldErrors({});
  }, [id]);
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: e.message })); }, [load]);

  if (!rec || !model) return msg ? <div className="banner error">{msg.text}</div> : <p className="hint">جارٍ التحميل…</p>;
  const block = model.blocks.find((b) => b.code === rec.block_code)!;
  const canWrite = canInScope(user, 'records.write', block) && rec.status !== 'archived';
  const showCost = user!.roles.some((r) => ['R2', 'R3', 'R4', 'R6', 'R7'].includes(r));
  const visible = block.attributes.filter((a) => a.active && (showCost || !COST.test(a.key)));
  const blockName = (c: string) => model.blocks.find((b) => b.code === c)?.name_ar ?? c;

  async function save() {
    setMsg(null); setFieldErrors({});
    try {
      await api(`/records/${id}`, { method: 'PATCH', json: { attrs, version: rec!.version } });
      await load();
      setMsg({ kind: 'ok', text: rec!.status === 'draft' ? 'حُفظت التغييرات.' : 'حُفظت التغييرات وأُعيد السجل إلى مسودة ليُعتمد من جديد.' });
    } catch (e) {
      if (e instanceof ApiError && e.errors.length) setFieldErrors(Object.fromEntries(e.errors.map((x) => [x.key, x.message])));
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  }

  async function act(action: string, c?: string) {
    setMsg(null);
    try {
      await api(`/records/${id}/${action}`, { method: 'POST', json: { comment: c } });
      await load(); refreshQueue();
      const done: Record<string, string> = { submit: 'أُرسل السجل للمراجعة.', review: 'اعتُمد السجل مبدئياً وأُحيل للاعتماد النهائي.', approve: 'اعتُمد السجل.', reject: 'رُفض السجل وأُعيد لمُدخله.', archive: 'أُرشف السجل.', restore: 'استُعيد السجل مسودةً.' };
      setMsg({ kind: 'ok', text: done[action] });
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  const actions: { key: string; label: string; show: boolean; primary?: boolean }[] = [
    { key: 'submit', label: 'إرسال للمراجعة', show: canWrite && ['draft', 'rejected'].includes(rec.status) && !dirty, primary: true },
    { key: 'review', label: 'اعتماد مبدئي', show: canInScope(user, 'records.review', block) && rec.status === 'submitted', primary: true },
    { key: 'approve', label: 'اعتماد نهائي', show: canInScope(user, 'records.approve', block) && rec.status === 'reviewed', primary: true },
    { key: 'reject', label: 'رفض', show: canInScope(user, 'records.review', block) && ['submitted', 'reviewed'].includes(rec.status) },
    { key: 'archive', label: 'أرشفة', show: canInScope(user, 'records.archive', block) && rec.status !== 'archived' },
    { key: 'restore', label: 'استعادة', show: canInScope(user, 'records.archive', block) && rec.status === 'archived' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href={`/repo/${block.code}`}>{block.name_ar}</Link></p>
          <h1>{rec.name || '(بلا اسم)'}</h1>
          <p className="row"><span className={`status st-${rec.status}`}>{STATUS[rec.status]}</span>
            <span className="hint">الإصدار {rec.version} · آخر تحديث {fmtDate(rec.updated_at)}{rec.source === 'excel' ? ' · مستورد من Excel' : ''}</span></p>
        </div>
        <div className="row">
          {actions.filter((a) => a.show).map((a) => (
            <button key={a.key} className={`btn${a.primary ? ' primary' : ''}${a.key === 'reject' || a.key === 'archive' ? ' danger' : ''}`}
              onClick={() => (a.key === 'reject' ? (setComment(''), rejectDlg.current?.showModal()) : act(a.key))}>{a.label}</button>
          ))}
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}

      <div className="record-layout">
        <section>
          <div className="form-grid">
            {visible.map((a) => (
              <label key={a.key} className={`field${a.type === 'multi_text' || a.key === 'description' ? ' wide' : ''}`} htmlFor={`f-${a.key}`} title={a.description ?? a.name_en}>
                <span>{a.name_ar}{a.required && <span className="req"> *</span>}</span>
                <AttrInput a={a} value={attrs[a.key]} disabled={!canWrite} onChange={(v) => { setAttrs({ ...attrs, [a.key]: v }); setDirty(true); }} />
                {fieldErrors[a.key] && <span className="field-error">{fieldErrors[a.key]}</span>}
              </label>
            ))}
          </div>
          {canWrite && (
            <div className="row" style={{ marginTop: 'var(--s-5)' }}>
              <button className="btn primary" disabled={!dirty} onClick={save}>حفظ التغييرات</button>
              {dirty && <button className="btn quiet" onClick={() => { setAttrs(rec.attrs); setDirty(false); }}>تراجع</button>}
            </div>
          )}
        </section>

        <aside className="side">
          <div className="side-block">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>العلاقات</h3>
              {canWrite && <button className="btn quiet" onClick={() => linkDlg.current?.showModal()}>ربط بسجل</button>}
            </div>
            {rec.links.length === 0 ? <p className="hint">لا ترتبط هذه الوحدة بأي سجل بعد.</p> : (
              <ul className="links">{rec.links.map((l) => (
                <li key={l.id}>
                  <span><span className="verb">{l.direction === 'out' ? `${l.relation_ar ?? l.verb} ${blockName(l.other_block)}` : `${blockName(l.other_block)} ${l.relation_ar ?? l.verb} هذا السجل`}</span>
                    <Link href={`/records/${l.other_id}`}>{l.other_name}</Link></span>
                  {canWrite && <button className="btn quiet" aria-label={`إزالة الربط مع ${l.other_name}`}
                    onClick={async () => { await api(`/records/${id}/links/${l.id}`, { method: 'DELETE' }); load(); }}>إزالة</button>}
                </li>))}
              </ul>
            )}
          </div>
          <div className="side-block">
            <h3>مسار الاعتماد</h3>
            {rec.history.length === 0 ? <p className="hint">لم يُرسل للمراجعة بعد.</p> : (
              <ol className="timeline">{rec.history.map((h) => (
                <li key={h.id}><time>{fmtDate(h.created_at)}</time>{h.actor_name}: {STATUS[h.from_status]} ← {STATUS[h.to_status]}{h.comment && <div className="hint">«{h.comment}»</div>}</li>))}
              </ol>
            )}
          </div>
        </aside>
      </div>

      <LinkDialog ref={linkDlg} blockCode={block.code} relations={model.relations.filter((r) => model.blocks.find((b) => b.code === r.target_code)?.active)} blockName={blockName} recordId={id} onDone={load} />

      <dialog ref={rejectDlg} aria-labelledby="rej">
        <h2 id="rej">سبب الرفض</h2>
        <p className="hint" style={{ margin: 'var(--s-2) 0 var(--s-3)' }}>يظهر السبب لمُدخل السجل ليعالجه قبل إعادة الإرسال.</p>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} aria-label="سبب الرفض" />
        <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={() => rejectDlg.current?.close()}>إلغاء</button>
          <button className="btn danger" disabled={!comment.trim()} onClick={() => { rejectDlg.current?.close(); act('reject', comment); }}>رفض السجل</button>
        </div>
      </dialog>
    </>
  );
}

function LinkDialog({ ref, blockCode, relations, blockName, recordId, onDone }:
  { ref: React.RefObject<HTMLDialogElement | null>; blockCode: string; relations: Relation[]; blockName: (c: string) => string; recordId: string; onDone: () => void }) {
  const options = relations.filter((r) => r.active && r.source_code === blockCode);
  const [rel, setRel] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Rec[]>([]);
  const [err, setErr] = useState('');
  const relation = options.find((r) => r.id === rel);

  useEffect(() => {
    if (!relation) { setResults([]); return; }
    const t = setTimeout(() => api<{ items: Rec[] }>(`/records?block=${relation.target_code}&size=20${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => setResults(r.items)).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [relation, q]);

  return (
    <dialog ref={ref} aria-labelledby="lnk">
      <h2 id="lnk" style={{ marginBottom: 'var(--s-4)' }}>ربط بسجل آخر</h2>
      {err && <div className="banner error">{err}</div>}
      <label className="field">نوع العلاقة (وفق النموذج العام)
        <select value={rel} onChange={(e) => setRel(e.target.value)}>
          <option value="">اختر العلاقة</option>
          {options.map((r) => <option key={r.id} value={r.id}>{r.name_ar ?? r.verb} ← {blockName(r.target_code)}</option>)}
        </select>
      </label>
      {relation && (
        <>
          <label className="field" style={{ marginTop: 'var(--s-3)' }}>ابحث في {blockName(relation.target_code)}
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="links" style={{ marginTop: 'var(--s-2)', maxHeight: 240, overflowY: 'auto' }}>
            {results.map((r) => (
              <li key={r.id}><span>{r.name}</span>
                <button className="btn" onClick={async () => {
                  try { await api(`/records/${recordId}/links`, { method: 'POST', json: { relation_id: rel, target_id: r.id } }); ref.current?.close(); onDone(); }
                  catch (e) { setErr((e as Error).message); }
                }}>ربط</button></li>
            ))}
            {results.length === 0 && <li className="hint">لا توجد سجلات مطابقة.</li>}
          </ul>
        </>
      )}
      <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={() => ref.current?.close()}>إغلاق</button>
      </div>
    </dialog>
  );
}
