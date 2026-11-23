'use client';
import { Attr } from './api';

/** One input per attribute type from the meta-model. Enums without configured options act as free text with suggestions. */
export function AttrInput({ a, value, onChange, disabled }: { a: Attr; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const id = `f-${a.key}`;
  const common = { id, disabled, 'aria-required': a.required } as const;
  switch (a.type) {
    case 'number':
      return <input {...common} type="number" dir="ltr" value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
    case 'date':
      return <input {...common} type="date" dir="ltr" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'url':
      return <input {...common} type="url" dir="ltr" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'multi_text':
      return <textarea {...common} value={Array.isArray(value) ? value.join('\n') : ((value as string) ?? '')} onChange={(e) => onChange(e.target.value)} placeholder="قيمة في كل سطر" />;
    case 'enum':
      if (a.options?.length) {
        return (
          <select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">—</option>
            {a.options.map((o) => <option key={o.value} value={o.value}>{o.label_ar ?? o.value}</option>)}
          </select>
        );
      }
      return <input {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return a.key === 'description' || a.key.endsWith('_description')
        ? <textarea {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
        : <input {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function display(a: Attr | undefined, v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.join('، ');
  if (a?.type === 'number') return Number(v).toLocaleString('en-US');
  if (a?.type === 'enum') return a.options?.find((o) => o.value === v)?.label_ar ?? String(v);
  return String(v);
}
