'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '@/lib/api';

interface Ev { id: number; action: string; entity: string; entity_id: string; user_name: string | null; at: string }

const ACTIONS: Record<string, string> = {
  login: 'دخول', create: 'إنشاء', update: 'تعديل', submit: 'إرسال للمراجعة', review: 'اعتماد مبدئي', approve: 'اعتماد نهائي',
  reject: 'رفض', archive: 'أرشفة', restore: 'استعادة', link: 'ربط', unlink: 'إزالة ربط', 'metamodel.change': 'تعديل النموذج',
};
const ENTITIES: Record<string, string> = { record: 'سجل', record_link: 'علاقة', user: 'مستخدم', tenant: 'جهة', mm_domain: 'مجال', mm_block: 'وحدة بناء', mm_attribute: 'سمة', mm_relation: 'تعريف علاقة' };

export default function Audit() {
  const [rows, setRows] = useState<Ev[] | null>(null);
  useEffect(() => { api<Ev[]>('/approvals/audit').then(setRows); }, []);
  return (
    <>
      <div className="page-head"><div><h1>سجل التدقيق</h1><p>آخر ٥٠٠ حدث في جهتك. السجل للإضافة فقط ولا يمكن تعديله أو حذفه.</p></div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>العنصر</th></tr></thead>
        <tbody>{rows?.map((r) => (
          <tr key={r.id}><td>{fmtDate(r.at)}</td><td>{r.user_name ?? '—'}</td><td>{ACTIONS[r.action] ?? r.action}</td>
            <td>{ENTITIES[r.entity] ?? r.entity} {r.entity === 'record' ? <a href={`/records/${r.entity_id}`}>فتح</a> : <span className="hint" dir="ltr">{r.entity_id}</span>}</td></tr>))}
        </tbody>
      </table></div>
    </>
  );
}
