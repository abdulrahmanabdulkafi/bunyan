'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Connector, ConnectorType } from '@/lib/integrations';

export default function Integrations() {
  const { t, nm, date } = useI18n();
  const [list, setList] = useState<Connector[] | null>(null);
  const [types, setTypes] = useState<ConnectorType[]>([]);
  useEffect(() => {
    api<Connector[]>('/integrations').then(setList);
    api<ConnectorType[]>('/integrations/types').then(setTypes);
  }, []);
  const typeName = (k: string) => nm(types.find((x) => x.type === k)) || k;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('int.title')}</h1>
          <p>{t('int.subtitle')}</p>
        </div>
        <Link className="btn primary" href="/integrations/new">{t('int.add')}</Link>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>{t('common.name')}</th><th>{t('int.type')}</th><th>{t('int.schedule')}</th><th>{t('int.lastRun')}</th><th className="num">{t('int.created')}</th><th className="num">{t('int.updated')}</th><th className="num">{t('int.conflicts')}</th></tr></thead>
        <tbody>{list?.map((c) => (
          <tr key={c.id}>
            <td><Link href={`/integrations/${c.id}`}>{c.name}</Link>{!c.enabled && <span className="status st-archived" style={{ marginInlineStart: 6 }}>{t('int.disabled')}</span>}</td>
            <td>{typeName(c.type)}</td>
            <td>{c.schedule_minutes ? t(`int.every.${c.schedule_minutes}`) : t('int.manualOnly')}</td>
            <td>{c.last_run ? <><span className={c.last_run.status === 'failed' ? 'run-failed' : 'run-ok'}>{t(`int.status.${c.last_run.status}`)}</span> <span className="hint">{date(c.last_run.started_at)}</span></> : <span className="hint">{t('int.never')}</span>}</td>
            <td className="num">{c.last_run?.created ?? '—'}</td>
            <td className="num">{c.last_run?.updated ?? '—'}</td>
            <td className="num">{c.last_run?.conflicts || '—'}</td>
          </tr>))}
        </tbody>
      </table>
      {list?.length === 0 && <div className="empty">{t('int.empty')}</div>}
      </div>
    </>
  );
}
