'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, Block, canInScope } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Sheet { name: string; rows: number; columns: number; header_guess: number; preview: string[][] }
interface Column { index: number; header: string; samples: string[]; filled: number }
interface Inspect { sheets: Sheet[]; sheet: string; header_row: number; data_rows: number; columns: Column[] }
interface Issue { row: number; column?: string; message: string; kind: 'error' | 'warning' }
interface Result { dry_run: boolean; saved: boolean; created: number; updated: number; unchanged: number; skipped: number; linked: number; errors: number; warnings: number; issues: Issue[] }

/** Same normalisation as the API: Arabic letter variants, case and punctuation do not block a match. */
function norm(s: string) {
  return s.toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(ال)/, '').trim();
}

const skel = (s: string) => norm(s).replace(/(ات|ين|ون)$/, '').replace(/[اويه\s]/g, '');

export default function ImportWizard() {
  const { user, model, reloadModel } = useSession();
  const { t, nm, num } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [block, setBlock] = useState('');
  const [cols, setCols] = useState<Record<number, string>>({});
  const [matchOn, setMatchOn] = useState('__title__');
  const [mode, setMode] = useState<'create_update' | 'create_only' | 'update_only'>('create_update');
  const [onError, setOnError] = useState<'all_or_nothing' | 'skip_rows'>('all_or_nothing');
  const [createLinks, setCreateLinks] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const blocks = useMemo(() => (model?.blocks ?? []).filter((b) => b.active && canInScope(user, 'records.import', b)), [model, user]);
  const b: Block | undefined = blocks.find((x) => x.code === block);
  const targets = useMemo(() => {
    if (!b || !model) return [];
    const attrs = b.attributes.filter((a) => a.active).map((a) => ({ value: a.key, label: nm(a), names: [a.name_ar, a.name_en, a.key] }));
    const rels = model.relations.filter((r) => r.active && (r.source_code === b.code || r.target_code === b.code)).flatMap((r) => {
      const other = model.blocks.find((x) => x.code === (r.source_code === b.code ? r.target_code : r.source_code));
      if (!other?.active) return [];
      const verb = r.source_code === b.code ? (r.name_ar && nm({ name_ar: r.name_ar, name_en: r.verb })) || r.verb : r.verb;
      const label = r.source_code === b.code ? t('wiz.relOut', { verb, other: nm(other) }) : t('wiz.relIn', { verb, other: nm(other) });
      return [{ value: `rel:${r.id}`, label, names: [other.name_ar, other.name_en, other.code] }];
    });
    return [...attrs, ...rels];
  }, [b, model, nm, t]);

  if (!model) return null;

  async function inspect(f: File, sheet?: string, headerRow?: number) {
    setBusy(true); setErr(''); setResult(null);
    const fd = new FormData(); fd.append('file', f);
    if (sheet) fd.append('sheet', sheet);
    if (headerRow) fd.append('header_row', String(headerRow));
    try {
      const r = await api<Inspect>('/io/wizard/inspect', { method: 'POST', body: fd });
      setInfo(r);
      if (block) autoMap(r.columns, block);
    } catch (e) { setErr((e as Error).message); setInfo(null); } finally { setBusy(false); }
  }

  function autoMap(columns: Column[], code: string) {
    const bb = blocks.find((x) => x.code === code);
    if (!bb || !model) return;
    const cands = [
      ...bb.attributes.filter((a) => a.active).map((a) => ({ v: a.key, names: [a.name_ar, a.name_en, a.key] })),
      ...model.relations.filter((r) => r.active && (r.source_code === code || r.target_code === code)).map((r) => {
        const o = model.blocks.find((x) => x.code === (r.source_code === code ? r.target_code : r.source_code));
        return { v: `rel:${r.id}`, names: o ? [o.name_ar, o.name_en, o.code] : [] };
      }),
    ];
    const used = new Set<string>();
    const next: Record<number, string> = {};
    for (const c of columns) {
      const h = norm(c.header);
      const hit = cands.find((x) => !used.has(x.v) && x.names.some((n) => n && norm(n) === h))
        ?? cands.find((x) => !used.has(x.v) && x.names.some((n) => n && norm(n).length > 2 && (h.includes(norm(n)) || norm(n).includes(h)) && h.length > 2))
        // Arabic broken plurals (خوادم / خادم, تطبيقات / تطبيق): compare consonant skeletons.
        ?? cands.find((x) => !used.has(x.v) && x.names.some((n) => n && skel(n).length > 2 && (skel(n) === skel(c.header) || skel(c.header).startsWith(skel(n)))));
      if (hit) { next[c.index] = hit.v; used.add(hit.v); }
    }
    setCols(next);
    // A code column is a steadier key than a name that may be reworded between versions of the file.
    setMatchOn(Object.values(next).includes('code') && bb.title_key !== 'code' ? 'code' : '__title__');
    setResult(null);
  }

  async function run(dry: boolean) {
    if (!file || !info || !b) return;
    setBusy(true); setErr('');
    const fd = new FormData(); fd.append('file', file);
    fd.append('mapping', JSON.stringify({
      sheet: info.sheet, header_row: info.header_row, block: b.code, columns: cols,
      match_on: matchOn, mode, on_error: onError, create_missing_links: createLinks, dry_run: dry,
    }));
    try {
      setResult(await api<Result>('/io/wizard/run', { method: 'POST', body: fd }));
      if (!dry) reloadModel();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally { setBusy(false); }
  }

  const titleKey = b?.title_key ?? 'name';
  const matchCol = Object.entries(cols).find(([, v]) => v === (matchOn === '__title__' ? titleKey : matchOn));
  const mapped = Object.values(cols).filter(Boolean).length;
  const sheet = info?.sheets.find((s) => s.name === info.sheet);
  const dupTargets = Object.values(cols).filter((v, i, a) => v && a.indexOf(v) !== i);

  return (
    <>
      <div className="page-head"><div>
        <h1>{t('wiz.title')}</h1>
        <p>{t('wiz.subtitle')}</p>
      </div><Link className="btn quiet" href="/io">{t('wiz.back')}</Link></div>

      <section className="section">
        <h2>{t('wiz.s1')}</h2>
        <div className="row">
          <input type="file" accept=".xlsx" aria-label={t('io.file')} style={{ maxWidth: 360 }}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setInfo(null); setResult(null); if (f) inspect(f); }} />
          {busy && <span className="hint">{t('common.loading')}</span>}
        </div>
        {err && <div className="banner error" style={{ marginTop: 'var(--s-3)' }}>{err}</div>}
      </section>

      {info && sheet && file && (
        <section className="section">
          <h2>{t('wiz.s2')}</h2>
          <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
            <label className="field" style={{ minWidth: 220 }}>
              <span>{t('wiz.sheet')}</span>
              <select value={info.sheet} onChange={(e) => inspect(file, e.target.value)}>
                {info.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} ({num(s.rows)})</option>)}
              </select>
            </label>
            <label className="field" style={{ width: 160 }}>
              <span>{t('wiz.headerRow')}</span>
              <input type="number" min={1} max={200} value={info.header_row} onChange={(e) => Number(e.target.value) > 0 && inspect(file, info.sheet, Number(e.target.value))} />
            </label>
            <p className="hint" style={{ alignSelf: 'end' }}>{t('wiz.rows', { n: num(info.data_rows) })}</p>
          </div>
          <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="preview">
              <tbody>{sheet.preview.map((r, i) => (
                <tr key={i} className={i + 1 === info.header_row ? 'is-header' : i + 1 < info.header_row ? 'is-above' : ''}
                  onClick={() => inspect(file, info.sheet, i + 1)} title={t('wiz.pickHeader')}>
                  <th className="num">{i + 1}</th>
                  {r.map((c, j) => <td key={j}>{c}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="hint">{t('wiz.headerHint')}</p>
        </section>
      )}

      {info && (
        <section className="section">
          <h2>{t('wiz.s3')}</h2>
          <label className="field" style={{ maxWidth: 360, marginBottom: 'var(--s-3)' }}>
            <span>{t('wiz.block')}</span>
            <select value={block} onChange={(e) => { setBlock(e.target.value); autoMap(info.columns, e.target.value); }}>
              <option value="">{t('wiz.pickBlock')}</option>
              {blocks.map((x) => <option key={x.code} value={x.code}>{nm(x)}</option>)}
            </select>
          </label>
          {b && (
            <>
              <p className="hint">{t('wiz.mapHint', { n: mapped, m: info.columns.length })}</p>
              <div className="table-wrap"><table>
                <thead><tr><th>{t('wiz.column')}</th><th>{t('wiz.samples')}</th><th>{t('wiz.target')}</th></tr></thead>
                <tbody>{info.columns.map((c) => (
                  <tr key={c.index}>
                    <td><strong>{c.header}</strong><div className="hint">{t('wiz.filled', { n: num(c.filled) })}</div></td>
                    <td className="hint" style={{ maxWidth: 320 }}>{c.samples.join(t('list.sep'))}</td>
                    <td>
                      <select value={cols[c.index] ?? ''} aria-label={c.header}
                        aria-invalid={dupTargets.includes(cols[c.index]) || undefined}
                        onChange={(e) => { setCols({ ...cols, [c.index]: e.target.value }); setResult(null); }}>
                        <option value="">{t('wiz.ignore')}</option>
                        <optgroup label={t('wiz.attrs')}>
                          {targets.filter((x) => !x.value.startsWith('rel:')).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                        </optgroup>
                        <optgroup label={t('wiz.rels')}>
                          {targets.filter((x) => x.value.startsWith('rel:')).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                        </optgroup>
                      </select>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
              {dupTargets.length > 0 && <div className="banner warn" style={{ marginTop: 'var(--s-3)' }}>{t('wiz.dupTarget')}</div>}
            </>
          )}
        </section>
      )}

      {info && b && (
        <section className="section">
          <h2>{t('wiz.s4')}</h2>
          <div className="grid-2" style={{ gap: 'var(--s-4)' }}>
            <label className="field">
              <span>{t('wiz.matchOn')}</span>
              <select value={matchOn} onChange={(e) => { setMatchOn(e.target.value); setResult(null); }}>
                <option value="__title__">{nm(b.attributes.find((a) => a.key === titleKey)) || t('common.name')} ({t('wiz.titleAttr')})</option>
                {b.attributes.filter((a) => a.active && a.key !== titleKey && ['text', 'url'].includes(a.type)).map((a) => <option key={a.key} value={a.key}>{nm(a)}</option>)}
              </select>
              <small className="hint">{t('wiz.matchHint')}</small>
            </label>
            <label className="field">
              <span>{t('wiz.mode')}</span>
              <select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setResult(null); }}>
                <option value="create_update">{t('wiz.mode.create_update')}</option>
                <option value="create_only">{t('wiz.mode.create_only')}</option>
                <option value="update_only">{t('wiz.mode.update_only')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('wiz.onError')}</span>
              <select value={onError} onChange={(e) => { setOnError(e.target.value as typeof onError); setResult(null); }}>
                <option value="all_or_nothing">{t('wiz.onError.all')}</option>
                <option value="skip_rows">{t('wiz.onError.skip')}</option>
              </select>
            </label>
            <label className="row" style={{ gap: 8, alignSelf: 'end', fontSize: 14 }}>
              <input type="checkbox" checked={createLinks} onChange={(e) => { setCreateLinks(e.target.checked); setResult(null); }} />
              {t('wiz.createLinks')}
            </label>
          </div>
          {!matchCol && <div className="banner warn" style={{ marginTop: 'var(--s-3)' }}>{t('wiz.needMatch')}</div>}
          <div className="row" style={{ marginTop: 'var(--s-4)' }}>
            <button className="btn" disabled={busy || !matchCol || dupTargets.length > 0} onClick={() => run(true)}>{t('io.check')}</button>
            <button className="btn primary" disabled={busy || !matchCol || dupTargets.length > 0 || !result?.dry_run || (result.errors > 0 && onError === 'all_or_nothing')}
              onClick={() => run(false)}>{t('io.import')}</button>
            {!result?.dry_run && !result?.saved && <span className="hint">{t('wiz.checkFirst')}</span>}
          </div>
        </section>
      )}

      {result && (
        <section className="section" aria-live="polite">
          <div className={`banner ${result.saved ? 'ok' : result.errors ? 'error' : result.dry_run ? 'ok' : 'warn'}`}>
            {result.saved ? t('wiz.saved', counts(result))
              : result.dry_run ? (result.errors && onError === 'all_or_nothing' ? t('wiz.dryErrors', { e: result.errors }) : t('wiz.dryOk', counts(result)))
              : t('wiz.notSaved', { e: result.errors })}
          </div>
          {result.saved && (
            <p className="hint">{t('wiz.next')} <Link href={`/repo/${block}`}>{t('wiz.openRepo')}</Link></p>
          )}
          {result.issues.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th className="num">{t('io.row')}</th><th>{t('wiz.column')}</th><th>{t('wiz.kind')}</th><th>{t('io.error')}</th></tr></thead>
              <tbody>{result.issues.map((i, k) => (
                <tr key={k}><td className="num">{i.row}</td><td>{i.column ?? '—'}</td>
                  <td><span className={`status ${i.kind === 'error' ? 'st-rejected' : 'st-submitted'}`}>{t(`wiz.kind.${i.kind}`)}</span></td>
                  <td>{i.message}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
    </>
  );

  function counts(r: Result) {
    return { c: r.created, u: r.updated, n: r.unchanged, s: r.skipped, l: r.linked, w: r.warnings, e: r.errors };
  }
}
