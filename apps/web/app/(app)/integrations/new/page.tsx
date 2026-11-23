'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Connector, ConnectorType, SCHEDULES } from '@/lib/integrations';
import { SettingsForm } from '../SettingsForm';

export default function NewConnector() {
  const { t, nm } = useI18n();
  const router = useRouter();
  const [types, setTypes] = useState<ConnectorType[]>([]);
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<number | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [err, setErr] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => { api<ConnectorType[]>('/integrations/types').then((l) => { setTypes(l); setType(l[0]?.type ?? ''); }); }, []);
  const ct = types.find((x) => x.type === type);

  async function save() {
    setErr(''); setFieldErrors({});
    try {
      const c = await api<Connector>('/integrations', { method: 'POST', json: { name, type, settings, secret, schedule_minutes: schedule, auto_approve: autoApprove } });
      router.push(`/integrations/${c.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.errors.length) setFieldErrors(Object.fromEntries(e.errors.map((x) => [x.key ?? '', x.message])));
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head"><div><h1>{t('int.newTitle')}</h1><p>{t('int.newSubtitle')}</p></div></div>
      {err && <div className="banner error" role="alert">{err}</div>}
      <section className="section">
        <h2>{t('int.chooseType')}</h2>
        <div className="row" style={{ alignItems: 'stretch', marginTop: 'var(--s-3)' }}>
          {types.map((x) => (
            <label key={x.type} className="lane" style={{ maxWidth: 360, cursor: 'pointer', ['--c' as string]: type === x.type ? 'var(--green)' : 'var(--rule)' }}>
              <span className="row" style={{ gap: 6 }}><input type="radio" name="type" checked={type === x.type} onChange={() => setType(x.type)} /><b>{nm(x)}</b></span>
              <span className="hint" style={{ display: 'block', marginTop: 4 }}>{nm(x, 'description')}</span>
            </label>
          ))}
        </div>
      </section>
      {ct && (
        <section className="section">
          <h2>{t('int.settings')}</h2>
          <div className="settings-grid" style={{ marginTop: 'var(--s-3)' }}>
            <label className="field">{t('int.name')}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('int.namePlaceholder')} /></label>
          </div>
          <SettingsForm fields={ct.settings} settings={settings} secret={secret} onSettings={setSettings} onSecret={setSecret} errors={fieldErrors} />
          <div className="settings-grid" style={{ marginTop: 'var(--s-4)' }}>
            <label className="field">{t('int.schedule')}
              <select value={schedule ?? ''} onChange={(e) => setSchedule(e.target.value ? Number(e.target.value) : null)}>
                {SCHEDULES.map((s) => <option key={s ?? 0} value={s ?? ''}>{s ? t(`int.every.${s}`) : t('int.manualOnly')}</option>)}
              </select>
            </label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />{t('int.autoApprove')}</label>
          </div>
          <p className="hint" style={{ marginTop: 'var(--s-3)' }}>{t('int.readOnlyHint')}</p>
          <button className="btn primary" style={{ marginTop: 'var(--s-4)' }} disabled={!name.trim()} onClick={save}>{t('int.create')}</button>
        </section>
      )}
    </>
  );
}
