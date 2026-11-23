'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Item { id: string; name: string; block_code: string; status: string; updated_at: string; updated_by: string; updated_by_name: string | null }

export default function Approvals() {
  const { model, user } = useSession();
  const { t, nm, date } = useI18n();
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => { api<Item[]>('/approvals/queue').then(setItems); }, []);
  const blockName = (c: string) => nm(model?.blocks.find((b) => b.code === c));

  return (
    <>
      <div className="page-head"><div>
        <h1>{t('appr.title')}</h1>
        <p>{t('appr.subtitle')}</p>
      </div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>{t('appr.record')}</th><th>{t('common.block')}</th><th>{t('appr.stage')}</th><th>{t('appr.lastEditedBy')}</th><th>{t('appr.since')}</th></tr></thead>
        <tbody>{items?.map((i) => (
          <tr key={i.id}>
            <td><Link href={`/records/${i.id}`}>{i.name}</Link></td>
            <td>{blockName(i.block_code)}</td>
            <td><span className={`status st-${i.status}`}>{t(`status.${i.status}`)}</span></td>
            <td>{i.updated_by_name ?? t('appr.system')}{i.updated_by === user?.id && <span className="hint"> {t('appr.you')}</span>}</td>
            <td>{date(i.updated_at)}</td>
          </tr>))}
        </tbody>
      </table>
      {items?.length === 0 && <div className="empty">{t('appr.empty')}</div>}
      </div>
    </>
  );
}
