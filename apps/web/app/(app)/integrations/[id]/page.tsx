'use client';
import Link from 'next/link';
import { Fragment, use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { Connector, ConnectorType, Detail, Run, SCHEDULES, SourceEntity, Target, TRANSFORMS } from '@/lib/integrations';
import { SettingsForm } from '../SettingsForm';

export default function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { model } = useSession();
  const { t, nm, date } = useI18n();
  const router = useRouter();
  const [c, setC] = useState<Connector | null>(null);
  const [ct, setCt] = useState<ConnectorType | null>(null);
  const [entities, setEntities] = useState<SourceEntity[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [preview, setPreview] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api<Connector[]>('/integrations');
    const me = list.find((x) => x.id === id);
    if (!me) return;
    setC(me); setTargets(me.config.targets ?? []); setSettings(me.config.settings ?? {}); setSecret({});
    const types = await api<ConnectorType[]>('/integrations/types');
    setCt(types.find((x) => x.type === me.type) ?? null);
    setEntities(await api<SourceEntity[]>(`/integrations/${id}/entities`));
    setRuns(await api<Run[]>(`/integrations/${id}/runs`));
  }, [id]);
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: e.message })); }, [load]);

  if (!c || !ct || !model) return msg ? <div className="banner error">{msg.text}</div> : <p className="hint">{t('common.loading')}</p>;

  async function patch(body: object, ok: string) {
    setMsg(null);
    try { await api(`/integrations/${id}`, { method: 'PATCH', json: body }); await load(); setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }
  async function test() {
    setBusy(true); setMsg(null);
    const r = await api<{ ok: boolean; message: string }>(`/integrations/${id}/test`, { method: 'POST' }).finally(() => setBusy(false));
    setMsg({ kind: r.ok ? 'ok' : 'error', text: r.ok ? t('int.testOk', { m: r.message }) : t('int.testFailed', { m: r.message }) });
  }
  async function run(dry: boolean) {
    setBusy(true); setMsg(null); setPreview(null);
    try {
      const r = await api<Run>(`/integrations/${id}/run${dry ? '?dryRun=true' : ''}`, { method: 'POST' });
      if (dry) setPreview(r);
      else { await load(); setMsg({ kind: r.status === 'failed' ? 'error' : 'ok', text: t(r.status === 'failed' ? 'int.runFailed' : 'int.runDone', { c: r.created, u: r.updated, n: r.unchanged, k: r.conflicts }) }); }
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  const setTarget = (i: number, patchT: Partial<Target>) => setTargets(targets.map((x, j) => (j === i ? { ...x, ...patchT } : x)));
  const activeBlocks = model.blocks.filter((b) => b.active);

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href="/integrations">{t('int.title')}</Link></p>
          <h1>{c.name}</h1>
          <p className="hint">{nm(ct)} — {c.schedule_minutes ? t(`int.every.${c.schedule_minutes}`) : t('int.manualOnly')}{c.auto_approve ? ` — ${t('int.autoApproveOn')}` : ''}</p>
        </div>
        <div className="row">
          <button className="btn" disabled={busy} onClick={test}>{t('int.test')}</button>
          <button className="btn" disabled={busy} onClick={() => run(true)}>{t('int.preview')}</button>
          <button className="btn primary" disabled={busy || !c.enabled} onClick={() => run(false)}>{t('int.syncNow')}</button>
        </div>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      {preview && (
        <div className={`banner ${preview.status === 'failed' ? 'error' : 'warn'}`}>
          {preview.status === 'failed' ? t('int.runFailed', {}) : t('int.previewResult', { c: preview.created, u: preview.updated, n: preview.unchanged, k: preview.conflicts })}
          {preview.details && preview.details.length > 0 && <Details details={preview.details} />}
        </div>
      )}

      <section className="section">
        <h2>{t('int.mapping')}</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('int.mappingHint')}</p>
        {targets.map((tg, i) => {
          const ent = entities.find((e) => e.key === tg.entity);
          const block = model.blocks.find((b) => b.code === tg.block);
          return (
            <div key={tg.entity + i} className="side-block" style={{ marginBottom: 'var(--s-5)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={tg.enabled} onChange={(e) => setTarget(i, { enabled: e.target.checked })} /><h3>{nm(ent) || tg.entity}</h3></label>
                <div className="row">
                  <label className="row" style={{ gap: 6 }}>{t('int.into')}
                    <select value={tg.block} onChange={(e) => setTarget(i, { block: e.target.value })} style={{ width: 'auto' }}>
                      {activeBlocks.map((b) => <option key={b.code} value={b.code}>{nm(b)}</option>)}
                    </select></label>
                  <label className="row" style={{ gap: 6 }}>{t('int.truth')}
                    <select value={tg.mode} onChange={(e) => setTarget(i, { mode: e.target.value as Target['mode'] })} style={{ width: 'auto' }}>
                      <option value="overwrite">{t('int.mode.overwrite')}</option>
                      <option value="fill_empty">{t('int.mode.fill_empty')}</option>
                    </select></label>
                </div>
              </div>
              <div className="table-wrap mapping" style={{ marginTop: 'var(--s-3)' }}><table>
                <thead><tr><th>{t('int.sourceField')}</th><th>{t('int.targetAttr')}</th><th>{t('int.transform')}</th><th /></tr></thead>
                <tbody>
                  {tg.fields.map((f, j) => (
                    <tr key={j}>
                      <td>{ent && ent.fields.length
                        ? <select value={f.from} onChange={(e) => setTarget(i, { fields: tg.fields.map((x, k) => (k === j ? { ...x, from: e.target.value } : x)) })}>
                            {ent.fields.map((sf) => <option key={sf.path} value={sf.path}>{nm(sf)} ({sf.path})</option>)}
                          </select>
                        : <input dir="ltr" value={f.from} onChange={(e) => setTarget(i, { fields: tg.fields.map((x, k) => (k === j ? { ...x, from: e.target.value } : x)) })} />}</td>
                      <td><select value={f.to} onChange={(e) => setTarget(i, { fields: tg.fields.map((x, k) => (k === j ? { ...x, to: e.target.value } : x)) })}>
                        <option value="">—</option>
                        {block?.attributes.filter((a) => a.active).map((a) => <option key={a.key} value={a.key}>{nm(a)}</option>)}
                      </select></td>
                      <td><select value={f.transform ?? 'none'} onChange={(e) => setTarget(i, { fields: tg.fields.map((x, k) => (k === j ? { ...x, transform: e.target.value } : x)) })}>
                        {TRANSFORMS.map((x) => <option key={x} value={x}>{t(`int.tf.${x}`)}</option>)}
                      </select></td>
                      <td><button className="btn quiet" onClick={() => setTarget(i, { fields: tg.fields.filter((_, k) => k !== j) })}>{t('int.removeField')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <button className="btn quiet" style={{ marginTop: 'var(--s-2)' }} onClick={() => setTarget(i, { fields: [...tg.fields, { from: ent?.fields[0]?.path ?? '', to: '' }] })}>{t('int.addField')}</button>
              {block && block.title_key && !tg.fields.some((f) => f.to === block.title_key) && <p className="field-error">{t('int.needsTitle', { attr: nm(block.attributes.find((a) => a.key === block.title_key)) })}</p>}
            </div>
          );
        })}
        <button className="btn primary" onClick={() => patch({ targets: targets.map((x) => ({ ...x, fields: x.fields.filter((f) => f.from && f.to) })) }, t('int.mappingSaved'))}>{t('int.saveMapping')}</button>
      </section>

      <section className="section">
        <h2>{t('int.history')}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('int.started')}</th><th>{t('int.trigger')}</th><th>{t('common.status')}</th><th className="num">{t('int.created')}</th><th className="num">{t('int.updated')}</th><th className="num">{t('int.unchanged')}</th><th className="num">{t('int.conflicts')}</th><th /></tr></thead>
          <tbody>{runs.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{date(r.started_at)}</td>
                <td>{t(`int.trigger.${r.trigger}`)}{r.started_by_name ? ` — ${r.started_by_name}` : ''}</td>
                <td className={r.status === 'failed' ? 'run-failed' : 'run-ok'}>{t(`int.status.${r.status}`)}</td>
                <td className="num">{r.created}</td><td className="num">{r.updated}</td><td className="num">{r.unchanged}</td><td className="num">{r.conflicts || '—'}</td>
                <td>{(r.details?.length ?? 0) > 0 && <button className="btn quiet" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{t('int.details')}</button>}</td>
              </tr>
              {open === r.id && <tr><td colSpan={8}><Details details={r.details ?? []} /></td></tr>}
            </Fragment>
          ))}</tbody>
        </table>
        {runs.length === 0 && <div className="empty">{t('int.noRuns')}</div>}
        </div>
      </section>

      <section className="section">
        <h2>{t('int.settings')}</h2>
        <SettingsForm fields={ct.settings} settings={settings} secret={secret} onSettings={setSettings} onSecret={setSecret} editing />
        <div className="settings-grid" style={{ marginTop: 'var(--s-4)' }}>
          <label className="field">{t('int.schedule')}
            <select value={c.schedule_minutes ?? ''} onChange={(e) => patch({ schedule_minutes: e.target.value ? Number(e.target.value) : null }, t('int.saved'))}>
              {SCHEDULES.map((s) => <option key={s ?? 0} value={s ?? ''}>{s ? t(`int.every.${s}`) : t('int.manualOnly')}</option>)}
            </select>
          </label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={c.auto_approve} onChange={(e) => patch({ auto_approve: e.target.checked }, t('int.saved'))} />{t('int.autoApprove')}</label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={c.enabled} onChange={(e) => patch({ enabled: e.target.checked }, t('int.saved'))} />{t('int.enabled')}</label>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <button className="btn primary" onClick={() => patch({ settings, secret }, t('int.saved'))}>{t('int.saveSettings')}</button>
          <button className="btn danger" onClick={async () => { if (window.confirm(t('int.deleteConfirm'))) { await api(`/integrations/${id}`, { method: 'DELETE' }); router.push('/integrations'); } }}>{t('int.delete')}</button>
        </div>
      </section>
    </>
  );
}

function Details({ details }: { details: Detail[] }) {
  const { t } = useI18n();
  const v = (x: unknown) => (x === undefined || x === null ? '—' : Array.isArray(x) ? x.join('; ') : String(x));
  return (
    <ul style={{ margin: 'var(--s-2) 0 0', paddingInlineStart: 18, fontSize: 13 }}>
      {details.slice(0, 50).map((d, i) => (
        <li key={i}>{d.kind === 'conflict'
          ? t('int.conflictLine', { name: d.name ?? '', attr: d.attribute ?? '', repo: v(d.repository), src: v(d.source) })
          : `${d.name || d.external_id || ''} ${d.message ?? ''} ${(d.errors ?? []).map((e) => `${e.key}: ${e.message}`).join('، ')}`}</li>
      ))}
    </ul>
  );
}
