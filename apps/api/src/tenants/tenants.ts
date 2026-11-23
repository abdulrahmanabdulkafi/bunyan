import { Body, Controller, ForbiddenException, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../common/config.js';
import { Actor, Tx, audit, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';
import { ROLES } from '../auth/permissions.js';

export interface SeedBlock {
  code: string; name_ar: string; name_en: string; domain: string; active: boolean; title_key: string | null;
  attributes: { key: string; order: number; name_ar: string; name_en: string; description_en: string; type: string; required: boolean; options: unknown[] }[];
}
export interface Seed {
  version: string;
  domains: { code: string; name_ar: string; name_en: string; active: boolean }[];
  blocks: SeedBlock[];
  relations: { source: string; verb: string; target: string; description_en: string }[];
}

let cached: Seed | null = null;
export function loadSeed(): Seed {
  return (cached ??= JSON.parse(fs.readFileSync(config.seedFile, 'utf8')));
}

/** Copy the national DGA meta-model template into a tenant. Phase-1 domains are active; the rest are available but off. */
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
    await tx.query(`insert into mm_relations (tenant_id, source_code, verb, target_code, description) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [tenantId, r.source, r.verb, r.target, r.description_en]);
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
  password: z.string().min(10).optional(),
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
    // R0 only creates the first admin of an entity (◐ in the matrix); R1 manages everyone else in their entity.
    if (isPlatform && !dto.roles.every((r) => r === 'R1' || r === 'R8' || r === 'R9')) {
      throw new ForbiddenException('مدير المنصة يضيف مسؤول الجهة الأول أو مستعرضي اللوحات فقط');
    }
    if (!isPlatform && dto.roles.some((r) => r === 'R0' || r === 'R8' || r === 'R9')) throw new ForbiddenException();
    const hash = dto.password ? await bcrypt.hash(dto.password, 12) : null;
    return withActor(actor, async (tx) => {
      const { rows } = await tx.query(
        `insert into users (tenant_id, email, display_name, password_hash, roles, scope) values ($1,lower($2),$3,$4,$5,$6)
         returning id, tenant_id, email, display_name, roles, scope, active`,
        [tenantId, dto.email, dto.display_name, hash, dto.roles, JSON.stringify(dto.scope)]);
      await audit(tx, actor, 'create', 'user', rows[0].id, null, rows[0], tenantId);
      return rows[0];
    });
  }
}

@Controller()
export class TenantsController {
  constructor(private svc: TenantsService) {}

  @Get('tenants')
  list(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) => (await tx.query('select * from tenants order by kind, name_ar')).rows);
  }

  @Perm('tenant.manage')
  @Post('tenants')
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    return this.svc.create(actorOf(u), body);
  }

  @Perm('users.manage')
  @Get('users')
  users(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), async (tx) =>
      (await tx.query('select id, tenant_id, email, display_name, roles, scope, active, created_at from users order by display_name')).rows);
  }

  @Perm('users.manage')
  @Post('users')
  createUser(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    return this.svc.createUser(actorOf(u), u, body);
  }

  @Perm('users.manage')
  @Patch('users/:id')
  updateUser(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { roles?: string[]; scope?: object; active?: boolean }) {
    const roles = z.array(z.enum(Object.keys(ROLES) as [string, ...string[]])).optional().parse(body.roles);
    if (roles && !u.roles.includes('R0') && roles.some((r) => r === 'R0' || r === 'R8' || r === 'R9')) throw new ForbiddenException();
    return withActor(actorOf(u), async (tx) => {
      const before = (await tx.query('select id, roles, scope, active from users where id = $1', [id])).rows[0];
      const { rows } = await tx.query(
        `update users set roles = coalesce($2, roles), scope = coalesce($3, scope), active = coalesce($4, active)
          where id = $1 returning id, email, display_name, roles, scope, active`,
        [id, roles ?? null, body.scope ? JSON.stringify(body.scope) : null, body.active ?? null]);
      await audit(tx, actorOf(u), 'update', 'user', id, before, rows[0]);
      return rows[0];
    });
  }
}
