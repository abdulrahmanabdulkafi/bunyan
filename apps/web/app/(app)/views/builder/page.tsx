'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, can } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { Render, Result } from '@/lib/ViewpointRender';

type Kind = 'list' | 'matrix' | 'group' | 'nest' | 'graph';
type By = 'attr' | 'related' | 'block';
interface Draft {
  name_ar: string; name_en: string; purpose_ar: string; purpose_en: string; domain: string; kind: Kind;
  a: string[]; b: string[]; via: string[]; columns: string[]; by: By; byAttr: string; byRelated: string; collapse: string;
}
const EMPTY: Draft = { name_ar: '', name_en: '', purpose_ar: '', purpose_en: '', domain: 'applications', kind: 'matrix', a: [], b: [], via: [], columns: [], by: 'attr', byAttr: '', byRelated: '', collapse: '' };
const KINDS: Kind[] = ['list', 'matrix', 'group', 'nest', 'graph'];

/** Draft → the declarative spec the engine runs (same shape as the national catalogue). */
function specOf(d: Draft): object | null {
  switch (d.kind) {
    case 'list': return d.a.length ? { kind: 'list', blocks: d.a.slice(0, 1), columns: d.columns } : null;
    case 'matrix': return d.a.length && d.b.length ? { kind: 'matrix', rows: d.a, cols: d.b, ...(d.via.length ? { via: d.via } : {}) } : null;
    case 'group': {
      if (!d.a.length) return null;
      const by = d.by === 'block' ? { block: true } : d.by === 'attr' ? (d.byAttr ? { attr: d.byAttr } : null) : (d.byRelated ? { related: d.byRelated } : null);
      return by && { kind: 'group', blocks: d.a, by };
    }
    case 'nest': return d.a.length && d.b.length ? { kind: 'nest', container: d.a[0], children: d.b } : null;
    case 'graph': return d.a.length ? { kind: 'graph', blocks: d.a, ...(d.collapse ? { collapse: d.collapse } : {}) } : null;
  }
}
function draftOf(row: { name_ar: string; name_en: string; purpose_ar: string | null; purpose_en: string | null; domain: string; spec: Record<string, any> }): Draft {
  const s = row.spec, d: Draft = { ...EMPTY, name_ar: row.name_ar, name_en: row.name_en, purpose_ar: row.purpose_ar ?? '', purpose_en: row.purpose_en ?? '', domain: row.domain, kind: s.kind };
  if (s.kind === 'list') return { ...d, a: s.blocks, columns: s.columns ?? [] };
  if (s.kind === 'matrix') return { ...d, a: s.rows, b: s.cols, via: s.via ?? [] };
  if (s.kind === 'nest') return { ...d, a: [s.container], b: s.children };
  if (s.kind === 'graph') return { ...d, a: s.blocks, collapse: s.collapse ?? '' };
  return { ...d, a: s.blocks, by: 'block' in s.by ? 'block' : 'attr' in s.by ? 'attr' : 'related', byAttr: s.by.attr ?? '', byRelated: s.by.related ?? '' };
}

export default function Page() { return <Suspense><Builder /></Suspense>; }

function Builder() {
  const { model, user } = useSession();
  const { t, nm, locale } = useI18n();
  const router = useRouter();
  const editing = useSearchParams().get('code');
  const [d, setD] = useState<Draft>(EMPTY);
  const [preview, setPreview] = useState<Result | { missing: string[] } | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  useEffect(() => { if (editing) api<Parameters<typeof draftOf>[0]>(`/viewpoints/custom/${editing}`).then((r) => setD(draftOf(r))).catch((e) => setErr(e.message)); }, [editing]);
  const spec = useMemo(() => specOf(d), [d]);
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    setErr('');
    if (!spec) { setPreview(null); return; }
    const timer = setTimeout(() => api<Result>('/viewpoints/preview', { method: 'POST', json: { spec } }).then(setPreview).catch((e) => setErr(e.message)), 300);
    return () => clearTimeout(timer);
  }, [specKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!model) return <p className="hint">{t('common.loading')}</p>;
  if (!can(user, 'viewpoints.build')) return <div className="banner error">{t('vb.noAccess')}</div>;
  const blocks = model.blocks.filter((b) => b.active);
  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c)) || c;
  const attrsOf = (codes: string[]) => {
    const lists = codes.map((c) => model.blocks.find((b) => b.code === c)?.attributes.filter((a) => a.active) ?? []);
    return lists.length ? lists[0].filter((a) => lists.every((l) => l.some((x) => x.key === a.key))) : [];
  };
  const listBlock = model.blocks.find((b) => b.code === d.a[0]);
  const listAttrs = d.kind === 'list' && listBlock ? listBlock.attributes.filter((a) => a.active && a.key !== listBlock.title_key) : [];
  const groupAttrs = attrsOf(d.a).filter((a) => a.type === 'enum' || a.options.length > 0 || a.type === 'text');
  const slots: Record<Kind, { key: 'a' | 'b' | 'via'; label: string; max?: number }[]> = {
    list: [{ key: 'a', label: t('vb.slot.listBlock'), max: 1 }],
    matrix: [{ key: 'a', label: t('vb.slot.rows') }, { key: 'b', label: t('vb.slot.cols') }, { key: 'via', label: t('vb.slot.via') }],
    group: [{ key: 'a', label: t('vb.slot.items') }],
    nest: [{ key: 'a', label: t('vb.slot.container'), max: 1 }, { key: 'b', label: t('vb.slot.children') }],
    graph: [{ key: 'a', label: t('vb.slot.graph') }],
  };

  async function save() {
    setErr('');
    const json = { name_ar: d.name_ar, name_en: d.name_en, purpose_ar: d.purpose_ar || null, purpose_en: d.purpose_en || null, domain: d.domain, spec };
    try {
      const r = editing
        ? await api<{ code: string }>(`/viewpoints/custom/${editing}`, { method: 'PATCH', json })
        : await api<{ code: string }>('/viewpoints/custom', { method: 'POST', json });
      router.push(`/views/${r.code}`);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href="/views">{t('vp.title')}</Link>{editing && <span className="hint" dir="ltr"> {editing}</span>}</p>
          <h1>{editing ? t('vb.editTitle') : t('vb.title')}</h1>
          <p style={{ maxWidth: 720 }}>{t('vb.subtitle')}</p>
        </div>
        <div className="row">
          {editing && <button className="btn danger" onClick={async () => { if (!confirm(t('vb.deleteConfirm'))) return; await api(`/viewpoints/custom/${editing}`, { method: 'DELETE' }); router.push('/views'); }}>{t('vb.delete')}</button>}
          <button className="btn primary" disabled={!spec || d.name_ar.trim().length < 2 || d.name_en.trim().length < 2} onClick={save}>{t('vb.save')}</button>
        </div>
      </div>
      {err && <div className="banner error">{err}</div>}

      <div className="builder">
        <aside className="palette" aria-label={t('vb.palette')}>
          <h3>{t('vb.palette')}</h3>
          <p className="hint">{t('vb.paletteHint')}</p>
          <input type="search" placeholder={t('vb.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('vb.filter')} />
          {model.domains.filter((dm) => dm.active).map((dm) => {
            const list = blocks.filter((b) => b.domain_code === dm.code && (!filter || nm(b).includes(filter) || b.code.includes(filter.toLowerCase())));
            if (!list.length) return null;
            return (
              <div key={dm.code} className="palette-group">
                <div className="hint">{nm(dm)}</div>
                <div className="chips">{list.map((b) => (
                  <span key={b.code} data-code={b.code} className="chip drag" draggable style={{ ['--c' as string]: `var(--d-${dm.code})` }}
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'block', value: b.code }))}
                    onDoubleClick={() => { const s = slots[d.kind].find((x) => !x.max || d[x.key].length < x.max); if (s && !d[s.key].includes(b.code)) set({ [s.key]: [...d[s.key], b.code] } as Partial<Draft>); }}
                    title={t('vb.dragHint')}>{nm(b)}</span>
                ))}</div>
              </div>
            );
          })}
        </aside>

        <section className="canvas">
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="field">{t('vb.nameAr')}<input value={d.name_ar} onChange={(e) => set({ name_ar: e.target.value })} /></label>
            <label className="field">{t('vb.nameEn')}<input dir="ltr" value={d.name_en} onChange={(e) => set({ name_en: e.target.value })} /></label>
            <label className="field">{t('vb.purposeAr')}<input value={d.purpose_ar} onChange={(e) => set({ purpose_ar: e.target.value })} /></label>
            <label className="field">{t('vb.domain')}
              <select value={d.domain} onChange={(e) => set({ domain: e.target.value })}>{model.domains.map((dm) => <option key={dm.code} value={dm.code}>{nm(dm)}</option>)}</select>
            </label>
          </div>

          <h3 style={{ marginTop: 'var(--s-5)' }}>{t('vb.kind')}</h3>
          <div className="kind-cards" role="radiogroup" aria-label={t('vb.kind')}>
            {KINDS.map((k) => (
              <button key={k} role="radio" aria-checked={d.kind === k} className="kind-card" onClick={() => set({ kind: k, b: k === 'list' || k === 'group' || k === 'graph' ? [] : d.b, a: k === 'list' || k === 'nest' ? d.a.slice(0, 1) : d.a })}>
                <b>{t(`vp.kind.${k}`)}</b><span className="hint">{t(`vb.kindHint.${k}`)}</span>
              </button>
            ))}
          </div>

          <div className="slots">
            {slots[d.kind].map((s) => (
              <Slot key={s.key} label={s.label} max={s.max} items={d[s.key]} labelOf={blockName} type="block"
                options={blocks.map((b) => ({ value: b.code, label: nm(b) }))}
                onChange={(items) => set({ [s.key]: items } as Partial<Draft>)} />
            ))}
            {d.kind === 'list' && listBlock && (
              <Slot label={t('vb.slot.columns')} items={d.columns} type="attr" labelOf={(k) => nm(listBlock.attributes.find((a) => a.key === k)) || k}
                options={listAttrs.map((a) => ({ value: a.key, label: nm(a) }))} onChange={(columns) => set({ columns })} hint={t('vb.columnsHint')} />
            )}
            {d.kind === 'group' && d.a.length > 0 && (
              <fieldset className="slot">
                <legend>{t('vb.groupBy')}</legend>
                <div className="levels">{(['attr', 'related', 'block'] as By[]).map((b) => <button key={b} aria-pressed={d.by === b} onClick={() => set({ by: b })}>{t(`vb.by.${b}`)}</button>)}</div>
                {d.by === 'attr' && <select value={d.byAttr} onChange={(e) => set({ byAttr: e.target.value })} aria-label={t('vb.by.attr')}><option value="">{t('vb.chooseAttr')}</option>{groupAttrs.map((a) => <option key={a.key} value={a.key}>{nm(a)}</option>)}</select>}
                {d.by === 'related' && <select value={d.byRelated} onChange={(e) => set({ byRelated: e.target.value })} aria-label={t('vb.by.related')}><option value="">{t('vb.chooseBlock')}</option>{blocks.map((b) => <option key={b.code} value={b.code}>{nm(b)}</option>)}</select>}
              </fieldset>
            )}
            {d.kind === 'graph' && d.a.length > 1 && (
              <label className="field slot">{t('vb.collapse')}
                <select value={d.collapse} onChange={(e) => set({ collapse: e.target.value })}><option value="">{t('vb.noCollapse')}</option>{d.a.map((c) => <option key={c} value={c}>{blockName(c)}</option>)}</select>
                <span className="hint">{t('vb.collapseHint')}</span>
              </label>
            )}
          </div>

          <h3 style={{ marginTop: 'var(--s-5)' }}>{t('vb.preview')}</h3>
          <div className="preview">
            {!spec ? <p className="hint">{t('vb.previewEmpty')}</p>
              : !preview ? <p className="hint">{t('common.loading')}</p>
              : 'missing' in preview && preview.missing ? <div className="banner warn">{t('vp.needsLong', { blocks: preview.missing.map(blockName).join(t('list.sep')) })}</div>
              : <Render data={preview as Result} blockName={blockName} svgRef={svgRef} locale={locale} />}
          </div>
        </section>
      </div>
    </>
  );
}

/** A drop zone: drag blocks (or attributes) in from the palette, drag chips to reorder, × to remove; a list as the keyboard alternative. */
function Slot({ label, items, max, onChange, labelOf, options, type, hint }:
  { label: string; items: string[]; max?: number; onChange: (v: string[]) => void; labelOf: (v: string) => string; options: { value: string; label: string }[]; type: 'block' | 'attr'; hint?: string }) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const full = !!max && items.length >= max;
  const insert = (value: string, at: number) => {
    const rest = items.filter((x) => x !== value);
    const next = [...rest.slice(0, at), value, ...rest.slice(at)];
    onChange(max ? next.slice(-max) : next);
  };
  const onDrop = (e: React.DragEvent, at: number) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    try { const p = JSON.parse(e.dataTransfer.getData('text/plain')); if (p.type === type) insert(p.value, Math.min(at, items.length)); } catch { /* not ours */ }
  };
  return (
    <div className={`slot${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => onDrop(e, items.length)}>
      <div className="slot-head"><b>{label}</b>{max === 1 && <span className="hint">{t('vb.one')}</span>}</div>
      <div className="chips">
        {items.map((v, i) => (
          <span key={v} className="chip drag" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ type, value: v }))} onDrop={(e) => onDrop(e, i)}>
            {labelOf(v)} <button aria-label={t('vb.remove', { name: labelOf(v) })} onClick={() => onChange(items.filter((x) => x !== v))}>×</button>
          </span>
        ))}
        {items.length === 0 && <span className="hint">{t(type === 'block' ? 'vb.dropBlock' : 'vb.dropAttr')}</span>}
      </div>
      {type === 'attr' && (
        <div className="chips attr-pool">{options.filter((o) => !items.includes(o.value)).map((o) => (
          <span key={o.value} className="chip drag ghost" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ type, value: o.value }))}
            onClick={() => insert(o.value, items.length)}>{o.label}</span>
        ))}</div>
      )}
      {type === 'block' && !full && (
        <select value="" onChange={(e) => e.target.value && insert(e.target.value, items.length)} aria-label={t('vb.addTo', { slot: label })}>
          <option value="">{t('vb.orChoose')}</option>
          {options.filter((o) => !items.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
