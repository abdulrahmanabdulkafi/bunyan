'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Entity { id: string; tenant: string; total: number; approved: number; approvedRatio: number; domains: Record<string, number> }
interface Nat { scope: 'national' | 'sector' | 'entity'; average: number; entities: Entity[] | number; mine?: Entity | null }

const DOMS: [string, string][] = [['applications', 'التطبيقات'], ['technology', 'التقنية'], ['security', 'الأمن السيبراني']];
const pct = (x: number) => `${Math.round(x * 100)}٪`;

export default function National() {
  const [d, setD] = useState<Nat | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Nat>('/viewpoints/national').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <p className="hint">جارٍ التحميل…</p>;

  if (d.scope === 'entity') {
    return (
      <>
        <div className="page-head"><div><h1>موقع جهتك وطنياً</h1><p>مقارنة نسبة السجلات المعتمدة في جهتك بمتوسط {d.entities as number} جهة. لا تُعرض بيانات الجهات الأخرى.</p></div></div>
        <div className="figures">
          <div className="figure"><b>{pct(d.mine?.approvedRatio ?? 0)}</b><span>نسبة الاعتماد في جهتك</span></div>
          <div className="figure"><b>{pct(d.average)}</b><span>المتوسط الوطني</span></div>
        </div>
      </>
    );
  }
  const list = (d.entities as Entity[]).slice().sort((a, b) => b.approvedRatio - a.approvedRatio);
  return (
    <>
      <div className="page-head"><div>
        <h1>{d.scope === 'national' ? 'اللوحة الوطنية' : 'لوحة المكتب القطاعي'}</h1>
        <p>مؤشرات مجمّعة لكل جهة؛ لا تتضمن أي سجل تفصيلي.</p>
      </div></div>
      <div className="figures">
        <div className="figure"><b>{list.length}</b><span>جهة لديها بيانات</span></div>
        <div className="figure"><b>{pct(d.average)}</b><span>متوسط نسبة الاعتماد</span></div>
      </div>
      <div className="section table-wrap"><table>
        <thead><tr><th>الجهة</th>{DOMS.map(([, n]) => <th key={n} className="num">{n}</th>)}<th className="num">الإجمالي</th><th>نسبة الاعتماد</th></tr></thead>
        <tbody>{list.map((e) => (
          <tr key={e.id}><td>{e.tenant}</td>
            {DOMS.map(([k]) => <td key={k} className="num">{e.domains[k] ?? 0}</td>)}
            <td className="num">{e.total}</td>
            <td>{pct(e.approvedRatio)}<span className={`gauge${e.approvedRatio < 0.5 ? ' low' : ''}`}><i style={{ width: `${e.approvedRatio * 100}%` }} /></span></td>
          </tr>))}
        </tbody>
      </table></div>
    </>
  );
}
