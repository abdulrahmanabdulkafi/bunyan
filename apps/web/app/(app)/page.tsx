'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, can } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Dash {
  blocks: { code: string; name_ar: string; domain: string; total: number; approved: number; pending: number; completeness: number; orphans: number }[];
  alerts: { id: string; name: string; block: string; kind: string; date?: string }[];
}

export default function Dashboard() {
  const { user, model } = useSession();
  const router = useRouter();
  const [d, setD] = useState<Dash | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!can(user, 'records.read')) { router.replace(can(user, 'dashboard.national') ? '/national' : '/studio'); return; }
    api<Dash>('/viewpoints/dashboard').then(setD);
  }, [user, router]);

  if (!d || !model) return <p className="hint">جارٍ التحميل…</p>;
  const total = d.blocks.reduce((s, b) => s + b.total, 0);
  const approved = d.blocks.reduce((s, b) => s + b.approved, 0);
  const pending = d.blocks.reduce((s, b) => s + b.pending, 0);
  const filled = d.blocks.filter((b) => b.total);
  const avg = filled.length ? filled.reduce((s, b) => s + b.completeness, 0) / filled.length : 0;
  const blockName = (c: string) => model.blocks.find((b) => b.code === c)?.name_ar ?? c;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>لوحة البنية المؤسسية</h1>
          <p>حالة مستودع الجهة في مجالات التطبيقات والتقنية والأمن السيبراني.</p>
        </div>
      </div>

      <div className="figures">
        <div className="figure"><b>{total}</b><span>سجل في المستودع</span></div>
        <div className="figure"><b>{total ? Math.round((approved / total) * 100) : 0}٪</b><span>معتمد نهائياً</span></div>
        <div className="figure"><b>{pending}</b><span>بانتظار الاعتماد</span></div>
        <div className="figure"><b>{Math.round(avg * 100)}٪</b><span>متوسط اكتمال السمات</span></div>
      </div>

      <section className="section">
        <h2>تنبيهات دورة الحياة</h2>
        {d.alerts.length === 0 ? <p className="hint">لا توجد عناصر انتهى دعمها أو اقترب انتهاؤه خلال ١٨٠ يوماً.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>العنصر</th><th>الوحدة</th><th>التاريخ</th><th>الحالة</th></tr></thead>
            <tbody>{d.alerts.map((a) => (
              <tr key={a.id + a.date}>
                <td><Link href={`/records/${a.id}`}>{a.name}</Link></td>
                <td>{blockName(a.block)}</td>
                <td dir="ltr" style={{ textAlign: 'end' }}>{a.date}</td>
                <td className={`alert-${a.kind}`}>{a.kind === 'expired' ? 'انتهى الدعم أو الترخيص' : 'ينتهي قريباً'}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="section">
        <h2>المخزون حسب وحدة البناء</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>وحدة البناء</th><th className="num">السجلات</th><th className="num">معتمد</th><th className="num">بانتظار الاعتماد</th><th className="num">بلا علاقات</th><th>الاكتمال</th></tr></thead>
          <tbody>{d.blocks.map((b) => (
            <tr key={b.code}>
              <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${b.domain})` }} /><Link href={`/repo/${b.code}`}>{b.name_ar}</Link></td>
              <td className="num">{b.total}</td>
              <td className="num">{b.approved}</td>
              <td className="num">{b.pending || '—'}</td>
              <td className="num">{b.orphans || '—'}</td>
              <td>{b.total ? <>{Math.round(b.completeness * 100)}٪<span className={`gauge${b.completeness < 0.5 ? ' low' : ''}`}><i style={{ width: `${b.completeness * 100}%` }} /></span></> : <span className="hint">لا توجد سجلات</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
