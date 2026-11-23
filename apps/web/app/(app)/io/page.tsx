'use client';
import { useState } from 'react';
import { api, ApiError, canInScope, download } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Report { dryRun: boolean; created: number; updated: number; errors: { sheet: string; row: number; key?: string; message: string }[] }

export default function ImportExport() {
  const { user, model, reloadModel } = useSession();
  const [chosen, setChosen] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!model) return null;
  const blocks = model.blocks.filter((b) => b.active && canInScope(user, 'records.import', b));
  const attrName = (sheet: string, key?: string) => {
    if (!key) return '';
    for (const b of model.blocks) { const a = b.attributes.find((x) => x.key === key); if (a && sheet.startsWith(b.name_ar.slice(0, 20))) return a.name_ar; }
    return key;
  };

  async function upload(dry: boolean) {
    if (!file) return;
    setBusy(true); setErr(''); setReport(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      setReport(await api<Report>(`/io/import${dry ? '?dryRun=true' : ''}`, { method: 'POST', body: fd }));
      if (!dry) reloadModel();
    } catch (e) {
      if (e instanceof ApiError && (e.body as Report)?.errors) setReport(e.body as Report);
      else setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><div>
        <h1>الاستيراد والتصدير</h1>
        <p>نزّل القالب المطابق للنموذج المعتمد في جهتك، عبّئه، ثم ارفعه. لا يُحفظ أي سجل إن وُجد خطأ في أي صف.</p>
      </div></div>

      <section className="section">
        <h2>١. تنزيل القالب</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>اختر وحدات البناء؛ كل وحدة في ورقة مستقلة بأسماء السمات العربية وقوائم القيم المعتمدة.</p>
        <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
          {blocks.map((b) => (
            <label key={b.code} className="row" style={{ gap: 6, fontSize: 14, minWidth: 200 }}>
              <input type="checkbox" checked={chosen.includes(b.code)} onChange={(e) => setChosen(e.target.checked ? [...chosen, b.code] : chosen.filter((c) => c !== b.code))} />
              {b.name_ar}
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn" disabled={!chosen.length} onClick={() => download(`/io/export?blocks=${chosen.join(',')}`, 'bunyan-template.xlsx')}>تنزيل قالب فارغ</button>
          <button className="btn" disabled={!chosen.length} onClick={() => download(`/io/export?blocks=${chosen.join(',')}&withData=true`, 'bunyan-data.xlsx')}>تنزيل مع البيانات الحالية</button>
        </div>
      </section>

      <section className="section">
        <h2>٢. رفع الملف</h2>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>الصفوف التي تحمل معرّفاً تُحدّث سجلاتها، والصفوف الجديدة تُنشأ مسودات بانتظار الاعتماد.</p>
        <div className="row">
          <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }} style={{ maxWidth: 360 }} aria-label="ملف Excel" />
          <button className="btn" disabled={!file || busy} onClick={() => upload(true)}>فحص دون حفظ</button>
          <button className="btn primary" disabled={!file || busy} onClick={() => upload(false)}>استيراد</button>
        </div>
        {err && <div className="banner error" style={{ marginTop: 'var(--s-3)' }}>{err}</div>}
        {report && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            {report.errors.length ? (
              <>
                <div className="banner error">لم يُحفظ أي سجل: {report.errors.length} خطأ. صحّحها في الملف ثم أعد رفعه.</div>
                <div className="table-wrap"><table>
                  <thead><tr><th>الورقة</th><th className="num">الصف</th><th>السمة</th><th>الخطأ</th></tr></thead>
                  <tbody>{report.errors.map((e, i) => <tr key={i}><td>{e.sheet}</td><td className="num">{e.row}</td><td>{attrName(e.sheet, e.key)}</td><td>{e.message}</td></tr>)}</tbody>
                </table></div>
              </>
            ) : (
              <div className="banner ok">{report.dryRun ? `الملف سليم: سيُنشأ ${report.created} ويُحدَّث ${report.updated} سجل.` : `استُورد الملف: أُنشئ ${report.created} وحُدّث ${report.updated} سجل.`}</div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
