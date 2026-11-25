import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { Tx, afterCommit, withActor } from '../common/db.js';
import { CurrentUser, SessionUser, actorOf } from '../auth/auth.js';
import { Permission, ROLES, can, inScope } from '../auth/permissions.js';

export type NotifKind = 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'task_assigned' | 'cycle_phase';

/** Bilingual wording shared by the e-mail and (through the same keys) the web interface. */
const TEXT: Record<NotifKind, { ar: (p: Record<string, string>) => string; en: (p: Record<string, string>) => string }> = {
  submitted: { ar: (p) => `«${p.name}» بانتظار مراجعتك`, en: (p) => `“${p.name}” is waiting for your review` },
  reviewed: { ar: (p) => `«${p.name}» بانتظار اعتمادك النهائي`, en: (p) => `“${p.name}” is waiting for your final approval` },
  approved: { ar: (p) => `اعتُمد «${p.name}»`, en: (p) => `“${p.name}” was approved` },
  rejected: { ar: (p) => `رُفض «${p.name}»: ${p.comment ?? ''}`, en: (p) => `“${p.name}” was rejected: ${p.comment ?? ''}` },
  task_assigned: { ar: (p) => `أُسندت إليك مهمة «${p.title}» في دورة ${p.cycle}`, en: (p) => `You were assigned “${p.title}” in cycle ${p.cycle}` },
  cycle_phase: { ar: (p) => `انتقلت دورة ${p.cycle} إلى مرحلة ${p.phase_ar}`, en: (p) => `Cycle ${p.cycle} moved to the ${p.phase_en} phase` },
};

// ── E-mail: off unless SMTP_URL is set. "memory" keeps messages in `outbox` (tests, trials). ──
export const outbox: { to: string; subject: string; text: string }[] = [];
let transport: ReturnType<typeof nodemailer.createTransport> | null | undefined;
function mailer() {
  if (transport !== undefined) return transport;
  const url = process.env.SMTP_URL ?? '';
  transport = !url || url === 'memory' ? null : nodemailer.createTransport(url);
  return transport;
}
async function sendMail(to: string, subject: string, text: string) {
  if (process.env.SMTP_URL === 'memory') { outbox.push({ to, subject, text }); return; }
  const t = mailer();
  if (!t) return;
  await t.sendMail({ from: process.env.SMTP_FROM ?? 'Bunyan <no-reply@bunyan.local>', to, subject, text });
}

/**
 * Notify users inside the current transaction. Rows are visible as soon as it commits; e-mails leave only after the commit.
 * The actor is never notified about their own action.
 */
export async function notify(tx: Tx, userIds: string[], kind: NotifKind, payload: Record<string, string>) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  // Recipients first: notifications of other users cannot be read back (row-level security), so no RETURNING.
  const rows = (await tx.query(`select id, email from users where id = any($1) and active and id is distinct from app_user()`, [ids])).rows;
  if (!rows.length) return;
  await tx.query(
    `insert into notifications (tenant_id, user_id, kind, payload, actor_id) select app_tenant(), unnest($1::uuid[]), $2, $3, app_user()`,
    [rows.map((r) => r.id), kind, JSON.stringify(payload)]);
  if (!(process.env.SMTP_URL ?? '')) return;
  const emails = rows.map((r) => r.email as string);
  const ar = TEXT[kind].ar(payload), en = TEXT[kind].en(payload);
  const link = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}${payload.path ?? ''}` : '';
  for (const to of emails) afterCommit(tx, () => sendMail(to, `بُنيان | Bunyan — ${ar}`, `${ar}\n${en}${link ? `\n\n${link}` : ''}\n\n— بُنيان`));
}

/** Users of this entity holding `perm` for a block (honours data owner / entry scope). */
export async function usersWith(tx: Tx, perm: Permission, block: string, domain: string): Promise<string[]> {
  const holders = Object.keys(ROLES).filter((r) => can([r], perm));
  const { rows } = await tx.query(`select id, roles, scope from users where tenant_id = app_tenant() and active and roles && $1`, [holders]);
  return rows.filter((u) => inScope(u.roles, u.scope ?? {}, perm, block, domain)).map((u) => u.id);
}

@Controller('notifications')
export class NotificationsController {
  @Get()
  list(@CurrentUser() u: SessionUser, @Query('unread') unread?: string) {
    if (!u.tenantId) return { unread: 0, items: [] };
    return withActor(actorOf(u), async (tx) => {
      const items = (await tx.query(
        `select n.id, n.kind, n.payload, n.read_at, n.created_at, a.display_name as actor_name
           from notifications n left join users a on a.id = n.actor_id
          where ($1::boolean is not true or n.read_at is null) order by n.id desc limit 50`, [unread === 'true'])).rows;
      const count = Number((await tx.query('select count(*) from notifications where read_at is null')).rows[0].count);
      return { unread: count, items };
    });
  }

  @Post('read-all')
  readAll(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => ({ updated: (await tx.query('update notifications set read_at = now() where read_at is null')).rowCount }));
  }

  @Post(':id/read')
  read(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => ({ updated: (await tx.query('update notifications set read_at = now() where id = $1 and read_at is null', [Number(id) || 0])).rowCount }));
  }
}
