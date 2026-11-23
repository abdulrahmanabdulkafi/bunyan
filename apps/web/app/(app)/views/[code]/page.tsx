'use client';
import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { api, can, download, VpMeta } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Brief { id: string; name: string; block_code: string; status: string }
type Result =
  | { kind: 'list'; block: string; columns: { key: string; name_ar: string; name_en: string; type: string }[]; rows: (Brief & { attrs: Record<string, unknown> })[] }
  | { kind: 'matrix'; rows: (Brief & { subtitle: string | null })[]; cols: Brief[]; cells: { row: string; col: string; direct: boolean }[] }
  | { kind: 'group'; groups: { key: string; label_ar: string; label_en: string; items: Brief[] }[] }
  | { kind: 'nest'; containers: (Brief & { children: Brief[] })[]; unplaced: Brief[] }
  | { kind: 'graph'; nodes: Brief[]; edges: { id: string; source_id: string; target_id: string; verb: string; name_ar: string | null }[] };

const LEVELS = ['conceptual', 'logical', 'physical'] as const;
const BLOCK_COLORS: Record<string, string> = {
  application: 'var(--d-applications)', application_modules: '#4f8f7f', technical_integration_interface: 'var(--saffron)',
  data_center: 'var(--ink)', physical_host: '#5e6f72', server: 'var(--d-technology)', storage: '#9c7c48', network_device: '#2f6690', network_link: '#6b8fb3',
  containerization_engine: '#7d6b9e', security_hardware: 'var(--d-security)', security_software: '#b0574a', security_service: '#c98a7f',
};

export default function ViewpointPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { model, user } = useSession();
  const { t, nm, locale } = useI18n();
  const [meta, setMeta] = useState<VpMeta | null>(null);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('logical');
  const [data, setData] = useState<(Result & { missing?: undefined }) | { missing: string[] } | null>(null);
  const [err, setErr] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => { api<VpMeta[]>('/viewpoints/catalog').then((l) => setMeta(l.find((v) => v.code === code) ?? null)); }, [code]);
  useEffect(() => { setData(null); api<Result>(`/viewpoints/run/${code}?level=${level}`).then(setData).catch((e) => setErr(e.message)); }, [code, level]);

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
          {meta.kind === 'list' && (
            <div className="levels" role="group" aria-label={t('vp.level')}>
              {LEVELS.map((l) => <button key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>{t(`vp.level.${l}`)}</button>)}
            </div>
          )}
          {can(user, 'records.read') && data && !('missing' in data && data.missing) && (
            meta.kind === 'graph'
              ? <button className="btn" onClick={png}>{t('vp.png')}</button>
              : <button className="btn" onClick={() => download(`/viewpoints/run/${code}/xlsx?level=${level}`, `${code}.xlsx`)}>{t('vp.excel')}</button>
          )}
        </div>
      </div>
      {err && <div className="banner error">{err}</div>}
      {!data && !err && <p className="hint">{t('common.loading')}</p>}
      {data && 'missing' in data && data.missing && (
        <div className="banner warn">{t('vp.needsLong', { blocks: data.missing.map(blockName).join(t('list.sep')) })} <Link href="/studio">{t('nav.studio')}</Link></div>
      )}
      {data && !('missing' in data && data.missing) && <Render data={data as Result} blockName={blockName} svgRef={svgRef} locale={locale} />}
    </>
  );
}

function Render({ data, blockName, svgRef, locale }: { data: Result; blockName: (c: string) => string; svgRef: React.RefObject<SVGSVGElement | null>; locale: string }) {
  const { t, nm } = useI18n();
  const empty = <p className="hint">{t('vp.empty')}</p>;
  switch (data.kind) {
    case 'list':
      if (!data.rows.length) return empty;
      return (
        <div className="table-wrap"><table>
          <thead><tr><th>{t('common.name')}</th>{data.columns.map((c) => <th key={c.key}>{nm(c)}</th>)}<th>{t('common.status')}</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.id}><td><Link href={`/records/${r.id}`}>{r.name}</Link></td>
              {data.columns.map((c) => { const v = r.attrs[c.key]; return <td key={c.key}>{v === undefined || v === null || v === '' ? '—' : Array.isArray(v) ? v.join(t('list.sep')) : c.type === 'number' ? Number(v).toLocaleString('en-US') : String(v)}</td>; })}
              <td><span className={`status st-${r.status}`}>{t(`status.${r.status}`)}</span></td></tr>))}
          </tbody>
        </table></div>
      );
    case 'matrix':
      if (!data.rows.length || !data.cols.length) return empty;
      return (
        <>
          <div className="table-wrap"><table className="matrix">
            <thead><tr><th />{data.cols.map((c) => <th key={c.id} className="col">{c.name}</th>)}</tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}><th><Link href={`/records/${r.id}`}>{r.name}</Link>{r.subtitle && <span className="hint" style={{ display: 'block' }}>{String(r.subtitle)}</span>}</th>
                {data.cols.map((c) => {
                  const hit = data.cells.find((x) => x.row === r.id && x.col === c.id);
                  return <td key={c.id} className={`cell${hit ? ' on' : ''}`} title={hit ? t(hit.direct ? 'vp.direct' : 'vp.indirect') : undefined}>{hit ? (hit.direct ? '●' : '○') : ''}</td>;
                })}
              </tr>))}
            </tbody>
          </table></div>
          <p className="hint" style={{ marginTop: 'var(--s-2)' }}>● {t('vp.direct')} ○ {t('vp.indirect')}</p>
        </>
      );
    case 'group':
      if (!data.groups.some((g) => g.items.length)) return empty;
      return (
        <div className="lanes">{data.groups.map((g) => (
          <div key={g.key || '_'} className="lane" style={g.key === '' ? { ['--c' as string]: 'var(--rule)' } : undefined}>
            <h3><span>{nm(g, 'label')}</span><span className="hint">{g.items.length}</span></h3>
            <ul>{g.items.map((i) => <li key={i.id + g.key}><Link href={`/records/${i.id}`} title={blockName(i.block_code)}>{i.name}</Link></li>)}</ul>
          </div>))}
        </div>
      );
    case 'nest':
      if (!data.containers.length) return empty;
      return (
        <>
          <div className="containers">{data.containers.map((c) => (
            <div key={c.id} className="container-box">
              <h3><Link href={`/records/${c.id}`}>{c.name}</Link></h3>
              {c.children.length === 0 ? <p className="hint">{t('vp.nothingInside')}</p> : (
                <div className="chips">{c.children.map((x) => <Link key={x.id} href={`/records/${x.id}`} className="chip" style={{ ['--c' as string]: BLOCK_COLORS[x.block_code] }} title={blockName(x.block_code)}>{x.name}</Link>)}</div>
              )}
            </div>))}
          </div>
          {data.unplaced.length > 0 && (
            <section className="section">
              <h2>{t('vp.unplaced')}</h2>
              <div className="chips">{data.unplaced.map((x) => <Link key={x.id} href={`/records/${x.id}`} className="chip" style={{ ['--c' as string]: BLOCK_COLORS[x.block_code] }}>{x.name}</Link>)}</div>
            </section>
          )}
          <Legend codes={[...new Set([...data.containers.flatMap((c) => c.children), ...data.unplaced].map((x) => x.block_code))]} blockName={blockName} />
        </>
      );
    case 'graph':
      if (!data.nodes.length) return empty;
      return <Graph data={data} blockName={blockName} svgRef={svgRef} locale={locale} />;
  }
}

function Legend({ codes, blockName }: { codes: string[]; blockName: (c: string) => string }) {
  return <p className="row" style={{ marginTop: 'var(--s-3)' }}>{codes.map((c) => <span key={c} className="hint"><span className="dom-dot" style={{ ['--c' as string]: BLOCK_COLORS[c] ?? 'var(--ink-2)' }} />{blockName(c)}</span>)}</p>;
}

/** Radial layout, one ring per building block, so layers read from outside (applications) to inside (infrastructure). */
function Graph({ data, blockName, svgRef, locale }: { data: Extract<Result, { kind: 'graph' }>; blockName: (c: string) => string; svgRef: React.RefObject<SVGSVGElement | null>; locale: string }) {
  const W = 920, H = 640, cx = W / 2, cy = H / 2;
  const types = [...new Set(data.nodes.map((n) => n.block_code))];
  const pos = new Map<string, { x: number; y: number }>();
  types.forEach((ty, ti) => {
    const ring = data.nodes.filter((n) => n.block_code === ty);
    const radius = types.length === 1 ? 250 : 260 - ti * (210 / types.length);
    ring.forEach((n, i) => {
      const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2 + ti * 0.4;
      pos.set(n.id, { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    });
  });
  return (
    <figure style={{ margin: 0 }}>
      <svg ref={svgRef} className="diagram" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={blockName(types[0])} xmlns="http://www.w3.org/2000/svg" direction={locale === 'ar' ? 'rtl' : 'ltr'}>
        <rect width={W} height={H} fill="#fff" />
        {data.edges.map((e) => {
          const a = pos.get(e.source_id), b = pos.get(e.target_id);
          if (!a || !b) return null;
          return (
            <g key={e.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#9fb0ad" strokeWidth={1.4}><title>{locale === 'ar' ? e.name_ar ?? e.verb : e.verb}</title></line>
              {/* Collapsed edges carry the interface name; label them when the diagram is small enough to stay legible. */}
              {e.id.includes(':') && data.edges.length <= 30 && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} textAnchor="middle" style={{ fontFamily: 'IBM Plex Sans Arabic, sans-serif', fontSize: 11, fill: '#8a6a2e' }}>{e.verb}</text>
              )}
            </g>
          );
        })}
        {data.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const fill = BLOCK_COLORS[n.block_code] ?? 'var(--ink-2)';
          return (
            <a key={n.id} href={`/records/${n.id}`}>
              {n.block_code === 'technical_integration_interface' || n.block_code === 'network_link'
                ? <rect x={p.x - 7} y={p.y - 7} width={14} height={14} transform={`rotate(45 ${p.x} ${p.y})`} fill={fill} />
                : <circle cx={p.x} cy={p.y} r={9} fill={fill} />}
              <text x={p.x} y={p.y + 24} textAnchor="middle" style={{ fontFamily: 'IBM Plex Sans Arabic, sans-serif', fontSize: 12, fill: '#17282c' }}>{n.name}</text>
            </a>
          );
        })}
      </svg>
      <Legend codes={types} blockName={blockName} />
    </figure>
  );
}
