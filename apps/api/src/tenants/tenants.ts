import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../common/config.js';
import { Actor, Tx, audit, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf, forgetAccount } from '../auth/auth.js';
import { passwordProblems, temporaryPassword } from '../common/crypto.js';
import { ROLES } from '../auth/permissions.js';

export interface SeedBlock {
  code: string; name_ar: string; name_en: string; domain: string; active: boolean; title_key: string | null;
  attributes: { key: string; order: number; name_ar: string; name_en: string; description_en: string; type: string; required: boolean; options: unknown[] }[];
}
export interface Seed {
  version: string;
  domains: { code: string; name_ar: string; name_en: string; active: boolean }[];
  blocks: SeedBlock[];
  relations: { source: string; verb: string; target: string; name_ar?: string; description_en: string }[];
}

let cached: Seed | null = null;
export function loadSeed(): Seed {
  return (cached ??= JSON.parse(fs.readFileSync(config.seedFile, 'utf8')));
}

/** Copy the national DGA meta-model template into a tenant: all seven domains, 45 building blocks, their attributes and connections. */
export async function applyTemplate(tx: Tx, tenantId: string) {
  const s = loadSeed();
  for (const [i, d] of s.domains.entries()) {
    await tx.query(`insert into mm_domains (tenant_id, code, name_ar, name_en, active, sort) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [tenantId, d.code, d.name_ar, d.name_en, d.active, i]);
  }
  for (const [i, b] of s.blocks.entries()) {
    await tx.query(`insert into mm_blocks (tenant_id, code, domain_code, name_ar, name_en, active, title_key, sort) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [tenantId, b.code, b.domain, b.name_ar, b.name_en, b.active, b.title_key, i]);
    for (const a of b.attributes) {
      await tx.query(`insert into mm_attributes (tenant_id, block_code, key, name_ar, name_en, description, type, required, options, sort)
                      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
        [tenantId, b.code, a.key, a.name_ar, a.name_en, a.description_en, a.type, a.required, JSON.stringify(a.options ?? []), a.order]);
    }
  }
  for (const r of s.relations) {
    await tx.query(`insert into mm_relations (tenant_id, source_code, verb, target_code, name_ar, description) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [tenantId, r.source, r.verb, r.target, r.name_ar ?? null, r.description_en]);
  }
}

/**
 * Bring an existing tenant up to the current national template without undoing its own choices:
 * adds missing domains, blocks, attributes and connections; fills predefined lists that are still empty and adds
 * Arabic labels to national list values; repairs national attribute descriptions; retires connections the
 * template no longer defines (switched off, kept if records already use them).
 */
export async function syncTemplate(tx: Tx, tenantId: string) {
  const s = loadSeed();
  await applyTemplate(tx, tenantId);
  for (const b of s.blocks) {
    for (const a of b.attributes) {
      const cur = (await tx.query('select options, description, is_custom from mm_attributes where tenant_id=$1 and block_code=$2 and key=$3', [tenantId, b.code, a.key])).rows[0];
      if (!cur || cur.is_custom) continue;
      const seedOpts = (a.options ?? []) as { value: string; label_ar?: string; label_en?: string }[];
      let opts = (cur.options ?? []) as { value: string; label_ar?: string; label_en?: string }[];
      if (!opts.length) opts = seedOpts;
      else opts = opts.map((o) => { const m = seedOpts.find((x) => x.value === o.value); return m ? { ...m, ...o, label_ar: o.label_ar || m.label_ar } : o; });
      await tx.query('update mm_attributes set options=$4, description=$5 where tenant_id=$1 and block_code=$2 and key=$3',
        [tenantId, b.code, a.key, JSON.stringify(opts), a.description_en ?? cur.description]);
    }
  }
  const keep = new Set(s.relations.map((r) => `${r.source}|${r.verb}|${r.target}`));
  const rels = (await tx.query('select id, source_code, verb, target_code from mm_relations where tenant_id=$1 and not is_custom', [tenantId])).rows;
  for (const r of rels) {
    if (keep.has(`${r.source_code}|${r.verb}|${r.target_code}`)) continue;
    const used = (await tx.query('select 1 from record_links where relation_id=$1 limit 1', [r.id])).rowCount;
    if (used) await tx.query('update mm_relations set active=false where id=$1', [r.id]);
    else await tx.query('delete from mm_relations where id=$1', [r.id]);
  }
}

const TenantDto = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name_ar: z.string().min(2),
  name_en: z.string().optional(),
  kind: z.enum(['sector', 'entity']),
  parent_id: z.string().uuid().nullable().optional(),
});

const UserDto = z.object({
  email: z.string().email(),
  display_name: z.string().min(2),
  password: z.string().min(1).optional(),
  sso_only: z.boolean().default(false),
  roles: z.array(z.enum(Object.keys(ROLES) as [string, ...string[]])).default(['R6']),
  scope: z.object({ domains: z.array(z.string()).optional(), blocks: z.array(z.string()).optional() }).default({}),
  tenant_id: z.string().uuid().optional(),
});

@Injectable()
export class TenantsService {
  async create(actor: Actor, body: unknown) {
    const dto = TenantDto.parse(body);
    return withActor(actor, async (tx) => {
      const { rows } = await tx.query(
        `insert into tenants (code, name_ar, name_en, kind, parent_id) values ($1,$2,$3,$4,$5) returning *`,
        [dto.code, dto.name_ar, dto.name_en ?? null, dto.kind, dto.parent_id ?? null]);
      if (dto.kind === 'entity') await applyTemplate(tx, rows[0].id);
      await audit(tx, actor, 'create', 'tenant', rows[0].id, null, rows[0], rows[0].id);
      return rows[0];
    });
  }

  async createUser(actor: Actor, u: SessionUser, body: unknown) {
    const dto = UserDto.parse(body);
    const isPlatform = u.roles.includes('R0');
    const tenantId = isPlatform ? (dto.tenant_id ?? null) : u.tenantId;
    // R0 only creates the first admin of an entity and dashboard viewers (◐ in the matrix); R1 manages everyone else in their entity.
    if (isPlatform && !dto.roles.every((r) => r === 'R1' || r === 'R8' || r === 'R9')) {
      throw new ForbiddenException('مدير المنصة يضيف مسؤول الجهة الأول أو مستعرضي اللوحات فقط');
    }
    if (!isPlatform && dto.roles.some((r) => r === 'R0' || r === 'R8' || r === 'R9')) throw new ForbiddenException();
    if (dto.roles.includes('R1') || dto.roles.some((r) => !['R8', 'R9'].includes(r))) {
      if (!tenantId) throw new BadRequestException({ message: 'حقول ناقصة', errors: [{ key: 'tenant_id', message: 'حقل إلزامي' }] });
    }
    // Without SSO every account starts with a one-time password that must be changed at first sign-in.
    const temporary = dto.sso_only ? null : dto.password ?? temporaryPassword();
    if (dto.password) {
      const problems = passwordProblems(dto.password, dto.email);
      if (problems.length) throw new BadRequestException({ message: 'كلمة المرور لا تستوفي السياسة', errors: problems.map((m) => ({ key: 'password', message: m })) });
    }
    const hash = temporary ? await bcrypt.hash(temporary, 12) : null;
    return withActor(actor, async (tx) => {
      const { rows } = await tx.query(
        `insert into users (tenant_id, email, display_name, password_hash, roles, scope, must_change_password) values ($1,lower($2),$3,$4,$5,$6,$7)
         returning id, tenant_id, email, display_name, roles, scope, active`,
        [tenantId, dto.email, dto.display_name, hash, dto.roles, JSON.stringify(dto.scope), !!temporary]);
      await audit(tx, actor, 'create', 'user', rows[0].id, null, rows[0], tenantId);
      return { ...rows[0], temporary_password: temporary };
    });
  }
}

const USER_COLS = `u.id, u.tenant_id, t.name_ar as tenant_name_ar, t.name_en as tenant_name_en, u.email, u.display_name, u.roles, u.scope, u.active,
  u.mfa_enabled, u.must_change_password, u.failed_attempts, (u.locked_until > now()) as locked, u.last_login_at, u.created_at`;
const TenantPatch = z.object({
  name_ar: z.string().min(2), name_en: z.string().nullable(), active: z.boolean(),
  classification: z.enum(['top_secret', 'secret', 'restricted', 'public']), parent_id: z.string().uuid().nullable(),
}).partial();

@Controller()
export class TenantsController {
  constructor(private svc: TenantsService) {}

  @Get('tenants')
  list(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => (await tx.query(
      `select t.*, (select count(*) from users x where x.tenant_id = t.id) as users,
              (select count(*) from records r where r.tenant_id = t.id and r.status <> 'archived') as records
         from tenants t order by kind desc, name_ar`)).rows);
  }

  @Perm('tenant.manage')
  @Post('tenants')
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    return this.svc.create(actorOf(u), body);
  }

  /** R0 edits any entity; an entity's own admin (R1) may set its data classification. */
  @Patch('tenants/:id')
  patchTenant(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    const p = TenantPatch.parse(body);
    const platform = u.roles.includes('R0');
    if (!platform && !(u.roles.includes('R1') && u.tenantId === id && Object.keys(p).every((k) => k === 'classification'))) throw new ForbiddenException();
    return withActor(actorOf(u), async (tx) => {
      const before = (await tx.query('select * from tenants where id=$1', [id])).rows[0];
      if (!before) throw new NotFoundException();
      const row = (await tx.query(
        `update tenants set name_ar=coalesce($2,name_ar), name_en=case when $3::boolean then $4 else name_en end, active=coalesce($5,active),
           classification=coalesce($6,classification), parent_id=case when $7::boolean then $8::uuid else parent_id end where id=$1 returning *`,
        [id, p.name_ar ?? null, p.name_en !== undefined, p.name_en ?? null, p.active ?? null, p.classification ?? null, p.parent_id !== undefined, p.parent_id ?? null])).rows[0];
      await audit(tx, actorOf(u), 'update', 'tenant', id, before, row, id);
      return row;
    });
  }

  @Perm('users.manage')
  @Get('users')
  users(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) =>
      (await tx.query(`select ${USER_COLS} from users u left join tenants t on t.id = u.tenant_id order by t.name_ar nulls first, u.display_name`)).rows);
  }

  @Perm('users.manage')
  @Post('users')
  createUser(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    return this.svc.createUser(actorOf(u), u, body);
  }

  @Perm('users.manage')
  @Patch('users/:id')
  updateUser(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { roles?: string[]; scope?: object; active?: boolean; display_name?: string }) {
    const roles = z.array(z.enum(Object.keys(ROLES) as [string, ...string[]])).min(1).optional().parse(body.roles);
    if (roles && !u.roles.includes('R0') && roles.some((r) => r === 'R0' || r === 'R8' || r === 'R9')) throw new ForbiddenException();
    if (roles && u.roles.includes('R0') && !roles.every((r) => ['R1', 'R8', 'R9'].includes(r))) throw new ForbiddenException('مدير المنصة يضيف مسؤول الجهة الأول أو مستعرضي اللوحات فقط');
    if (id === u.id && (body.active === false || (roles && !roles.some((r) => u.roles.includes(r))))) throw new BadRequestException('لا يمكنك تعطيل حسابك أو إزالة صلاحياتك بنفسك');
    return withActor(actorOf(u), async (tx) => {
      const before = (await tx.query('select id, roles, scope, active, display_name from users where id = $1', [id])).rows[0];
      if (!before) throw new NotFoundException();
      const { rows } = await tx.query(
        `update users set roles = coalesce($2, roles), scope = coalesce($3, scope), active = coalesce($4, active), display_name = coalesce($5, display_name),
           token_version = token_version + case when $4 = false then 1 else 0 end
          where id = $1 returning id, email, display_name, roles, scope, active`,
        [id, roles ?? null, body.scope ? JSON.stringify(body.scope) : null, body.active ?? null, body.display_name ?? null]);
      await audit(tx, actorOf(u), 'update', 'user', id, before, rows[0]);
      forgetAccount(id);
      return rows[0];
    });
  }

  /** Issue a one-time password (shown once), unlock the account and end its sessions. */
  @Perm('users.manage')
  @Post('users/:id/reset-password')
  async resetPassword(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    const temporary = temporaryPassword();
    const hash = await bcrypt.hash(temporary, 12);
    return withActor(actorOf(u), async (tx) => {
      const r = await tx.query(`update users set password_hash=$2, must_change_password=true, failed_attempts=0, locked_until=null, token_version=token_version+1 where id=$1 returning id`, [id, hash]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(tx, actorOf(u), 'reset_password', 'user', id, null, null);
      forgetAccount(id);
      return { temporary_password: temporary };
    });
  }

  @Perm('users.manage')
  @Post('users/:id/unlock')
  unlock(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const r = await tx.query('update users set failed_attempts=0, locked_until=null where id=$1 returning id', [id]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(tx, actorOf(u), 'unlock', 'user', id, null, null);
      forgetAccount(id);
      return { ok: true };
    });
  }

  /** For a lost authenticator: the user enrols again at next sign-in. */
  @Perm('users.manage')
  @Post('users/:id/reset-mfa')
  resetMfa(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    return withActor(actorOf(u), async (tx) => {
      const r = await tx.query('update users set mfa_enabled=false, mfa_secret=null, token_version=token_version+1 where id=$1 returning id', [id]);
      if (!r.rowCount) throw new NotFoundException();
      await audit(tx, actorOf(u), 'reset_mfa', 'user', id, null, null);
      forgetAccount(id);
      return { ok: true };
    });
  }
}
