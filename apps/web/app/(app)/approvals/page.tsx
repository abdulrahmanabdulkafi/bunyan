'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, STATUS } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Item { id: string; name: string; block_code: string; status: string; updated_at: string; updated_by: string; updated_by_name: string }

export default function Approvals() {
  const { model, user } = useSession();
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => { api<Item[]>('/approvals/queue').then(setItems); }, []);
  const blockName = (c: string) => model?.blocks.find((b) => b.code === c)?.name_ar ?? c;

  return (
    <>
      <div className="page-head"><div>
        <h1>طلبات الاعتماد</h1>
        <p>السجلات التي تنتظر اعتمادك المبدئي أو النهائي ضمن نطاق صلاحياتك.</p>
      </div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>السجل</th><th>الوحدة</th><th>المرحلة</th><th>آخر تعديل بواسطة</th><th>منذ</th></tr></thead>
        <tbody>{items?.map((i) => (
          <tr key={i.id}>
            <td><Link href={`/records/${i.id}`}>{i.name}</Link></td>
            <td>{blockName(i.block_code)}</td>
            <td><span className={`status st-${i.status}`}>{STATUS[i.status]}</span></td>
            <td>{i.updated_by_name}{i.updated_by === user?.id && <span className="hint"> (أنت — يعتمده غيرك)</span>}</td>
            <td>{fmtDate(i.updated_at)}</td>
          </tr>))}
        </tbody>
      </table>
      {items?.length === 0 && <div className="empty">لا توجد طلبات بانتظارك.</div>}
      </div>
    </>
  );
}
