'use client';
import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { api, canInScope, Rec } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { CMP_STATUSES, CmpStatus } from '../shared';

interface Node { id: string; parent_id: string | null; code: string; level: string; title_ar: string; title_en: string | null; leaf: boolean; status: string | null; due_date: string | null; assets: number; security_assets: number }
interface Assessment { id: string; record_id: string | null; status: string; evidence: string | null; evidence_url: string | null; assessed_at: string | null; remediation: string | null; due_date: string | null; record_name?: string; block_code?: string; updated_by_name?: string | null; updated_at: string }
interface Detail { item: Node & { text_ar: string | null; text_en: string | null }; path: { code: string; title_ar: string; title_en: string | null }[]; entity: Assessment | null; assets: Assessment[] }
interface Lib { id: string; code: string; version: string; name_ar: string; name_en: string }

const PROTECT_BLOCKS = ['security_hardware', 'security_software', 'security_service', 'application', 'server', 'physical_host', 'network_device', 'storage', 'data_center'];

export default function FrameworkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, nm, locale } = useI18n();
  const [tree, setTree] = useState<Node[] | null>(null);
  const [fw, setFw] = useState<Lib | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);

  const load = useCallback(() => { api<Node[]>(`/compliance/frameworks/${id}/tree`).then(setTree); }, [id]);
  useEffect(() => { load(); api<Lib[]>('/compliance/frameworks').then((l) => setFw(l.find((x) => x.id === id) ?? null)); }, [id, load]);
  if (!tree) return <p className="hint">{t('common.loading')}</p>;

  const children = (pid: string | null) => tree.filter((n) => n.parent_id === pid);
  const show = (n: Node) => !filter || (n.leaf ? n.status === filter : tree.some((x) => x.leaf && x.status === filter && isUnder(tree, x, n.id)));
  const row = (n: Node, depth: number) => (
    <li key={n.id} className={`t-row${depth > 1 ? ' child' : ''}`}>
      <span className="hint" dir="ltr">{n.code}</span>
      {n.leaf ? <button onClick={() => { setOpen(n.id); dlg.current?.showModal(); }}>{nm(n, 'title')}</button> : <span>{nm(n, 'title')}</span>}
      <span className="hint" title={t('cmp.assetsHint')}>{n.leaf ? t('cmp.assetsCount', { n: n.assets, s: n.security_assets }) : ''}</span>
      <span>{n.leaf && n.status && <CmpStatus s={n.status} />}</span>
    </li>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href="/compliance">{t('cmp.title')}</Link></p>
          <h1>{fw ? nm(fw) : ''} <span className="hint" dir="ltr">{fw ? `${fw.code}-${fw.version}` : ''}</span></h1>
          <p>{t('cmp.treeHint')}</p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 220 }} aria-label={t('common.status')}>
          <option value="">{t('cmp.allStatuses')}</option>
          {CMP_STATUSES.map((s) => <option key={s} value={s}>{t(`cmp.st.${s}`)}</option>)}
        </select>
      </div>
      <ul className="tree">
        {children(null).filter(show).map((d) => (
          <li key={d.id}>
            <div className="t-domain"><span className="hint" dir="ltr">{d.code}</span> {nm(d, 'title')}</div>
            <ul className="tree">
              {children(d.id).filter(show).map((s) => (
                <li key={s.id}>
                  <ul className="tree">{row(s, 1)}</ul>
                  <ul className="tree">{children(s.id).filter(show).flatMap((c) => [row(c, 2), ...children(c.id).filter(show).map((cc) => row(cc, 3))])}</ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <dialog ref={dlg} className="drawer" aria-labelledby="ctl" onClose={() => { setOpen(null); load(); }}>
        {open && <ControlPanel id={open} locale={locale} onClose={() => dlg.current?.close()} />}
      </dialog>
    </>
  );
}

function isUnder(all: Node[], n: Node, ancestor: string): boolean {
  let p = n.parent_id;
  while (p) { if (p === ancestor) return true; p = all.find((x) => x.id === p)?.parent_id ?? null; }
  return false;
}

function ControlPanel({ id, onClose, locale }: { id: string; onClose: () => void; locale: string }) {
  const { user, model } = useSession();
  const { t, nm, date } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [form, setForm] = useState<Partial<Assessment>>({ status: 'not_assessed' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [block, setBlock] = useState('security_hardware');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Rec[]>([]);
  const canEntity = !!user?.roles.some((r) => r === 'R2' || r === 'R3');
  const blk = model?.blocks.find((b) => b.code === block);
  // Mirrors the API: EA owner and architects map any asset; a data owner only assets in their scope.
  const canMap = !!blk && (canEntity || (!!user?.roles.includes('R4') && canInScope(user, 'records.write', blk)));

  const load = useCallback(async () => {
    const x = await api<Detail>(`/compliance/items/${id}`);
    setD(x);
    setForm(x.entity ?? { status: 'not_assessed' });
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!blk?.active) { setResults([]); return; }
    const timer = setTimeout(() => api<{ items: Rec[] }>(`/records?block=${block}&size=10${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => setResults(r.items)).catch(() => setResults([])), 200);
    return () => clearTimeout(timer);
  }, [block, q, blk]);

  if (!d || !model) return <p className="hint">{t('common.loading')}</p>;
  const put = async (body: object, ok: string) => {
    setMsg(null);
    try { await api(`/compliance/items/${id}/assessment`, { method: 'PUT', json: body }); await load(); setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  const text = locale === 'en' ? d.item.text_en ?? d.item.text_ar : d.item.text_ar;

  return (
    <>
      <p className="hint">{d.path.map((p) => `${p.code} ${nm(p, 'title')}`).join(' / ')}</p>
      <h2 id="ctl" style={{ margin: 'var(--s-2) 0 var(--s-3)' }}><span className="hint" dir="ltr">{d.item.code}</span> {nm(d.item, 'title')}</h2>
      {text ? <p className="control-text">{text}</p> : <p className="hint">{t('cmp.noText')}</p>}
      {msg && <div className={`banner ${msg.kind}`} style={{ marginTop: 'var(--s-3)' }}>{msg.text}</div>}

      <h3 style={{ margin: 'var(--s-5) 0 var(--s-3)' }}>{t('cmp.entityAssessment')}</h3>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label className="field">{t('common.status')}
          <select value={form.status ?? 'not_assessed'} disabled={!canEntity} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {CMP_STATUSES.map((s) => <option key={s} value={s}>{t(`cmp.st.${s}`)}</option>)}
          </select></label>
        <label className="field">{t('cmp.assessedAt')}<input type="date" dir="ltr" disabled={!canEntity} value={form.assessed_at?.slice(0, 10) ?? ''} onChange={(e) => setForm({ ...form, assessed_at: e.target.value })} /></label>
        <label className="field wide">{t('cmp.evidence')}<textarea disabled={!canEntity} value={form.evidence ?? ''} onChange={(e) => setForm({ ...form, evidence: e.target.value })} /></label>
        <label className="field wide">{t('cmp.evidenceUrl')}<input type="url" dir="ltr" disabled={!canEntity} value={form.evidence_url ?? ''} onChange={(e) => setForm({ ...form, evidence_url: e.target.value })} /></label>
        <label className="field wide">{t('cmp.remediation')}<textarea disabled={!canEntity} value={form.remediation ?? ''} onChange={(e) => setForm({ ...form, remediation: e.target.value })} /></label>
        <label className="field">{t('cmp.dueDate')}<input type="date" dir="ltr" disabled={!canEntity} value={form.due_date?.slice(0, 10) ?? ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
      </div>
      {d.entity?.updated_at && <p className="hint" style={{ marginTop: 'var(--s-2)' }}>{t('cmp.lastUpdate', { who: d.entity.updated_by_name ?? '—', when: date(d.entity.updated_at) })}</p>}
      {canEntity && <button className="btn primary" style={{ marginTop: 'var(--s-3)' }}
        onClick={() => put({ record_id: null, status: form.status, evidence: form.evidence ?? '', evidence_url: form.evidence_url ?? '', assessed_at: form.assessed_at?.slice(0, 10) ?? '', remediation: form.remediation ?? '', due_date: form.due_date?.slice(0, 10) ?? '' }, t('cmp.saved'))}>{t('cmp.saveAssessment')}</button>}

      <h3 style={{ margin: 'var(--s-5) 0 var(--s-2)' }}>{t('cmp.mappedAssets')}</h3>
      <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('cmp.mappedHint')}</p>
      {d.assets.length === 0 ? <p className="hint">{t('cmp.noAssets')}</p> : (
        <ul className="links">{d.assets.map((a) => (
          <li key={a.id}>
            <span><span className="verb">{nm(model.blocks.find((b) => b.code === a.block_code))}</span><Link href={`/records/${a.record_id}`}>{a.record_name}</Link></span>
            <span className="row">
              <select value={a.status} style={{ width: 'auto' }} aria-label={t('common.status')} onChange={(e) => put({ record_id: a.record_id, status: e.target.value }, t('cmp.saved'))}>
                {CMP_STATUSES.map((s) => <option key={s} value={s}>{t(`cmp.st.${s}`)}</option>)}
              </select>
              <button className="btn quiet" onClick={async () => { await api(`/compliance/items/${id}/assets/${a.record_id}`, { method: 'DELETE' }); load(); }}>{t('record.unlink')}</button>
            </span>
          </li>))}
        </ul>
      )}

      <div className="row" style={{ marginTop: 'var(--s-4)' }}>
        <select value={block} onChange={(e) => setBlock(e.target.value)} style={{ maxWidth: 220 }} aria-label={t('common.block')}>
          {PROTECT_BLOCKS.filter((c) => model.blocks.find((b) => b.code === c)?.active).map((c) => <option key={c} value={c}>{nm(model.blocks.find((b) => b.code === c))}</option>)}
        </select>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('repo.search')} style={{ maxWidth: 260 }} aria-label={t('repo.searchLabel')} />
      </div>
      <ul className="links" style={{ maxHeight: 200, overflowY: 'auto' }}>
        {results.filter((r) => !d.assets.some((a) => a.record_id === r.id)).map((r) => (
          <li key={r.id}><span>{r.name}</span>
            {canMap && <button className="btn" onClick={() => put({ record_id: r.id, status: 'not_assessed' }, t('cmp.mapped'))}>{t('cmp.map')}</button>}</li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
    </>
  );
}
