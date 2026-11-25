'use client';
import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { api, can, download, VpMeta } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { useSearchParams } from 'next/navigation';

import { Render, Result } from '@/lib/ViewpointRender';
const LEVELS = ['conceptual', 'logical', 'physical'] as const;
interface CycleBrief { id: string; code: string; name: string; status: string }

export default function ViewpointPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { model, user } = useSession();
  const { t, nm, locale } = useI18n();
  const [meta, setMeta] = useState<VpMeta | null>(null);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('logical');
  const [data, setData] = useState<(Result & { missing?: undefined }) | { missing: string[] } | null>(null);
  const [err, setErr] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  // Architecture state: the repository as it is, or before / after a development cycle's planned changes.
  const sp = useSearchParams();
  const [cycles, setCycles] = useState<CycleBrief[]>([]);
  const [cycle, setCycle] = useState(sp.get('cycle') ?? '');
  const [state, setState] = useState<'current' | 'target'>(sp.get('state') === 'current' ? 'current' : 'target');
  const q = `level=${level}${cycle ? `&cycle=${cycle}&state=${state}` : ''}`;

  useEffect(() => { api<VpMeta[]>('/viewpoints/catalog').then((l) => setMeta(l.find((v) => v.code === code) ?? null)); }, [code]);
  useEffect(() => { api<CycleBrief[]>('/cycles').then((l) => setCycles(l.filter((c) => c.status === 'active' || c.status === 'planned' || c.id === cycle))).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); api<Result>(`/viewpoints/run/${code}?${q}`).then(setData).catch((e) => setErr(e.message)); }, [code, q]);

  if (!model || !meta) return err ? <div className="banner error">{err}</div> : <p className="hint">{t('common.loading')}</p>;
  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c)) || c;

  async function png() {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const css = getComputedStyle(document.documentElement);
    // Resolve CSS variables so the exported image keeps its colours outside the page.
    const resolved = xml.replace(/var\((--[\w-]+)\)/g, (_, v) => css.getPropertyValue(v).trim() || '#333');
    const img = new Image();
    const vb = svg.viewBox.baseVal;
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vb.width * 2; c.height = vb.height * 2;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const a = Object.assign(document.createElement('a'), { href: c.toDataURL('image/png'), download: `${code}.png` });
      a.click();
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(resolved)}`;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p><Link href="/views">{t('vp.title')}</Link> <span className="hint" dir="ltr">{code}</span></p>
          <h1>{nm(meta)}</h1>
          <p>{nm(meta, 'purpose')}</p>
        </div>
        <div className="row">
          {cycles.length > 0 && (
            <div className="row state-pick">
              <select value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label={t('vp.stateOf')}>
                <option value="">{t('vp.asIs')}</option>
                {cycles.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
              {cycle && (
                <div className="levels" role="group" aria-label={t('vp.state')}>
                  {(['current', 'target'] as const).map((x) => <button key={x} aria-pressed={state === x} onClick={() => setState(x)}>{t(`vp.state.${x}`)}</button>)}
                </div>
              )}
            </div>
          )}
          {meta.custom && can(user, 'viewpoints.build') && <Link className="btn" href={`/views/builder?code=${code}`}>{t('vb.edit')}</Link>}
          {meta.kind === 'list' && (
            <div className="levels" role="group" aria-label={t('vp.level')}>
              {LEVELS.map((l) => <button key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>{t(`vp.level.${l}`)}</button>)}
            </div>
          )}
          {can(user, 'records.read') && data && !('missing' in data && data.missing) && (
            meta.kind === 'graph'
              ? <button className="btn" onClick={png}>{t('vp.png')}</button>
              : <button className="btn" onClick={() => download(`/viewpoints/run/${code}/xlsx?${q}`, `${code}.xlsx`)}>{t('vp.excel')}</button>
          )}
        </div>
      </div>
      {err && <div className="banner error">{err}</div>}
      {!data && !err && <p className="hint">{t('common.loading')}</p>}
      {data && 'missing' in data && data.missing && (
        <div className="banner warn">{t('vp.needsLong', { blocks: data.missing.map(blockName).join(t('list.sep')) })} <Link href="/studio">{t('nav.studio')}</Link></div>
      )}
      {cycle && data && !('missing' in data && data.missing) && (
        <p className="hint" style={{ marginBottom: 'var(--s-3)' }}>{t(state === 'target' ? 'vp.targetHint' : 'vp.currentHint')} <Link href={`/cycles/${cycle}`}>{t('vp.openCycle')}</Link></p>
      )}
      {data && !('missing' in data && data.missing) && <Render data={data as Result} blockName={blockName} svgRef={svgRef} locale={locale} />}
    </>
  );
}

