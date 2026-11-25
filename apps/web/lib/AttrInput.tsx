'use client';
import { KeyboardEvent, useId, useState } from 'react';
import { Attr } from './api';
import { useI18n } from './i18n';

/**
 * One input per attribute type from the meta-model.
 * Predefined lists are open: the options are suggestions and any value is accepted, unless the EA owner marked the list strict.
 * Attributes marked "multiple" hold a list of values, entered as tags.
 */
export function AttrInput({ a, value, onChange, disabled }: { a: Attr; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { t, nm } = useI18n();
  const listId = useId();
  const id = `f-${a.key}`;
  const common = { id, disabled, 'aria-required': a.required } as const;
  const options = a.options ?? [];
  // Lists are shown and typed in the interface language; the stored value stays the same in both languages.
  const toLabel = (v: string) => { const o = options.find((x) => x.value === v); return o ? nm(o, 'label') || o.value : v; };
  const toValue = (txt: string) => {
    const lc = txt.trim().toLowerCase();
    const o = options.find((x) => x.value.toLowerCase() === lc || x.label_ar?.trim() === txt.trim() || x.label_en?.toLowerCase() === lc);
    return o ? o.value : txt;
  };
  const datalist = options.length ? <datalist id={listId}>{options.map((o) => <option key={o.value} value={toLabel(o.value)} />)}</datalist> : null;

  if (a.multiple || a.type === 'multi_text') {
    return <TagInput id={id} value={Array.isArray(value) ? value.map(String) : value ? String(value).split(/[;\n]/).map((x) => x.trim()).filter(Boolean) : []}
      onChange={(v) => onChange(v.length ? v : undefined)} disabled={disabled} options={options.map((o) => o.value)} strict={a.strict} placeholder={t('attr.addValue')}
      toLabel={toLabel} toValue={toValue} />;
  }
  switch (a.type) {
    case 'number':
      return <input {...common} type="number" dir="ltr" value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
    case 'date':
      return <input {...common} type="date" dir="ltr" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'url':
      return <input {...common} type="url" dir="ltr" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'enum':
      if (a.strict && options.length) {
        return (
          <select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">—</option>
            {options.map((o) => <option key={o.value} value={o.value}>{nm(o, 'label') || o.value}</option>)}
          </select>
        );
      }
      return <>{datalist}<input {...common} list={datalist ? listId : undefined} value={toLabel((value as string) ?? '')} onChange={(e) => onChange(toValue(e.target.value))}
        placeholder={options.length ? t('attr.pickOrType') : undefined} /></>;
    default:
      return a.key === 'description' || a.key.endsWith('_description')
        ? <textarea {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

function TagInput({ id, value, onChange, disabled, options, strict, placeholder, toLabel = (v) => v, toValue = (v) => v }:
  { id: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; options: string[]; strict: boolean; placeholder: string;
    toLabel?: (v: string) => string; toValue?: (v: string) => string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const v = toValue(raw.trim());
    if (!v || value.includes(v) || (strict && options.length && !options.includes(v))) return;
    onChange([...value, v]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ';' || e.key === ',' || e.key === '،') { e.preventDefault(); add(draft); }
    if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="tags" aria-disabled={disabled}>
      {value.map((v) => (
        <span key={v} className="tag">{toLabel(v)}
          {!disabled && <button type="button" aria-label={t('attr.removeValue', { v })} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>}
        </span>
      ))}
      {!disabled && <>
        {options.length > 0 && <datalist id={listId}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={toLabel(o)} />)}</datalist>}
        <input id={id} list={options.length ? listId : undefined} value={draft} placeholder={placeholder}
          onChange={(e) => { const v = e.target.value; if (options.includes(toValue(v)) && toValue(v) !== v || options.includes(v)) add(v); else setDraft(v); }}
          onKeyDown={onKey} onBlur={() => add(draft)} />
      </>}
    </div>
  );
}

export function display(a: Attr | undefined, v: unknown, nm?: (o: object, f?: string) => string): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => display(a, x, nm)).join('، ');
  if (a?.type === 'number') return Number(v).toLocaleString('en-US');
  if (a?.type === 'enum' && nm) { const o = a.options?.find((x) => x.value === v); return o ? nm(o, 'label') || String(v) : String(v); }
  return String(v);
}
