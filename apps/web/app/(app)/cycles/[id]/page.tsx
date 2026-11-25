'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { api, can } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { CycleRow, PHASES, PhaseTrack } from '@/lib/cycles';

interface Task { id: string; phase: string; title: string; deliverable: string | null; assignee_id: string | null; assignee_name: string | null; due_date: string | null; status: 'todo' | 'doing' | 'done' }
interface Change { id: string; record_id: string; name: string; block_code: string; record_status: string; change_type: 'add' | 'modify' | 'retire'; rationale: string | null; target_date: string | null; status: 'planned' | 'done' | 'cancelled' }
interface StateRow { block_code: string; current: number; adds: number; modifies: number; retires: number; target: number }
interface Full extends Omit<CycleRow, 'tasks_total' | 'tasks_done' | 'tasks_overdue' | 'changes'> {
  owner_id: string | null; tasks: Task[]; changes: Change[]; members: { id: string; display_name: string }[]; state: StateRow[];
}
interface Hit { id: string; name: string; block_code: string; status: string }

const today = () => new Date().toISOString().slice(0, 10);

export default function CyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, model } = useSession();
  const { t, nm } = useI18n();
  const router = useRouter();
  const [c, setC] = useState<Full | null>(null);
  const [tab, setTab] = useState<'tasks' | 'changes' | 'state'>('tasks');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const editDlg = useRef<HTMLDialogElement>(null);
  const changeDlg = useRef<HTMLDialogElement>(null);

  const load = useCallback(() => api<Full>(`/cycles/${id}`).then(setC).catch((e) => setMsg({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!c || !model) return msg ? <div className="banner error">{msg.text}</div> : <p className="hint">{t('common.loading')}</p>;

  const open = c.status === 'planned' || c.status === 'active';
  const manage = can(user, 'cycles.manage') && open;
  const blockName = (code: string) => nm(model.blocks.find((b) => b.code === code)) || code;
  const domainOf = (code: string) => model.blocks.find((b) => b.code === code)?.domain_code ?? '';
  const done = c.tasks.filter((x) => x.status === 'done').length;
  const overdue = c.tasks.filter((x) => x.status !== 'done' && x.due_date && x.due_date < today()).length;
  const at = PHASES.indexOf(c.phase);
  const daysLeft = c.end_date ? Math.ceil((Date.parse(c.end_date) - Date.now()) / 864e5) : null;
  const live = c.changes.filter((x) => x.status !== 'cancelled');

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setMsg(null);
    try { await fn(); await load(); if (ok) setMsg({ kind: 'ok', text: ok }); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }
  const patch = (json: object, ok?: string) => run(() => api(`/cycles/${id}`, { method: 'PATCH', json }), ok);
  const patchTask = (task: Task, json: object) => run(() => api(`/cycles/${id}/tasks/${task.id}`, { method: 'PATCH', json }));

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href="/cycles">{t('cycle.title')}</Link> <span className="hint" dir="ltr">{c.code}</span></p>
          <h1>{c.name}</h1>
          <p className="row">
            <span className={`status cy-${c.status}`}>{t(`cycle.status.${c.status}`)}</span>
            <span className="hint"><span dir="ltr">{c.start_date ?? '—'} – {c.end_date ?? '—'}</span>{c.owner_id ? ` · ${t('cycle.owner')}: ${c.members.find((m) => m.id === c.owner_id)?.display_name ?? ''}` : ''}</span>
          </p>
        </div>
        {manage && (
          <div className="row">
            {c.status === 'planned' && <button className="btn primary" onClick={() => patch({ status: 'active' }, t('cycle.activated'))}>{t('cycle.activate')}</button>}
            {c.status === 'active' && at > 0 && <button className="btn" onClick={() => patch({ phase: PHASES[at - 1] })}>{t('cycle.back')}</button>}
            {c.status === 'active' && at < PHASES.length - 1 && (
              <button className="btn primary" onClick={() => patch({ phase: PHASES[at + 1] }, t('cycle.moved', { phase: t(`cycle.phase.${PHASES[at + 1]}`) }))}>
                {t('cycle.next', { phase: t(`cycle.phase.${PHASES[at + 1]}`) })}</button>
            )}
            {c.status === 'active' && c.phase === 'approval' && <button className="btn primary" onClick={() => patch({ status: 'closed' }, t('cycle.closed'))}>{t('cycle.close')}</button>}
            <button className="btn quiet" onClick={() => editDlg.current?.showModal()}>{t('cycle.edit')}</button>
            {c.status === 'planned'
              ? <button className="btn danger" onClick={() => confirm(t('cycle.deleteConfirm')) && run(async () => { await api(`/cycles/${id}`, { method: 'DELETE' }); router.push('/cycles'); })}>{t('cycle.delete')}</button>
              : <button className="btn danger" onClick={() => confirm(t('cycle.cancelConfirm')) && patch({ status: 'cancelled' })}>{t('cycle.cancel')}</button>}
          </div>
        )}
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}

      <PhaseTrack phase={c.phase} status={c.status} />

      <div className="figures">
        <div className="figure"><b>{c.tasks.length ? Math.round((100 * done) / c.tasks.length) : 0}%</b><span>{t('cycle.progress')}</span></div>
        <div className="figure"><b>{done}/{c.tasks.length}</b><span>{t('cycle.tasks')}</span></div>
        <div className="figure"><b className={overdue ? 'alert-expired' : undefined}>{overdue}</b><span>{t('cycle.overdue')}</span></div>
        <div className="figure"><b>{live.length}</b><span>{t('cycle.plannedChanges')}</span></div>
        {daysLeft !== null && open && <div className="figure"><b className={daysLeft < 0 ? 'alert-expired' : undefined}>{daysLeft}</b><span>{t(daysLeft < 0 ? 'cycle.daysLate' : 'cycle.daysLeft')}</span></div>}
      </div>

      {(c.objective || c.domains.length > 0) && (
        <section className="section cycle-about">
          {c.objective && <p>{c.objective}</p>}
          <p className="chips">{(c.domains.length ? c.domains : model.domains.map((d) => d.code)).map((d) => <span key={d} className="chip" style={{ ['--c' as string]: `var(--d-${d})` }}>{t(`domain.${d}`)}</span>)}</p>
        </section>
      )}

      <div className="tabs" role="tablist" style={{ marginTop: 'var(--s-5)' }}>
        {(['tasks', 'changes', 'state'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {t(`cycle.tab.${k}`)}{k === 'tasks' ? ` · ${c.tasks.length}` : k === 'changes' ? ` · ${live.length}` : ''}
          </button>
        ))}
      </div>

      {tab === 'tasks' && PHASES.map((ph, i) => {
        const list = c.tasks.filter((x) => x.phase === ph);
        const now = c.status === 'active' && ph === c.phase;
        return (
          <section key={ph} className={`phase-block${now ? ' now' : ''}`}>
            <h2><span className="ph-num">{i + 1}</span>{t(`cycle.phase.${ph}`)}
              <span className="hint"> {list.filter((x) => x.status === 'done').length}/{list.length}</span>
              {now && <span className="status cy-active">{t('cycle.currentPhase')}</span>}</h2>
            <p className="hint">{t(`cycle.phaseHint.${ph}`)}</p>
            <ul className="tasks">
              {list.map((task) => {
                const late = task.status !== 'done' && task.due_date && task.due_date < today();
                return (
                  <li key={task.id} className={`task t-${task.status}`}>
                    <button className="task-check" aria-label={t('cycle.toggleDone', { title: task.title })} aria-pressed={task.status === 'done'} disabled={!manage}
                      onClick={() => patchTask(task, { status: task.status === 'done' ? 'todo' : 'done' })}>{task.status === 'done' ? '✓' : ''}</button>
                    <div className="task-main">
                      <span className="task-title">{task.title}</span>
                      {task.deliverable && <span className="hint">{t('cycle.deliverable')}: {task.deliverable}</span>}
                    </div>
                    <select value={task.status} disabled={!manage} aria-label={t('cycle.taskStatus')} onChange={(e) => patchTask(task, { status: e.target.value })}>
                      {(['todo', 'doing', 'done'] as const).map((s) => <option key={s} value={s}>{t(`cycle.task.${s}`)}</option>)}
                    </select>
                    <select value={task.assignee_id ?? ''} disabled={!manage} aria-label={t('cycle.assignee')} onChange={(e) => patchTask(task, { assignee_id: e.target.value || null })}>
                      <option value="">{t('cycle.unassigned')}</option>
                      {c.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                    </select>
                    <input type="date" value={task.due_date ?? ''} disabled={!manage} aria-label={t('cycle.due')} className={late ? 'late' : undefined}
                      onChange={(e) => patchTask(task, { due_date: e.target.value || null })} />
                    {manage && <button className="btn quiet" aria-label={t('cycle.removeTask', { title: task.title })} onClick={() => run(() => api(`/cycles/${id}/tasks/${task.id}`, { method: 'DELETE' }))}>×</button>}
                  </li>
                );
              })}
              {list.length === 0 && <li className="hint">{t('cycle.noTasks')}</li>}
            </ul>
            {manage && <AddTask onAdd={(title, deliverable) => run(() => api(`/cycles/${id}/tasks`, { method: 'POST', json: { phase: ph, title, deliverable: deliverable || null } }))} />}
          </section>
        );
      })}

      {tab === 'changes' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
            <p className="hint" style={{ maxWidth: 640 }}>{t('cycle.changesHint')}</p>
            {manage && <button className="btn primary" onClick={() => changeDlg.current?.showModal()}>{t('cycle.addChange')}</button>}
          </div>
          {c.changes.length === 0 ? <p className="empty">{t('cycle.noChanges')}</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{t('cycle.changeType')}</th><th>{t('impact.record')}</th><th>{t('impact.block')}</th><th>{t('cycle.rationale')}</th><th>{t('cycle.targetDate')}</th><th>{t('common.status')}</th><th /></tr></thead>
              <tbody>{c.changes.map((x) => (
                <tr key={x.id} className={x.status === 'cancelled' ? 'muted' : undefined}>
                  <td><span className={`plan plan-${x.change_type}`}>{t(`cycle.change.${x.change_type}`)}</span></td>
                  <td><Link href={`/records/${x.record_id}`}>{x.name}</Link></td>
                  <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${domainOf(x.block_code)})` }} />{blockName(x.block_code)}</td>
                  <td className="hint">{x.rationale ?? '—'}</td>
                  <td dir="ltr">{x.target_date ?? '—'}</td>
                  <td><select value={x.status} disabled={!manage} aria-label={t('common.status')} onChange={(e) => run(() => api(`/cycles/${id}/changes/${x.id}`, { method: 'PATCH', json: { status: e.target.value } }))}>
                    {(['planned', 'done', 'cancelled'] as const).map((s) => <option key={s} value={s}>{t(`cycle.cstatus.${s}`)}</option>)}
                  </select></td>
                  <td>{manage && <button className="btn quiet" onClick={() => run(() => api(`/cycles/${id}/changes/${x.id}`, { method: 'DELETE' }))}>{t('record.unlink')}</button>}</td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </>
      )}

      {tab === 'state' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
            <p className="hint" style={{ maxWidth: 640 }}>{t('cycle.stateHint')}</p>
            <div className="row">
              <Link className="btn" href={`/views?cycle=${id}&state=current`}>{t('cycle.viewsCurrent')}</Link>
              <Link className="btn primary" href={`/views?cycle=${id}&state=target`}>{t('cycle.viewsTarget')}</Link>
            </div>
          </div>
          {c.state.filter((s) => s.adds || s.modifies || s.retires).length === 0 ? <p className="empty">{t('cycle.noChanges')}</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{t('impact.block')}</th><th className="num">{t('cycle.now')}</th><th className="num">{t('cycle.change.add')}</th><th className="num">{t('cycle.change.modify')}</th><th className="num">{t('cycle.change.retire')}</th><th className="num">{t('cycle.after')}</th></tr></thead>
              <tbody>{c.state.filter((s) => s.adds || s.modifies || s.retires).map((s) => (
                <tr key={s.block_code}>
                  <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${domainOf(s.block_code)})` }} />{blockName(s.block_code)}</td>
                  <td className="num">{s.current}</td>
                  <td className="num plan-add-n">{s.adds ? <bdi dir="ltr">+{s.adds}</bdi> : '—'}</td>
                  <td className="num plan-modify-n">{s.modifies ? <bdi dir="ltr">~{s.modifies}</bdi> : '—'}</td>
                  <td className="num plan-retire-n">{s.retires ? <bdi dir="ltr">−{s.retires}</bdi> : '—'}</td>
                  <td className="num"><b>{s.target}</b></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </>
      )}

      <EditDialog ref={editDlg} c={c} onSave={(json) => patch(json, t('record.saved'))} />
      <ChangeDialog ref={changeDlg} blockName={blockName} onAdd={(json) => run(() => api(`/cycles/${id}/changes`, { method: 'POST', json }), t('cycle.changeAdded'))} />
    </>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string, deliverable: string) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [deliverable, setDeliverable] = useState('');
  return (
    <form className="row add-task" onSubmit={(e) => { e.preventDefault(); if (title.trim().length < 2) return; onAdd(title.trim(), deliverable.trim()); setTitle(''); setDeliverable(''); }}>
      <input placeholder={t('cycle.newTask')} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('cycle.newTask')} />
      <input placeholder={t('cycle.deliverable')} value={deliverable} onChange={(e) => setDeliverable(e.target.value)} aria-label={t('cycle.deliverable')} />
      <button className="btn" disabled={title.trim().length < 2}>{t('cycle.addTask')}</button>
    </form>
  );
}

function EditDialog({ ref, c, onSave }: { ref: React.RefObject<HTMLDialogElement | null>; c: Full; onSave: (json: object) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: c.name, objective: c.objective ?? '', start_date: c.start_date ?? '', end_date: c.end_date ?? '', owner_id: c.owner_id ?? '' });
  useEffect(() => setF({ name: c.name, objective: c.objective ?? '', start_date: c.start_date ?? '', end_date: c.end_date ?? '', owner_id: c.owner_id ?? '' }), [c]);
  return (
    <dialog ref={ref} aria-labelledby="editc">
      <h2 id="editc" style={{ marginBottom: 'var(--s-4)' }}>{t('cycle.edit')}</h2>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label className="field wide">{t('cycle.name')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field wide">{t('cycle.objective')}<textarea value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></label>
        <label className="field">{t('cycle.start')}<input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></label>
        <label className="field">{t('cycle.end')}<input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></label>
        <label className="field wide">{t('cycle.owner')}
          <select value={f.owner_id} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>{c.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={() => ref.current?.close()}>{t('common.cancel')}</button>
        <button className="btn primary" onClick={() => { ref.current?.close(); onSave({ name: f.name, objective: f.objective || null, start_date: f.start_date || null, end_date: f.end_date || null, ...(f.owner_id ? { owner_id: f.owner_id } : {}) }); }}>{t('record.save')}</button>
      </div>
    </dialog>
  );
}

function ChangeDialog({ ref, blockName, onAdd }: { ref: React.RefObject<HTMLDialogElement | null>; blockName: (c: string) => string; onAdd: (json: object) => void }) {
  const { t } = useI18n();
  const [type, setType] = useState<'add' | 'modify' | 'retire'>('modify');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [pick, setPick] = useState<Hit | null>(null);
  const [rationale, setRationale] = useState('');
  const [date, setDate] = useState('');
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const timer = setTimeout(() => api<{ items: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}&limit=10`).then((r) => setHits(r.items)).catch(() => setHits([])), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const reset = () => { setQ(''); setHits([]); setPick(null); setRationale(''); setDate(''); };
  return (
    <dialog ref={ref} aria-labelledby="addch">
      <h2 id="addch" style={{ marginBottom: 'var(--s-3)' }}>{t('cycle.addChange')}</h2>
      <div className="levels" role="group" aria-label={t('cycle.changeType')} style={{ marginBottom: 'var(--s-3)' }}>
        {(['add', 'modify', 'retire'] as const).map((x) => <button key={x} aria-pressed={type === x} onClick={() => setType(x)}>{t(`cycle.change.${x}`)}</button>)}
      </div>
      <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t(`cycle.changeHint.${type}`)}</p>
      {pick ? (
        <p className="row"><b>{pick.name}</b> <span className="hint">{blockName(pick.block_code)}</span> <button className="btn quiet" onClick={() => setPick(null)}>{t('cycle.changePick')}</button></p>
      ) : (
        <>
          <label className="field">{t('cycle.findRecord')}<input type="search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <ul className="links" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 'var(--s-2)' }}>
            {hits.map((h) => <li key={h.id}><span>{h.name} <span className="hint">· {blockName(h.block_code)}</span></span><button className="btn" onClick={() => setPick(h)}>{t('cycle.choose')}</button></li>)}
          </ul>
        </>
      )}
      <label className="field" style={{ marginTop: 'var(--s-3)' }}>{t('cycle.rationale')}<textarea value={rationale} onChange={(e) => setRationale(e.target.value)} /></label>
      <label className="field" style={{ marginTop: 'var(--s-3)' }}>{t('cycle.targetDate')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <div className="row" style={{ marginTop: 'var(--s-4)', justifyContent: 'flex-end' }}>
        <button className="btn quiet" onClick={() => { ref.current?.close(); reset(); }}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!pick} onClick={() => { ref.current?.close(); onAdd({ record_id: pick!.id, change_type: type, rationale: rationale || null, target_date: date || null }); reset(); }}>{t('cycle.addChange')}</button>
      </div>
    </dialog>
  );
}
