'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, can } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { CycleRow, PhaseTrack } from '@/lib/cycles';

export default function Cycles() {
  const { user, model } = useSession();
  const { t, nm } = useI18n();
  const router = useRouter();
  const [list, setList] = useState<CycleRow[] | null>(null);
  const [err, setErr] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({ name: '', objective: '', start_date: '', end_date: '', domains: [] as string[], starter_tasks: true });

  useEffect(() => { api<CycleRow[]>('/cycles').then(setList).catch((e) => setErr(e.message)); }, []);
  if (!list || !model) return err ? <div className="banner error">{err}</div> : <p className="hint">{t('common.loading')}</p>;
  const manage = can(user, 'cycles.manage');
  const active = list.filter((c) => c.status === 'active');

  async function create() {
    setErr('');
    try {
      const c = await api<{ id: string }>('/cycles', { method: 'POST', json: { ...form, objective: form.objective || null, start_date: form.start_date || null, end_date: form.end_date || null } });
      dlg.current?.close(); router.push(`/cycles/${c.id}`);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('cycle.title')}</h1>
          <p style={{ maxWidth: 720 }}>{t('cycle.subtitle')}</p>
        </div>
        {manage && <button className="btn primary" onClick={() => dlg.current?.showModal()}>{t('cycle.new')}</button>}
      </div>
      {err && <div className="banner error">{err}</div>}

      <div className="figures">
        <div className="figure"><b>{active.length}</b><span>{t('cycle.activeCount')}</span></div>
        <div className="figure"><b>{list.filter((c) => c.status === 'planned').length}</b><span>{t('cycle.plannedCount')}</span></div>
        <div className="figure"><b>{active.reduce((s, c) => s + c.tasks_overdue, 0)}</b><span>{t('cycle.overdueCount')}</span></div>
        <div className="figure"><b>{active.reduce((s, c) => s + c.changes, 0)}</b><span>{t('cycle.changesCount')}</span></div>
      </div>

      {list.length === 0 ? <p className="empty">{t('cycle.none')}</p> : (
        <div className="cycle-cards">
          {list.map((c) => (
            <Link key={c.id} href={`/cycles/${c.id}`} className={`cycle-card st-${c.status}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="hint" dir="ltr">{c.code}</span>
                <span className={`status cy-${c.status}`}>{t(`cycle.status.${c.status}`)}</span>
              </div>
              <h3>{c.name}</h3>
              <p className="hint"><span dir="ltr">{c.start_date ?? '—'} – {c.end_date ?? '—'}</span>{c.owner_name ? ` · ${c.owner_name}` : ''}</p>
              <PhaseTrack phase={c.phase} status={c.status} compact />
              <p className="hint">{c.status === 'active' ? t('cycle.inPhase', { phase: t(`cycle.phase.${c.phase}`) }) : ' '}</p>
              <div className="bar" aria-label={t('cycle.progress')}><span style={{ width: `${Math.round(100 * (c.tasks_total ? c.tasks_done / c.tasks_total : 0))}%` }} /></div>
              <p className="row hint" style={{ justifyContent: 'space-between' }}>
                <span>{t('cycle.tasksDone', { done: c.tasks_done, total: c.tasks_total })}</span>
                <span>{t('cycle.changesN', { n: c.changes })}</span>
                {c.tasks_overdue > 0 && c.status === 'active' && <span className="alert-expired">{t('cycle.overdueN', { n: c.tasks_overdue })}</span>}
              </p>
              {c.domains.length > 0 && <p className="chips">{c.domains.map((d) => <span key={d} className="chip" style={{ ['--c' as string]: `var(--d-${d})` }}>{t(`domain.${d}`)}</span>)}</p>}
            </Link>
          ))}
        </div>
      )}

      <dialog ref={dlg} aria-labelledby="newc">
        <h2 id="newc" style={{ marginBottom: 'var(--s-4)' }}>{t('cycle.new')}</h2>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label className="field wide">{t('cycle.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field wide">{t('cycle.objective')}<textarea value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></label>
          <label className="field">{t('cycle.start')}<input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></label>
          <label className="field">{t('cycle.end')}<input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></label>
          <fieldset className="field wide"><legend>{t('cycle.domains')}</legend>
            <div className="chips">{model.domains.map((d) => (
              <label key={d.code} className="chip"><input type="checkbox" checked={form.domains.includes(d.code)}
                onChange={(e) => setForm({ ...form, domains: e.target.checked ? [...form.domains, d.code] : form.domains.filter((x) => x !== d.code) })} /> {nm(d)}</label>
            ))}</div>
            <span className="hint">{t('cycle.domainsHint')}</span>
          </fieldset>
          <label className="row wide"><input type="checkbox" checked={form.starter_tasks} onChange={(e) => setForm({ ...form, starter_tasks: e.target.checked })} /> {t('cycle.starter')}</label>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
          <button className="btn quiet" onClick={() => dlg.current?.close()}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={form.name.trim().length < 2} onClick={create}>{t('cycle.create')}</button>
        </div>
      </dialog>
    </>
  );
}
