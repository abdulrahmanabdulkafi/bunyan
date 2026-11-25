'use client';
import { useState } from 'react';
import { api, Attr, Block } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

const TYPES = ['text', 'multi_text', 'number', 'date', 'enum', 'url', 'duration'];
type Opt = { value: string; label_ar?: string; label_en?: string };
/** Values typed as a list; a value that matches an existing option (by label in either language or by value) keeps its labels. */
const toOptions = (s: string, prev: Opt[] = []) => s.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).map((v): Opt =>
  prev.find((o) => o.value === v || o.label_ar === v || o.label_en?.toLowerCase() === v.toLowerCase()) ?? { value: v });

export default function Studio() {
  const { model, reloadModel } = useSession();
  const { t, nm } = useI18n();
  const [sel, setSel] = useState('application');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [na, setNa] = useState({ key: '', name_ar: '', name_en: '', type: 'text', options: '', multiple: false });
  if (!model) return null;
  const block = model.blocks.find((b) => b.code === sel);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); await reloadModel(); setMsg({ kind: 'ok', text: ok }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }
  const patchAttr = (a: Attr, body: object) => run(() => api(`/metamodel/blocks/${sel}/attributes/${a.key}`, { method: 'PATCH', json: body }), t('studio.attrUpdated', { name: nm(a) }));

  return (
    <>
      <div className="page-head"><div>
        <h1>{t('studio.title')}</h1>
        <p>{t('studio.subtitle')}</p>
      </div></div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}

      <section className="section">
        <h2>{t('studio.domains')}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>{t('studio.domain')}</th><th className="num">{t('studio.blocks')}</th><th>{t('studio.stateInEntity')}</th></tr></thead>
          <tbody>{model.domains.map((d) => (
            <tr key={d.code}>
              <td><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${d.code})` }} />{nm(d)}</td>
              <td className="num">{model.blocks.filter((b) => b.domain_code === d.code).length}</td>
              <td><label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={d.active} onChange={(e) => run(() => api(`/metamodel/domains/${d.code}`, { method: 'PATCH', json: { active: e.target.checked } }), t(e.target.checked ? 'studio.domainOn' : 'studio.domainOff', { name: nm(d) }))} />
                {t(d.active ? 'studio.active' : 'studio.inactive')}</label></td>
            </tr>))}
          </tbody>
        </table></div>
      </section>

      <section className="section">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
          <h2>{t('studio.attributes')}</h2>
          <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 300 }} aria-label={t('common.block')}>
            {model.domains.map((d) => (
              <optgroup key={d.code} label={nm(d)}>
                {model.blocks.filter((b) => b.domain_code === d.code).map((b) => <option key={b.code} value={b.code}>{nm(b)}{b.active ? '' : ` (${t('studio.inactive')})`}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t('studio.listsHint')}</p>
        {block && <BlockEditor block={block} patchAttr={patchAttr} run={run} />}

        {block && (
          <div style={{ marginTop: 'var(--s-5)' }}>
            <h3 style={{ marginBottom: 'var(--s-3)' }}>{t('studio.addAttr')}</h3>
            <div className="form-grid">
              <label className="field">{t('studio.nameAr')}<input dir="rtl" value={na.name_ar} onChange={(e) => setNa({ ...na, name_ar: e.target.value })} /></label>
              <label className="field">{t('studio.nameEn')}<input dir="ltr" value={na.name_en} onChange={(e) => setNa({ ...na, name_en: e.target.value })} /></label>
              <label className="field">{t('studio.key')}<input dir="ltr" placeholder="hosting_zone" value={na.key} onChange={(e) => setNa({ ...na, key: e.target.value })} />
                <span className="hint">{t('studio.keyHint')}</span></label>
              <label className="field">{t('studio.type')}<select value={na.type} onChange={(e) => setNa({ ...na, type: e.target.value })}>{TYPES.map((k) => <option key={k} value={k}>{t(`type.${k}`)}</option>)}</select></label>
              {na.type === 'enum' && <label className="field wide">{t('studio.suggestions')}<input value={na.options} onChange={(e) => setNa({ ...na, options: e.target.value })} /></label>}
              {(na.type === 'enum' || na.type === 'text') && (
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={na.multiple} onChange={(e) => setNa({ ...na, multiple: e.target.checked })} />{t('studio.multiple')}</label>
              )}
            </div>
            <button className="btn primary" style={{ marginTop: 'var(--s-3)' }} disabled={!na.key || !na.name_ar || !na.name_en}
              onClick={() => run(() => api(`/metamodel/blocks/${sel}/attributes`, { method: 'POST', json: { key: na.key, name_ar: na.name_ar, name_en: na.name_en, type: na.type, options: toOptions(na.options), multiple: na.multiple } })
                .then(() => setNa({ key: '', name_ar: '', name_en: '', type: 'text', options: '', multiple: false })), t('studio.attrAdded'))}>{t('studio.addAttrButton')}</button>
          </div>
        )}
      </section>
    </>
  );
}

function BlockEditor({ block, patchAttr, run }: { block: Block; patchAttr: (a: Attr, b: object) => void; run: (fn: () => Promise<unknown>, ok: string) => void }) {
  const { t, nm, locale } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  const [opts, setOpts] = useState('');
  const listable = (a: Attr) => a.type === 'enum' || a.type === 'text';
  return (
    <>
      <p className="row" style={{ marginBottom: 'var(--s-3)' }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={block.active} onChange={(e) => run(() => api(`/metamodel/blocks/${block.code}`, { method: 'PATCH', json: { active: e.target.checked } }), t('studio.blockUpdated'))} />
          {t('studio.blockActive')}
        </label>
        <span className="hint">{locale === 'ar' ? block.name_en : block.name_ar}</span>
      </p>
      <div className="table-wrap"><table>
        <thead><tr><th>{t('studio.attribute')}</th><th>{t('studio.type')}</th><th>{t('studio.values')}</th><th>{t('studio.multipleShort')}</th><th>{t('studio.strictShort')}</th><th>{t('studio.required')}</th><th>{t('studio.activeShort')}</th><th /></tr></thead>
        <tbody>{block.attributes.map((a) => (
          <tr key={a.key} style={a.active ? undefined : { color: 'var(--ink-3)' }}>
            <td>{nm(a)} <span className="hint">{locale === 'ar' ? a.name_en : a.name_ar}</span>{a.is_custom && <span className="status st-reviewed" style={{ marginInlineStart: 6 }}>{t('studio.custom')}</span>}</td>
            <td>{t(`type.${a.type}`)}</td>
            <td>{a.type !== 'enum' ? '—' : editing === a.key ? (
              <span className="row"><input value={opts} onChange={(e) => setOpts(e.target.value)} style={{ maxWidth: 260 }} aria-label={t('studio.values')} />
                <button className="btn primary" onClick={() => { patchAttr(a, { options: toOptions(opts, a.options) }); setEditing(null); }}>{t('common.save')}</button></span>
            ) : (a.options.length ? a.options.map((o) => nm(o, 'label') || o.value).join(t('list.sep')) : <span className="hint">{t('studio.noValues')}</span>)}</td>
            <td><input type="checkbox" checked={a.multiple || a.type === 'multi_text'} disabled={!listable(a) || a.key === block.title_key} onChange={(e) => patchAttr(a, { multiple: e.target.checked })} aria-label={`${t('studio.multipleShort')} ${nm(a)}`} /></td>
            <td><input type="checkbox" checked={a.strict} disabled={a.type !== 'enum' || !a.options.length} onChange={(e) => patchAttr(a, { strict: e.target.checked })} aria-label={`${t('studio.strictShort')} ${nm(a)}`} title={t('studio.strictHint')} /></td>
            <td><input type="checkbox" checked={a.required} disabled={a.key === block.title_key} onChange={(e) => patchAttr(a, { required: e.target.checked })} aria-label={`${t('studio.required')} ${nm(a)}`} /></td>
            <td><input type="checkbox" checked={a.active} disabled={a.key === block.title_key} onChange={(e) => patchAttr(a, { active: e.target.checked })} aria-label={`${t('studio.activeShort')} ${nm(a)}`} /></td>
            <td>{a.type === 'enum' && editing !== a.key && <button className="btn quiet" onClick={() => { setEditing(a.key); setOpts(a.options.map((o) => nm(o, 'label') || o.value).join(t('list.sep'))); }}>{t('studio.editValues')}</button>}</td>
          </tr>))}
        </tbody>
      </table></div>
    </>
  );
}
