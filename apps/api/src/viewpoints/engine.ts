import type { Tx } from '../common/db.js';
import type { Model } from '../metamodel/metamodel.js';
import { COST_KEYS } from '../auth/permissions.js';
import { Viewpoint, ViewpointSpec, blocksOf } from './catalog.js';

export type Level = 'conceptual' | 'logical' | 'physical';
interface Node { id: string; name: string; block_code: string; status: string; attrs: Record<string, unknown> }
interface Edge { id: string; source_id: string; target_id: string; verb: string; name_ar: string | null }

const brief = (n: Node) => ({ id: n.id, name: n.name, block_code: n.block_code, status: n.status });

async function load(tx: Tx, blocks: string[]) {
  const nodes: Node[] = (await tx.query(
    `select id, name, block_code, status, attrs from records where block_code = any($1) and status <> 'archived' order by name`, [blocks])).rows;
  const edges: Edge[] = (await tx.query(
    `select l.id, l.source_id, l.target_id, m.verb, m.name_ar from record_links l join mm_relations m on m.id = l.relation_id
      join records s on s.id = l.source_id and s.status <> 'archived' join records t on t.id = l.target_id and t.status <> 'archived'
     where s.block_code = any($1) and t.block_code = any($1)`, [blocks])).rows;
  // Inverse relation pairs (Hosts / Hosted By) are one fact: adjacency is undirected.
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    (adj.get(e.source_id) ?? adj.set(e.source_id, new Set()).get(e.source_id)!).add(e.target_id);
    (adj.get(e.target_id) ?? adj.set(e.target_id, new Set()).get(e.target_id)!).add(e.source_id);
  }
  return { nodes, edges, adj, byId: new Map(nodes.map((n) => [n.id, n])) };
}

export interface RunContext { model: Model; showCost: boolean; level: Level; readable: (block: string) => boolean }

/** Which blocks a viewpoint needs that are switched off (or out of the user's scope) for this entity. */
export function missingBlocks(vp: Viewpoint, ctx: Pick<RunContext, 'model' | 'readable'>) {
  return blocksOf(vp.spec).filter((b) => !ctx.model.blocks.find((x) => x.code === b)?.active || !ctx.readable(b));
}

export async function run(tx: Tx, spec: ViewpointSpec, ctx: RunContext) {
  const model = ctx.model;
  const blk = (c: string) => model.blocks.find((b) => b.code === c)!;
  switch (spec.kind) {
    case 'list': {
      const { nodes } = await load(tx, spec.blocks);
      const b = blk(spec.blocks[0]);
      const active = b.attributes.filter((a) => a.active && (ctx.showCost || !COST_KEYS.test(a.key)));
      // Detail levels (FR-07-02): conceptual = name & description, logical = the viewpoint's key attributes, physical = everything.
      const keys = ctx.level === 'conceptual' ? ['description']
        : ctx.level === 'physical' ? active.map((a) => a.key).filter((k) => k !== b.title_key)
        : (spec.columns ?? []);
      const columns = keys.map((k) => active.find((a) => a.key === k)).filter(Boolean)
        .map((a) => ({ key: a!.key, name_ar: a!.name_ar, name_en: a!.name_en, type: a!.type }));
      return { kind: 'list', block: b.code, columns, rows: nodes.map((n) => ({ ...brief(n), attrs: Object.fromEntries(columns.map((c) => [c.key, n.attrs[c.key]])) })) };
    }
    case 'matrix': {
      const via = new Set(spec.via ?? []);
      const { nodes, adj, byId } = await load(tx, blocksOf(spec));
      const rows = nodes.filter((n) => spec.rows.includes(n.block_code));
      const cols = nodes.filter((n) => spec.cols.includes(n.block_code));
      const colSet = new Set(cols.map((c) => c.id));
      const cells: { row: string; col: string; direct: boolean }[] = [];
      for (const r of rows) {
        // Breadth-first through intermediate blocks only (e.g. data center → server → application).
        const seen = new Set([r.id]);
        let frontier = [r.id];
        for (let depth = 0; depth < 4 && frontier.length; depth++) {
          const next: string[] = [];
          for (const id of frontier) for (const nb of adj.get(id) ?? []) {
            if (seen.has(nb)) continue;
            seen.add(nb);
            if (colSet.has(nb)) cells.push({ row: r.id, col: nb, direct: depth === 0 });
            else if (via.has(byId.get(nb)?.block_code ?? '')) next.push(nb);
          }
          frontier = next;
        }
      }
      const sub = (n: Node) => ({ ...brief(n), subtitle: n.attrs.function ?? null });
      return { kind: 'matrix', rows: rows.map(sub), cols: cols.map(brief), cells };
    }
    case 'group': {
      const by = spec.by;
      const { nodes, adj, byId } = await load(tx, blocksOf(spec));
      const items = nodes.filter((n) => spec.blocks.includes(n.block_code));
      const groups = new Map<string, { key: string; label_ar: string; label_en: string; items: ReturnType<typeof brief>[] }>();
      const put = (key: string, ar: string, en: string, n: Node) => {
        const g = groups.get(key) ?? { key, label_ar: ar, label_en: en, items: [] };
        g.items.push(brief(n)); groups.set(key, g);
      };
      for (const n of items) {
        if ('block' in by) { const b = blk(n.block_code); put(b.code, b.name_ar, b.name_en, n); continue; }
        if ('attr' in by) {
          const v = n.attrs[by.attr];
          const vals = (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);
          if (!vals.length) put('', 'غير مصنّف', 'Unclassified', n);
          // Predefined-list values are stored once (the list value); show them with the list's Arabic / English labels.
          const opts = blk(n.block_code)?.attributes.find((a) => a.key === by.attr)?.options ?? [];
          for (const x of vals) { const o = opts.find((y) => y.value === x); put(x, o?.label_ar || x, o?.label_en || x, n); }
          continue;
        }
        const owners = [...(adj.get(n.id) ?? [])].map((id) => byId.get(id)).filter((o) => o?.block_code === by.related) as Node[];
        if (!owners.length) put('', 'غير مرتبط', 'Not linked', n);
        for (const o of owners) put(o.id, o.name, o.name, n);
      }
      // Unclassified last; the rest by size.
      const out = [...groups.values()].sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : b.items.length - a.items.length));
      if ('block' in by) for (const code of spec.blocks) if (!groups.has(code) && blk(code)?.active) out.push({ key: code, label_ar: blk(code).name_ar, label_en: blk(code).name_en, items: [] });
      return { kind: 'group', groups: out };
    }
    case 'nest': {
      const { nodes, adj, byId } = await load(tx, blocksOf(spec));
      const containers = nodes.filter((n) => n.block_code === spec.container).map((c) => ({
        ...brief(c),
        children: [...(adj.get(c.id) ?? [])].map((id) => byId.get(id)!).filter((x) => x && spec.children.includes(x.block_code)).map(brief)
          .sort((a, b) => a.block_code.localeCompare(b.block_code) || a.name.localeCompare(b.name)),
      }));
      const placed = new Set(containers.flatMap((c) => c.children.map((x) => x.id)));
      const unplaced = nodes.filter((n) => spec.children.includes(n.block_code) && !placed.has(n.id)).map(brief);
      return { kind: 'nest', containers, unplaced };
    }
    case 'graph': {
      const { nodes, edges } = await load(tx, spec.blocks);
      if (!spec.collapse) return { kind: 'graph', nodes: nodes.map(brief), edges };
      // Collapse an intermediate block into labelled edges: app —(interface)— app.
      const mid = new Map(nodes.filter((n) => n.block_code === spec.collapse).map((n) => [n.id, n]));
      const ends = new Map<string, Set<string>>();
      for (const e of edges) {
        const [m, other] = mid.has(e.source_id) ? [e.source_id, e.target_id] : mid.has(e.target_id) ? [e.target_id, e.source_id] : [null, null];
        if (m && other && !mid.has(other)) (ends.get(m) ?? ends.set(m, new Set()).get(m)!).add(other);
      }
      const out: { id: string; source_id: string; target_id: string; verb: string; name_ar: string }[] = [];
      for (const [m, set] of ends) {
        const arr = [...set];
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
          out.push({ id: `${m}:${i}:${j}`, source_id: arr[i], target_id: arr[j], verb: mid.get(m)!.name, name_ar: mid.get(m)!.name });
        }
      }
      return { kind: 'graph', nodes: nodes.filter((n) => !mid.has(n.id)).map(brief), edges: out };
    }
  }
}
