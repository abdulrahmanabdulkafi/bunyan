import type { BlockDef } from '../metamodel/metamodel.js';

export interface FieldError { key: string; message: string }

/** Coerce one value to the attribute's type; returns undefined for empty values. Throws a message string on bad input. */
export interface CoerceOpts { options?: { value: string; label_ar?: string; label_en?: string }[]; multiple?: boolean; strict?: boolean }

const SPLIT = /[;\n؛]/;

/** Split a list value given as an array, or as text separated by ; or new lines. */
export function toList(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : String(raw).split(SPLIT);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

export function coerce(type: string, raw: unknown, o: CoerceOpts = {}): unknown {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0)) return undefined;
  // Any attribute flagged `multiple` (and every multi_text) stores a list; each item is checked on its own.
  if (o.multiple || type === 'multi_text') {
    const items = toList(raw).map((x) => coerce(type === 'multi_text' ? 'text' : type, x, { ...o, multiple: false }));
    return items.length ? items : undefined;
  }
  const options = o.options ?? [];
  switch (type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
      if (!Number.isFinite(n)) throw 'يجب أن تكون القيمة رقماً';
      return n;
    }
    case 'date': {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw 'تاريخ غير صالح (YYYY-MM-DD)';
      return d.toISOString().slice(0, 10);
    }
    case 'url': {
      try { const u = new URL(String(raw)); if (!/^https?:$/.test(u.protocol)) throw 0; return u.toString(); } catch { throw 'رابط غير صالح'; }
    }
    case 'enum': {
      // Options are suggestions; only a list marked strict rejects other values.
      let v = String(raw).trim();
      // An Arabic or English label (any letter case) is stored as the list's value, so Excel files in either language line up.
      const lc = v.toLowerCase();
      const hit = (options as { value: string; label_ar?: string; label_en?: string }[]).find((x) =>
        x.value.toLowerCase() === lc || x.label_ar?.trim() === v || x.label_en?.toLowerCase() === lc);
      if (hit) v = hit.value;
      if (o.strict && options.length && !options.some((x) => x.value === v)) throw `قيمة غير مسموحة؛ القيم المتاحة: ${options.map((x) => x.value).join('، ')}`;
      return v;
    }
    default: {
      const v = String(raw).trim();
      if (v.length > 10000) throw 'النص أطول من المسموح';
      return v;
    }
  }
}

/**
 * Validate a full attribute set against the block definition.
 * Unknown or inactive keys are rejected so stray data never enters the repository.
 */
export function validateAttrs(block: BlockDef, input: Record<string, unknown>, opts: { partial?: boolean } = {}) {
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};
  const active = new Map(block.attributes.filter((a) => a.active).map((a) => [a.key, a]));
  for (const key of Object.keys(input ?? {})) {
    if (!active.has(key)) errors.push({ key, message: 'سمة غير معرّفة في هذه الوحدة' });
  }
  for (const a of active.values()) {
    if (opts.partial && !(a.key in (input ?? {}))) continue;
    try {
      const v = coerce(a.type, input?.[a.key], { options: a.options ?? [], multiple: a.multiple, strict: a.strict });
      if (v === undefined) {
        if (a.required) errors.push({ key: a.key, message: 'حقل إلزامي' });
      } else out[a.key] = v;
    } catch (m) {
      errors.push({ key: a.key, message: String(m) });
    }
  }
  return { attrs: out, errors };
}

/** Share of active attributes that have a value — used for completeness scores and missing-data alerts. */
export function completeness(block: BlockDef, attrs: Record<string, unknown>): number {
  const act = block.attributes.filter((a) => a.active);
  if (!act.length) return 1;
  return act.filter((a) => attrs[a.key] !== undefined && attrs[a.key] !== null && attrs[a.key] !== '').length / act.length;
}
