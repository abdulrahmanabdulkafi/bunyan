'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Matrix { rows: { id: string; name: string }[]; cols: { id: string; name: string }[]; cells: { row: string; col: string; verb: string }[] }
interface Graph { nodes: { id: string; name: string; block_code: string }[]; edges: { id: string; source_id: string; target_id: string; verb: string }[] }

const VIEWS = [
  { key: 'matrix', label: 'مصفوفة العلاقات' },
  { key: 'integration', label: 'مخطط التكامل بين التطبيقات' },
  { key: 'hosting', label: 'مخطط الاستضافة' },
];

export default function Views() {
  const { model } = useSession();
  const [tab, setTab] = useState('matrix');
  const [rows, setRows] = useState('application');
  const [cols, setCols] = useState('server');
  const [m, setM] = useState<Matrix | null>(null);
  const [g, setG] = useState<Graph | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    if (tab === 'matrix') api<Matrix>(`/viewpoints/matrix?rows=${rows}&cols=${cols}`).then(setM).catch((e) => setErr(e.message));
    else {
      const blocks = tab === 'integration' ? 'application,technical_integration_interface' : 'application,server,physical_host,data_center';
      api<Graph>(`/viewpoints/graph?blocks=${blocks}`).then(setG).catch((e) => setErr(e.message));
    }
  }, [tab, rows, cols]);

  if (!model) return null;
  const active = model.blocks.filter((b) => b.active);
  const related = (code: string) => new Set(model.relations.filter((r) => r.active && (r.source_code === code || r.target_code === code)).flatMap((r) => [r.source_code, r.target_code]));

  return (
    <>
      <div className="page-head"><div>
        <h1>المناظير</h1>
        <p>عروض مبنية من بيانات المستودع مباشرة؛ أي تعديل على السجلات أو علاقاتها يظهر هنا فوراً.</p>
      </div></div>
      <div className="tabs" role="tablist">
        {VIEWS.map((v) => <button key={v.key} role="tab" aria-selected={tab === v.key} onClick={() => setTab(v.key)}>{v.label}</button>)}
      </div>
      {err && <div className="banner error">{err}</div>}

      {tab === 'matrix' && (
        <>
          <div className="row" style={{ marginBottom: 'var(--s-4)' }}>
            <label className="field" style={{ maxWidth: 240 }}>الصفوف
              <select value={rows} onChange={(e) => setRows(e.target.value)}>{active.map((b) => <option key={b.code} value={b.code}>{b.name_ar}</option>)}</select>
            </label>
            <label className="field" style={{ maxWidth: 240 }}>الأعمدة
              <select value={cols} onChange={(e) => setCols(e.target.value)}>
                {active.filter((b) => related(rows).has(b.code)).map((b) => <option key={b.code} value={b.code}>{b.name_ar}</option>)}
              </select>
            </label>
          </div>
          {m && (m.rows.length && m.cols.length ? (
            <div className="table-wrap"><table className="matrix">
              <thead><tr><th />{m.cols.map((c) => <th key={c.id} className="col">{c.name}</th>)}</tr></thead>
              <tbody>{m.rows.map((r) => (
                <tr key={r.id}><th><Link href={`/records/${r.id}`}>{r.name}</Link></th>
                  {m.cols.map((c) => {
                    const hit = m.cells.find((x) => x.row === r.id && x.col === c.id);
                    return <td key={c.id} className={`cell${hit ? ' on' : ''}`} title={hit?.verb}>{hit ? '●' : ''}</td>;
                  })}
                </tr>))}
              </tbody>
            </table></div>
          ) : <p className="hint">لا توجد سجلات كافية لبناء المصفوفة.</p>)}
        </>
      )}

      {tab !== 'matrix' && g && <Diagram g={g} blockName={(c) => model.blocks.find((b) => b.code === c)?.name_ar ?? c} />}
    </>
  );
}

const COLORS: Record<string, string> = {
  application: 'var(--d-applications)', technical_integration_interface: 'var(--saffron)', server: 'var(--d-technology)',
  physical_host: '#5e6f72', data_center: 'var(--ink)',
};

/** Radial layout: each block type gets its own ring, so the reader sees layers (apps outside, infrastructure inside). */
function Diagram({ g, blockName }: { g: Graph; blockName: (c: string) => string }) {
  if (!g.nodes.length) return <p className="hint">لا توجد سجلات لعرضها.</p>;
  const W = 880, H = 620, cx = W / 2, cy = H / 2;
  const types = [...new Set(g.nodes.map((n) => n.block_code))];
  const pos = new Map<string, { x: number; y: number }>();
  types.forEach((t, ti) => {
    const ring = g.nodes.filter((n) => n.block_code === t);
    const radius = types.length === 1 ? 240 : 250 - ti * (200 / types.length);
    ring.forEach((n, i) => {
      const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2 + ti * 0.35;
      pos.set(n.id, { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    });
  });
  return (
    <figure style={{ margin: 0 }}>
      <svg className="diagram" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="مخطط العلاقات">
        {g.edges.map((e) => {
          const a = pos.get(e.source_id), b = pos.get(e.target_id);
          return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#9fb0ad" strokeWidth={1.4}><title>{e.verb}</title></line> : null;
        })}
        {g.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <a href={`/records/${n.id}`}>
                {n.block_code === 'technical_integration_interface'
                  ? <rect x={p.x - 7} y={p.y - 7} width={14} height={14} transform={`rotate(45 ${p.x} ${p.y})`} fill={COLORS[n.block_code]} />
                  : <circle cx={p.x} cy={p.y} r={9} fill={COLORS[n.block_code] ?? 'var(--ink-2)'} />}
                <text x={p.x} y={p.y + 24} textAnchor="middle">{n.name}</text>
              </a>
            </g>
          );
        })}
      </svg>
      <figcaption className="row" style={{ marginTop: 'var(--s-2)' }}>
        {types.map((t) => <span key={t} className="hint"><span className="dom-dot" style={{ ['--c' as string]: COLORS[t] }} />{blockName(t)}</span>)}
      </figcaption>
    </figure>
  );
}
