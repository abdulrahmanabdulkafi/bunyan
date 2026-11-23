import type { BlockDef } from '../metamodel/metamodel.js';

export interface FieldError { key: string; message: string }

/** Coerce one value to the attribute's type; returns undefined for empty values. Throws a message string on bad input. */
export function coerce(type: string, raw: unknown, options: { value: string }[]): unknown {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return undefined;
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
    case 'multi_text': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(/[;\n،]/);
      const out = arr.map((x) => String(x).trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
    case 'enum': {
      const v = String(raw).trim();
      if (options.length && !options.some((o) => o.value === v)) throw `قيمة غير مسموحة؛ القيم المتاحة: ${options.map((o) => o.value).join('، ')}`;
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
      const v = coerce(a.type, input?.[a.key], a.options ?? []);
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
