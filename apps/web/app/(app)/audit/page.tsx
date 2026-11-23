'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Ev { id: number; action: string; entity: string; entity_id: string; user_name: string | null; at: string }

export default function Audit() {
  const { t, date } = useI18n();
  const [rows, setRows] = useState<Ev[] | null>(null);
  useEffect(() => { api<Ev[]>('/approvals/audit').then(setRows); }, []);
  const label = (prefix: string, k: string) => { const s = t(`${prefix}.${k}`); return s === `${prefix}.${k}` ? k : s; };
  return (
    <>
      <div className="page-head"><div><h1>{t('audit.title')}</h1><p>{t('audit.subtitle')}</p></div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>{t('audit.time')}</th><th>{t('audit.user')}</th><th>{t('audit.action')}</th><th>{t('audit.item')}</th></tr></thead>
        <tbody>{rows?.map((r) => (
          <tr key={r.id}><td>{date(r.at)}</td><td>{r.user_name ?? t('audit.system')}</td><td>{label('act', r.action)}</td>
            <td>{label('ent', r.entity)} {r.entity === 'record' ? <a href={`/records/${r.entity_id}`}>{t('audit.open')}</a> : <span className="hint" dir="ltr">{r.entity_id}</span>}</td></tr>))}
        </tbody>
      </table></div>
    </>
  );
}
