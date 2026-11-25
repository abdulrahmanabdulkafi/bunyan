import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Tx, audit, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { inScope } from '../auth/permissions.js';
import { Model, loadModel } from '../metamodel/metamodel.js';
import { notify } from '../notifications/notifications.js';

/** The phases of an EA development cycle, in order (aligned with the DGA EA development methodology and TOGAF ADM). */
export const PHASES = ['scope', 'baseline', 'target', 'gap', 'roadmap', 'approval'] as const;
const PHASE_NAMES: Record<string, [string, string]> = {
  scope: ['تحديد النطاق', 'Scope'], baseline: ['الوضع الراهن', 'Baseline'], target: ['الوضع المستهدف', 'Target'],
  gap: ['تحليل الفجوات', 'Gap analysis'], roadmap: ['خارطة الطريق', 'Roadmap'], approval: ['الاعتماد والنشر', 'Approval'],
};
/** A starter task list for each phase, so a new cycle is never an empty page. */
const STARTER: Record<string, [string, string][]> = {
  scope: [['تحديد أهداف الدورة ونطاقها والمجالات المشمولة', 'وثيقة نطاق الدورة'], ['تحديد أصحاب المصلحة وفريق العمل', 'مصفوفة أصحاب المصلحة']],
  baseline: [['تحديث سجلات المستودع للمجالات المشمولة واعتمادها', 'مستودع محدّث ومعتمد'], ['مراجعة جودة البيانات واكتمال السمات', 'تقرير جودة البيانات']],
  target: [['تصميم الوضع المستهدف وتسجيل التغييرات المخطط لها', 'سجل التغييرات المخطط لها'], ['مواءمة الوضع المستهدف مع الأهداف الاستراتيجية', 'مصفوفة المواءمة']],
  gap: [['تحليل الفجوات بين الوضع الراهن والمستهدف', 'تقرير تحليل الفجوات'], ['تحليل أثر التغييرات على التطبيقات والتقنية والأمن', 'تقرير تحليل الأثر']],
  roadmap: [['ترتيب التغييرات في مبادرات ومشاريع بجدول زمني', 'خارطة الطريق'], ['تقدير التكاليف والمخاطر', 'دراسة التكلفة والمخاطر']],
  approval: [['عرض مخرجات الدورة على لجنة البنية المؤسسية', 'محضر الاعتماد'], ['نشر المخرجات وإغلاق الدورة', 'إعلان النشر']],
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const CycleDto = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(2).max(200),
  objective: z.string().max(4000).nullable().optional(),
  domains: z.array(z.string()).default([]),
  start_date: isoDate, end_date: isoDate,
  owner_id: z.string().uuid().nullable().optional(),
  starter_tasks: z.boolean().default(true),
});
const CyclePatch = CycleDto.omit({ starter_tasks: true, code: true }).partial().extend({
  status: z.enum(['planned', 'active', 'closed', 'cancelled']).optional(),
  phase: z.enum(PHASES).optional(),
});
const TaskDto = z.object({
  phase: z.enum(PHASES), title: z.string().trim().min(2).max(300), deliverable: z.string().max(500).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(), due_date: isoDate, status: z.enum(['todo', 'doing', 'done']).default('todo'),
});
const ChangeDto = z.object({
  record_id: z.string().uuid(), change_type: z.enum(['add', 'modify', 'retire']),
  rationale: z.string().max(2000).nullable().optional(), target_date: isoDate,
});
const ChangePatch = ChangeDto.omit({ record_id: true }).partial().extend({ status: z.enum(['planned', 'done', 'cancelled']).optional() });

const readable = (u: SessionUser, m: Model) =>
  new Set(m.blocks.filter((b) => b.active && inScope(u.roles, u.scope ?? {}, 'records.read', b.code, b.domain_code)).map((b) => b.code));

async function cycleOf(tx: Tx, id: string, editable = false) {
  const c = (await tx.query('select * from ea_cycles where id=$1', [id])).rows[0];
  if (!c) throw new NotFoundException();
  if (editable && ['closed', 'cancelled'].includes(c.status)) throw new BadRequestException('الدورة مغلقة ولا تقبل التعديل');
  return c;
}

/** Records a cycle plans to add, change or retire (cancelled plans excluded). Viewpoints use it to show the target state. */
export async function planOf(tx: Tx, cycleId: string) {
  const rows = (await tx.query(`select record_id, change_type, status from ea_cycle_changes where cycle_id=$1 and status <> 'cancelled'`, [cycleId])).rows;
  const plan = new Map<string, 'add' | 'modify' | 'retire'>();
  const pendingAdds = new Set<string>();
  for (const r of rows) { plan.set(r.record_id, r.change_type); if (r.change_type === 'add' && r.status !== 'done') pendingAdds.add(r.record_id); }
  return { plan, pendingAdds };
}

/** Building-block counts now and after the cycle's planned changes (a planned addition is not part of the current state until done). */
async function stateOf(tx: Tx, cycleId: string, blocks: Set<string>) {
  const { rows } = await tx.query(
    `select r.block_code,
            count(*) filter (where c.change_type is distinct from 'add' or c.status = 'done') as current,
            count(*) filter (where c.change_type = 'add' and c.status <> 'done') as adds,
            count(*) filter (where c.change_type = 'modify') as modifies,
            count(*) filter (where c.change_type = 'retire') as retires
       from records r left join ea_cycle_changes c on c.record_id = r.id and c.cycle_id = $1 and c.status <> 'cancelled'
      where r.status <> 'archived' and r.block_code = any($2)
      group by r.block_code order by r.block_code`, [cycleId, [...blocks]]);
  return rows.map((r) => {
    const [current, adds, modifies, retires] = [r.current, r.adds, r.modifies, r.retires].map(Number);
    return { block_code: r.block_code as string, current, adds, modifies, retires, target: current + adds - retires };
  });
}

@Controller('cycles')
export class CyclesController {
  @Perm('records.read')
  @Get()
  list(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select c.*, o.display_name as owner_name,
              (select count(*) from ea_cycle_tasks t where t.cycle_id = c.id) as tasks_total,
              (select count(*) from ea_cycle_tasks t where t.cycle_id = c.id and t.status = 'done') as tasks_done,
              (select count(*) from ea_cycle_tasks t where t.cycle_id = c.id and t.status <> 'done' and t.due_date < current_date) as tasks_overdue,
              (select count(*) from ea_cycle_changes x where x.cycle_id = c.id and x.status <> 'cancelled') as changes
         from ea_cycles c left join users o on o.id = c.owner_id
        order by case c.status when 'active' then 0 when 'planned' then 1 when 'closed' then 2 else 3 end, c.start_date desc nulls last, c.created_at desc`)).rows
      .map((c) => ({ ...c, tasks_total: Number(c.tasks_total), tasks_done: Number(c.tasks_done), tasks_overdue: Number(c.tasks_overdue), changes: Number(c.changes) })));
  }

  @Perm('cycles.manage')
  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const d = CycleDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      const year = (d.start_date ?? new Date().toISOString()).slice(0, 4);
      const n = Number((await tx.query(`select count(*) from ea_cycles where code like $1`, [`CYC-${year}-%`])).rows[0].count) + 1;
      const code = d.code ?? `CYC-${year}-${String(n).padStart(2, '0')}`;
      const c = (await tx.query(
        `insert into ea_cycles (tenant_id, code, name, objective, domains, start_date, end_date, owner_id, created_by)
         values (app_tenant(), $1, $2, $3, $4, $5, $6, coalesce($7, app_user()), app_user()) returning *`,
        [code, d.name, d.objective ?? null, d.domains, d.start_date ?? null, d.end_date ?? null, d.owner_id ?? null])).rows[0];
      if (d.starter_tasks) {
        let sort = 0;
        for (const ph of PHASES) for (const [title, deliverable] of STARTER[ph]) {
          await tx.query(`insert into ea_cycle_tasks (tenant_id, cycle_id, phase, title, deliverable, sort) values (app_tenant(), $1, $2, $3, $4, $5)`, [c.id, ph, title, deliverable, sort++]);
        }
      }
      await audit(tx, actorOf(u), 'create', 'ea_cycle', c.id, null, c);
      return c;
    });
  }

  @Perm('records.read')
  @Get(':id')
  get(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const c = await cycleOf(tx, id);
      const m = await loadModel(tx);
      const blocks = readable(u, m);
      const tasks = (await tx.query(
        `select t.*, a.display_name as assignee_name from ea_cycle_tasks t left join users a on a.id = t.assignee_id
          where t.cycle_id = $1 order by array_position($2::text[], t.phase), t.sort, t.created_at`, [id, PHASES])).rows;
      // Planned changes on blocks the user cannot read stay hidden, like the records themselves.
      const changes = (await tx.query(
        `select x.*, r.name, r.block_code, r.status as record_status from ea_cycle_changes x join records r on r.id = x.record_id
          where x.cycle_id = $1 and r.block_code = any($2) order by x.change_type, r.block_code, r.name`, [id, [...blocks]])).rows;
      const members = (await tx.query(`select id, display_name from users where tenant_id = app_tenant() and active order by display_name`)).rows;
      const owner = members.find((x) => x.id === c.owner_id);
      return { ...c, owner_name: owner?.display_name ?? null, tasks, changes, members, state: await stateOf(tx, id, blocks), phases: PHASES };
    });
  }

  @Perm('cycles.manage')
  @Patch(':id')
  update(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const p = CyclePatch.parse(body);
    return withActor(actorOf(u), async (tx) => {
      const cur = await cycleOf(tx, id, true);
      if (p.phase && p.phase !== cur.phase) {
        // Phases move one step at a time, forward or back, and only while the cycle is running.
        if (cur.status !== 'active') throw new BadRequestException('فعّل الدورة قبل الانتقال بين مراحلها');
        if (Math.abs(PHASES.indexOf(p.phase) - PHASES.indexOf(cur.phase)) !== 1) throw new BadRequestException('الانتقال بين المراحل يكون خطوة واحدة');
      }
      if (p.status === 'closed') {
        if (cur.status !== 'active') throw new BadRequestException('لا تُغلق إلا دورة نشطة');
        if (cur.phase !== 'approval' && p.phase !== 'approval') throw new BadRequestException('تُغلق الدورة في مرحلة الاعتماد');
        const open = Number((await tx.query(`select count(*) from ea_cycle_tasks where cycle_id=$1 and status <> 'done'`, [id])).rows[0].count);
        if (open) throw new BadRequestException(`لا يمكن إغلاق الدورة وفيها ${open} مهمة غير منجزة`);
      }
      if (p.status === 'active' && cur.status !== 'planned') throw new BadRequestException('لا تُفعّل إلا دورة مخططة');
      if (p.status === 'planned' && cur.status !== 'planned') throw new BadRequestException('حالة غير صالحة');
      const row = (await tx.query(
        `update ea_cycles set name=coalesce($2,name), objective=case when $3::boolean then $4 else objective end, domains=coalesce($5,domains),
                start_date=case when $6::boolean then $7::date else start_date end, end_date=case when $8::boolean then $9::date else end_date end,
                owner_id=coalesce($10,owner_id), status=coalesce($11,status), phase=coalesce($12,phase), updated_at=now(),
                closed_at=case when $11 in ('closed','cancelled') then now() else closed_at end
          where id=$1 returning *`,
        [id, p.name ?? null, p.objective !== undefined, p.objective ?? null, p.domains ?? null, p.start_date !== undefined, p.start_date ?? null,
          p.end_date !== undefined, p.end_date ?? null, p.owner_id ?? null, p.status ?? null, p.phase ?? null])).rows[0];
      if (row.end_date && row.start_date && row.end_date < row.start_date) throw new BadRequestException('تاريخ النهاية قبل تاريخ البداية');
      await audit(tx, actorOf(u), 'update', 'ea_cycle', id, cur, row);
      if (p.phase && p.phase !== cur.phase) {
        const people = (await tx.query(`select distinct assignee_id from ea_cycle_tasks where cycle_id=$1 and phase=$2 and assignee_id is not null`, [id, p.phase])).rows.map((r) => r.assignee_id);
        await notify(tx, [...people, row.owner_id], 'cycle_phase', { cycle: row.code, cycle_id: id, phase: p.phase, phase_ar: PHASE_NAMES[p.phase][0], phase_en: PHASE_NAMES[p.phase][1], path: `/cycles/${id}` });
      }
      return row;
    });
  }

  @Perm('cycles.manage')
  @Delete(':id')
  remove(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const cur = await cycleOf(tx, id);
      if (cur.status !== 'planned') throw new BadRequestException('لا تُحذف إلا دورة لم تبدأ؛ ألغِ الدورة بدلاً من ذلك');
      await tx.query('delete from ea_cycles where id=$1', [id]);
      await audit(tx, actorOf(u), 'delete', 'ea_cycle', id, cur, null);
      return { ok: true };
    });
  }

  // ── Tasks ──
  @Perm('cycles.manage')
  @Post(':id/tasks')
  addTask(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const d = TaskDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      const c = await cycleOf(tx, id, true);
      const sort = Number((await tx.query('select coalesce(max(sort),0)+1 as s from ea_cycle_tasks where cycle_id=$1', [id])).rows[0].s);
      const t = (await tx.query(
        `insert into ea_cycle_tasks (tenant_id, cycle_id, phase, title, deliverable, assignee_id, due_date, status, sort)
         values (app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [id, d.phase, d.title, d.deliverable ?? null, d.assignee_id ?? null, d.due_date ?? null, d.status, sort])).rows[0];
      if (t.assignee_id) await notify(tx, [t.assignee_id], 'task_assigned', { title: t.title, cycle: c.code, cycle_id: id, path: `/cycles/${id}` });
      return t;
    });
  }

  @Perm('cycles.manage')
  @Patch(':id/tasks/:taskId')
  updateTask(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('taskId') taskId: string, @Body() body: unknown) {
    const p = TaskDto.partial().parse(body);
    return withActor(actorOf(u), async (tx) => {
      const c = await cycleOf(tx, id, true);
      const cur = (await tx.query('select * from ea_cycle_tasks where id=$1 and cycle_id=$2', [taskId, id])).rows[0];
      if (!cur) throw new NotFoundException();
      const t = (await tx.query(
        `update ea_cycle_tasks set phase=coalesce($2,phase), title=coalesce($3,title), deliverable=case when $4::boolean then $5 else deliverable end,
                assignee_id=case when $6::boolean then $7::uuid else assignee_id end, due_date=case when $8::boolean then $9::date else due_date end,
                status=coalesce($10,status), updated_at=now() where id=$1 returning *`,
        [taskId, p.phase ?? null, p.title ?? null, p.deliverable !== undefined, p.deliverable ?? null, p.assignee_id !== undefined, p.assignee_id ?? null,
          p.due_date !== undefined, p.due_date ?? null, p.status ?? null])).rows[0];
      if (t.assignee_id && t.assignee_id !== cur.assignee_id) await notify(tx, [t.assignee_id], 'task_assigned', { title: t.title, cycle: c.code, cycle_id: id, path: `/cycles/${id}` });
      return t;
    });
  }

  @Perm('cycles.manage')
  @Delete(':id/tasks/:taskId')
  removeTask(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('taskId') taskId: string) {
    return withActor(actorOf(u), async (tx) => {
      await cycleOf(tx, id, true);
      if (!(await tx.query('delete from ea_cycle_tasks where id=$1 and cycle_id=$2', [taskId, id])).rowCount) throw new NotFoundException();
      return { ok: true };
    });
  }

  // ── Planned changes (the cycle's target state) ──
  @Perm('cycles.manage')
  @Post(':id/changes')
  addChange(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const d = ChangeDto.parse(body);
    return withActor(actorOf(u), async (tx) => {
      await cycleOf(tx, id, true);
      const m = await loadModel(tx);
      const rec = (await tx.query('select id, block_code, status from records where id=$1', [d.record_id])).rows[0];
      if (!rec || !readable(u, m).has(rec.block_code)) throw new NotFoundException();
      if (rec.status === 'archived') throw new BadRequestException('السجل مؤرشف');
      const x = (await tx.query(
        `insert into ea_cycle_changes (tenant_id, cycle_id, record_id, change_type, rationale, target_date, created_by)
         values (app_tenant(),$1,$2,$3,$4,$5,app_user()) returning *`,
        [id, d.record_id, d.change_type, d.rationale ?? null, d.target_date ?? null])).rows[0];
      await audit(tx, actorOf(u), 'plan', 'ea_cycle', id, null, x);
      return x;
    });
  }

  @Perm('cycles.manage')
  @Patch(':id/changes/:changeId')
  updateChange(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('changeId') changeId: string, @Body() body: unknown) {
    const p = ChangePatch.parse(body);
    return withActor(actorOf(u), async (tx) => {
      await cycleOf(tx, id, true);
      const x = (await tx.query(
        `update ea_cycle_changes set change_type=coalesce($3,change_type), rationale=case when $4::boolean then $5 else rationale end,
                target_date=case when $6::boolean then $7::date else target_date end, status=coalesce($8,status)
          where id=$1 and cycle_id=$2 returning *`,
        [changeId, id, p.change_type ?? null, p.rationale !== undefined, p.rationale ?? null, p.target_date !== undefined, p.target_date ?? null, p.status ?? null])).rows[0];
      if (!x) throw new NotFoundException();
      return x;
    });
  }

  @Perm('cycles.manage')
  @Delete(':id/changes/:changeId')
  removeChange(@CurrentUser() u: SessionUser, @Param('id') id: string, @Param('changeId') changeId: string) {
    return withActor(actorOf(u), async (tx) => {
      await cycleOf(tx, id, true);
      const before = (await tx.query('delete from ea_cycle_changes where id=$1 and cycle_id=$2 returning *', [changeId, id])).rows[0];
      if (!before) throw new NotFoundException();
      await audit(tx, actorOf(u), 'unplan', 'ea_cycle', id, before, null);
      return { ok: true };
    });
  }
}
