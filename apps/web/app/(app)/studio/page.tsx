'use client';
import { useState } from 'react';
import { api, Attr, Block } from '@/lib/api';
import { useSession } from '@/lib/session';

const TYPES: Record<string, string> = { text: 'نص', multi_text: 'قائمة نصوص', number: 'رقم', date: 'تاريخ', enum: 'قائمة معرّفة مسبقاً', url: 'رابط', duration: 'مدة زمنية' };

export default function Studio() {
  const { model, reloadModel } = useSession();
  const [sel, setSel] = useState('application');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [na, setNa] = useState({ key: '', name_ar: '', name_en: '', type: 'text', options: '' });
  if (!model) return null;
  const block = model.blocks.find((b) => b.code === sel);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); await reloadModel(); setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }
  const patchAttr = (a: Attr, body: object) => run(() => api(`/metamodel/blocks/${sel}/attributes/${a.key}`, { method: 'PATCH', json: body }), `حُدّثت السمة «${a.name_ar}».`);
  const toOptions = (s: string) => s.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).map((value) => ({ value }));

  return (
    <>
      <div className="page-head"><div>
        <h1>تهيئة النموذج</h1>
        <p>النموذج مبني على النموذج العام لمحتوى البنية المؤسسية. عطّل ما لا يلزم جهتك أو أضف سمات خاصة؛ سمات النموذج الوطني تُعطَّل ولا تُحذف حفاظاً على قابلية المقارنة.</p>
      </div></div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}

      <section className="section">
        <h2>المجالات</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>المجال</th><th className="num">وحدات البناء</th><th>الحالة في جهتك</th></tr></thead>
          <tbody>{model.domains.map((d) => (
            <tr key={d.code}>
              <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${d.code})` }} />{d.name_ar}</td>
              <td className="num">{model.blocks.filter((b) => b.domain_code === d.code).length}</td>
              <td><label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={d.active} onChange={(e) => run(() => api(`/metamodel/domains/${d.code}`, { method: 'PATCH', json: { active: e.target.checked } }), e.target.checked ? `فُعّل مجال ${d.name_ar}.` : `عُطّل مجال ${d.name_ar}.`)} />
                {d.active ? 'مفعّل' : 'غير مفعّل'}</label></td>
            </tr>))}
          </tbody>
        </table></div>
      </section>

      <section className="section">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
          <h2>سمات وحدة البناء</h2>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 300 }} aria-label="وحدة البناء">
            {model.domains.map((d) => (
              <optgroup key={d.code} label={d.name_ar}>
                {model.blocks.filter((b) => b.domain_code === d.code).map((b) => <option key={b.code} value={b.code}>{b.name_ar}{b.active ? '' : ' (غير مفعّلة)'}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {block && <BlockEditor block={block} patchAttr={patchAttr} run={run} />}

        {block && (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <h3 style={{ marginBottom: 'var(--s-3)' }}>إضافة سمة خاصة بالجهة</h3>
            <div className="form-grid">
              <label className="field">الاسم بالعربية<input value={na.name_ar} onChange={(e) => setNa({ ...na, name_ar: e.target.value })} /></label>
              <label className="field">الاسم بالإنجليزية<input dir="ltr" value={na.name_en} onChange={(e) => setNa({ ...na, name_en: e.target.value })} /></label>
              <label className="field">المفتاح التقني<input dir="ltr" placeholder="hosting_zone" value={na.key} onChange={(e) => setNa({ ...na, key: e.target.value })} />
                <span className="hint">حروف إنجليزية صغيرة وشرطة سفلية</span></label>
              <label className="field">النوع<select value={na.type} onChange={(e) => setNa({ ...na, type: e.target.value })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              {na.type === 'enum' && <label className="field wide">القيم المسموحة (مفصولة بفاصلة)<input value={na.options} onChange={(e) => setNa({ ...na, options: e.target.value })} /></label>}
            </div>
            <button className="btn primary" style={{ marginTop: 'var(--s-3)' }} disabled={!na.key || !na.name_ar || !na.name_en}
              onClick={() => run(() => api(`/metamodel/blocks/${sel}/attributes`, { method: 'POST', json: { key: na.key, name_ar: na.name_ar, name_en: na.name_en, type: na.type, options: toOptions(na.options) } })
                .then(() => setNa({ key: '', name_ar: '', name_en: '', type: 'text', options: '' })), 'أُضيفت السمة.')}>إضافة السمة</button>
          </div>
        )}
      </section>
    </>
  );
}

function BlockEditor({ block, patchAttr, run }: { block: Block; patchAttr: (a: Attr, b: object) => void; run: (fn: () => Promise<unknown>, ok: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [opts, setOpts] = useState('');
  return (
    <>
      <p className="row" style={{ marginBottom: 'var(--s-3)' }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={block.active} onChange={(e) => run(() => api(`/metamodel/blocks/${block.code}`, { method: 'PATCH', json: { active: e.target.checked } }), 'حُدّثت حالة وحدة البناء.')} />
          وحدة البناء مفعّلة في جهتك
        </label>
        <span className="hint">{block.name_en}</span>
      </p>
      <div className="table-wrap"><table>
        <thead><tr><th>السمة</th><th>النوع</th><th>القيم المعرّفة</th><th>إلزامية</th><th>مفعّلة</th><th /></tr></thead>
        <tbody>{block.attributes.map((a) => (
          <tr key={a.key} style={a.active ? undefined : { color: 'var(--ink-3)' }}>
            <td>{a.name_ar} <span className="hint" dir="ltr">{a.name_en}</span>{a.is_custom && <span className="status st-reviewed" style={{ marginInlineStart: 6 }}>خاصة بالجهة</span>}</td>
            <td>{TYPES[a.type] ?? a.type}</td>
            <td>{a.type !== 'enum' ? '—' : editing === a.key ? (
              <span className="row"><input value={opts} onChange={(e) => setOpts(e.target.value)} style={{ maxWidth: 260 }} aria-label="القيم" />
                <button className="btn primary" onClick={() => { patchAttr(a, { options: opts.split(/[,،]/).map((x) => x.trim()).filter(Boolean).map((value) => ({ value })) }); setEditing(null); }}>حفظ</button></span>
            ) : (a.options.length ? a.options.map((o) => o.value).join('، ') : <span className="hint">لم تُعرّف — تقبل أي قيمة</span>)}</td>
            <td><input type="checkbox" checked={a.required} disabled={a.key === block.title_key} onChange={(e) => patchAttr(a, { required: e.target.checked })} aria-label={`إلزامية ${a.name_ar}`} /></td>
            <td><input type="checkbox" checked={a.active} disabled={a.key === block.title_key} onChange={(e) => patchAttr(a, { active: e.target.checked })} aria-label={`تفعيل ${a.name_ar}`} /></td>
            <td>{a.type === 'enum' && editing !== a.key && <button className="btn quiet" onClick={() => { setEditing(a.key); setOpts(a.options.map((o) => o.value).join('، ')); }}>تعريف القيم</button>}</td>
          </tr>))}
        </tbody>
      </table></div>
    </>
  );
}
