'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, can, canInScope, Rec, Relation } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AttrInput } from '@/lib/AttrInput';
import { useI18n } from '@/lib/i18n';

interface LinkRow { id: string; relation_id: string; verb: string; relation_ar: string | null; direction: 'in' | 'out'; other_id: string; other_name: string; other_block: string; other_status: string }
interface Full extends Rec { links: LinkRow[]; history: { id: string; from_status: string; to_status: string; comment: string | null; actor_name: string; created_at: string }[]; updated_by: string }

const COST = /(cost|fees|budget)/i;
const SOURCE: Record<string, string> = { excel: 'record.fromExcel', integration: 'record.fromIntegration' };

export default function RecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, model, refreshQueue } = useSession();
  const { t, nm, date, locale } = useI18n();
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

  if (!rec || !model) return msg ? <div className="banner error">{msg.text}</div> : <p className="hint">{t('common.loading')}</p>;
  const block = model.blocks.find((b) => b.code === rec.block_code)!;
  const canWrite = canInScope(user, 'records.write', block) && rec.status !== 'archived';
  const visible = block.attributes.filter((a) => a.active && (can(user, 'cost.read') || !COST.test(a.key)));
  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c));
  const verbOf = (l: LinkRow) => (locale === 'ar' ? l.relation_ar ?? l.verb : l.verb.toLowerCase());
  const arrow = locale === 'ar' ? '←' : '→';

  async function save() {
    setMsg(null); setFieldErrors({});
    try {
      await api(`/records/${id}`, { method: 'PATCH', json: { attrs, version: rec!.version } });
      const wasDraft = rec!.status === 'draft';
      await load();
      setMsg({ kind: 'ok', text: t(wasDraft ? 'record.saved' : 'record.savedBackToDraft') });
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
      setMsg({ kind: 'ok', text: t(`record.done.${action}`) });
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  const actions: { key: string; show: boolean; primary?: boolean }[] = [
    { key: 'submit', show: canWrite && ['draft', 'rejected'].includes(rec.status) && !dirty, primary: true },
    { key: 'review', show: canInScope(user, 'records.review', block) && rec.status === 'submitted', primary: true },
    { key: 'approve', show: canInScope(user, 'records.approve', block) && rec.status === 'reviewed', primary: true },
    { key: 'reject', show: canInScope(user, 'records.review', block) && ['submitted', 'reviewed'].includes(rec.status) },
    { key: 'archive', show: canInScope(user, 'records.archive', block) && rec.status !== 'archived' },
    { key: 'restore', show: canInScope(user, 'records.archive', block) && rec.status === 'archived' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href={`/repo/${block.code}`}>{nm(block)}</Link></p>
          <h1>{rec.name || t('common.unnamed')}</h1>
          <p className="row"><span className={`status st-${rec.status}`}>{t(`status.${rec.status}`)}</span>
            <span className="hint">{t('record.meta', { v: rec.version, d: date(rec.updated_at) })}{SOURCE[rec.source] ? ` — ${t(SOURCE[rec.source])}` : ''}</span></p>
        </div>
        <div className="row">
          {actions.filter((a) => a.show).map((a) => (
            <button key={a.key} className={`btn${a.primary ? ' primary' : ''}${a.key === 'reject' || a.key === 'archive' ? ' danger' : ''}`}
              onClick={() => (a.key === 'reject' ? (setComment(''), rejectDlg.current?.showModal()) : act(a.key))}>{t(`record.action.${a.key}`)}</button>
          ))}
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}

      <div className="record-layout">
        <section>
          <div className="form-grid">
            {visible.map((a) => (
              <label key={a.key} className={`field${a.multiple || a.type === 'multi_text' || a.key === 'description' ? ' wide' : ''}`} htmlFor={`f-${a.key}`} title={a.description ?? (locale === 'ar' ? a.name_en : a.name_ar)}>
                <span>{nm(a)}{a.required && <span className="req"> *</span>}</span>
                <AttrInput a={a} value={attrs[a.key]} disabled={!canWrite} onChange={(v) => { setAttrs({ ...attrs, [a.key]: v }); setDirty(true); }} />
                {fieldErrors[a.key] && <span className="field-error">{fieldErrors[a.key]}</span>}
              </label>
            ))}
          </div>
          {canWrite && (
            <div className="row" style={{ marginTop: 'var(--s-5)' }}>
              <button className="btn primary" disabled={!dirty} onClick={save}>{t('record.save')}</button>
              {dirty && <button className="btn quiet" onClick={() => { setAttrs(rec.attrs); setDirty(false); }}>{t('record.undo')}</button>}
            </div>
          )}
        </section>

        <aside className="side">
          <div className="side-block">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3>{t('record.links')}</h3>
              {canWrite && <button className="btn quiet" onClick={() => linkDlg.current?.showModal()}>{t('record.link')}</button>}
            </div>
            {rec.links.length === 0 ? <p className="hint">{t('record.noLinks')}</p> : (
              <ul className="links">{rec.links.map((l) => (
                <li key={l.id}>
                  <span><span className="verb">{l.direction === 'out' ? `${verbOf(l)} ${blockName(l.other_block)}` : t('record.inbound', { block: blockName(l.other_block), verb: verbOf(l) })}</span>
                    <Link href={`/records/${l.other_id}`}>{l.other_name}</Link></span>
                  {canWrite && <button className="btn quiet" aria-label={t('record.unlinkLabel', { name: l.other_name })}
                    onClick={async () => { await api(`/records/${id}/links/${l.id}`, { method: 'DELETE' }); load(); }}>{t('record.unlink')}</button>}
                </li>))}
              </ul>
            )}
          </div>
          <div className="side-block">
            <h3>{t('record.history')}</h3>
            {rec.history.length === 0 ? <p className="hint">{t('record.noHistory')}</p> : (
              <ol className="timeline">{rec.history.map((h) => (
                <li key={h.id}><time>{date(h.created_at)}</time>{h.actor_name}: {t(`status.${h.from_status}`)} {arrow} {t(`status.${h.to_status}`)}{h.comment && <div className="hint">«{h.comment}»</div>}</li>))}
              </ol>
            )}
          </div>
        </aside>
      </div>

      <LinkDialog ref={linkDlg} blockCode={block.code} relations={model.relations.filter((r) => model.blocks.find((b) => b.code === r.target_code)?.active)}
        blockName={blockName} recordId={id} onDone={load} />

      <dialog ref={rejectDlg} aria-labelledby="rej">
        <h2 id="rej">{t('record.rejectTitle')}</h2>
        <p className="hint" style={{ margin: 'var(--s-2) 0 var(--s-3)' }}>{t('record.rejectHint')}</p>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} aria-label={t('record.rejectTitle')} />
        <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={() => rejectDlg.current?.close()}>{t('common.cancel')}</button>
          <button className="btn danger" disabled={!comment.trim()} onClick={() => { rejectDlg.current?.close(); act('reject', comment); }}>{t('record.rejectConfirm')}</button>
        </div>
      </dialog>
    </>
  );
}

function LinkDialog({ ref, blockCode, relations, blockName, recordId, onDone }:
  { ref: React.RefObject<HTMLDialogElement | null>; blockCode: string; relations: Relation[]; blockName: (c: string) => string; recordId: string; onDone: () => void }) {
  const { t, locale } = useI18n();
  const options = relations.filter((r) => r.active && r.source_code === blockCode);
  const [rel, setRel] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Rec[]>([]);
  const [err, setErr] = useState('');
  const relation = options.find((r) => r.id === rel);
  const arrow = locale === 'ar' ? '←' : '→';

  useEffect(() => {
    if (!relation) { setResults([]); return; }
    const timer = setTimeout(() => api<{ items: Rec[] }>(`/records?block=${relation.target_code}&size=20${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => setResults(r.items)).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(timer);
  }, [relation, q]);

  return (
    <dialog ref={ref} aria-labelledby="lnk">
      <h2 id="lnk" style={{ marginBottom: 'var(--s-4)' }}>{t('record.linkTitle')}</h2>
      {err && <div className="banner error">{err}</div>}
      <label className="field">{t('record.relationType')}
        <select value={rel} onChange={(e) => setRel(e.target.value)}>
          <option value="">{t('record.chooseRelation')}</option>
          {options.map((r) => <option key={r.id} value={r.id}>{locale === 'ar' ? r.name_ar ?? r.verb : r.verb} {arrow} {blockName(r.target_code)}</option>)}
        </select>
      </label>
      {relation && (
        <>
          <label className="field" style={{ marginTop: 'var(--s-3)' }}>{t('record.searchIn', { block: blockName(relation.target_code) })}
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="links" style={{ marginTop: 'var(--s-2)', maxHeight: 240, overflowY: 'auto' }}>
            {results.map((r) => (
              <li key={r.id}><span>{r.name}</span>
                <button className="btn" onClick={async () => {
                  try { await api(`/records/${recordId}/links`, { method: 'POST', json: { relation_id: rel, target_id: r.id } }); ref.current?.close(); onDone(); }
                  catch (e) { setErr((e as Error).message); }
                }}>{t('record.linkOne')}</button></li>
            ))}
            {results.length === 0 && <li className="hint">{t('repo.noMatch')}</li>}
          </ul>
        </>
      )}
      <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={() => ref.current?.close()}>{t('common.close')}</button>
      </div>
    </dialog>
  );
}
