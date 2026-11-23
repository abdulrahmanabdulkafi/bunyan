import { BadRequestException, Body, Controller, Delete, Get, Injectable, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Actor, Tx, audit, withActor } from '../common/db.js';
import { CurrentUser, Perm, SessionUser, actorOf } from '../auth/auth.js';

export interface AttrDef { key: string; name_ar: string; name_en: string; type: string; required: boolean; options: { value: string; label_ar?: string; label_en?: string }[]; active: boolean; sort: number; description: string | null; is_custom: boolean; multiple: boolean; strict: boolean }
export interface BlockDef { code: string; domain_code: string; name_ar: string; name_en: string; active: boolean; title_key: string | null; is_custom: boolean; attributes: AttrDef[] }
export interface RelationDef { id: string; source_code: string; verb: string; target_code: string; name_ar: string | null; description: string | null; active: boolean }
export interface Model { domains: { code: string; name_ar: string; name_en: string; active: boolean }[]; blocks: BlockDef[]; relations: RelationDef[] }

export async function loadModel(tx: Tx): Promise<Model> {
  const domains = (await tx.query('select code, name_ar, name_en, active from mm_domains order by sort')).rows;
  const blocks: BlockDef[] = (await tx.query('select code, domain_code, name_ar, name_en, active, title_key, is_custom from mm_blocks order by sort')).rows;
  const attrs = (await tx.query('select block_code, key, name_ar, name_en, type, required, options, multiple, strict, active, sort, description, is_custom from mm_attributes order by sort')).rows;
  const byBlock = new Map(blocks.map((b) => [b.code, Object.assign(b, { attributes: [] as AttrDef[] })]));
  for (const a of attrs) byBlock.get(a.block_code)?.attributes.push(a);
  const relations = (await tx.query('select id, source_code, verb, target_code, name_ar, description, active from mm_relations order by source_code, verb')).rows;
  return { domains, blocks, relations };
}

const Key = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, 'lowercase snake_case');
const Option = z.object({ value: z.string().min(1), label_ar: z.string().optional(), label_en: z.string().optional() });
const AttrDto = z.object({
  key: Key, name_ar: z.string().min(1), name_en: z.string().min(1),
  type: z.enum(['text', 'multi_text', 'number', 'date', 'enum', 'url', 'duration', 'reference']),
  required: z.boolean().default(false), options: z.array(Option).default([]), multiple: z.boolean().default(false), strict: z.boolean().default(false), description: z.string().optional(), sort: z.number().int().default(999),
});
// Explicit optional fields (no defaults): a PATCH must never reset attributes it did not mention.
const AttrPatch = z.object({
  name_ar: z.string().min(1), name_en: z.string().min(1),
  type: z.enum(['text', 'multi_text', 'number', 'date', 'enum', 'url', 'duration', 'reference']),
  required: z.boolean(), options: z.array(Option), multiple: z.boolean(), strict: z.boolean(),
  description: z.string(), sort: z.number().int(), active: z.boolean(),
}).partial();
const BlockDto = z.object({ code: Key, domain_code: z.string(), name_ar: z.string().min(1), name_en: z.string().min(1), title_key: z.string().default('name') });
const BlockPatch = z.object({ name_ar: z.string(), name_en: z.string(), active: z.boolean(), title_key: z.string() }).partial();
const RelDto = z.object({ source_code: z.string(), verb: z.string().min(2), target_code: z.string(), name_ar: z.string().optional(), description: z.string().optional() });

@Injectable()
export class MetamodelService {
  private async change<T>(actor: Actor, entity: string, id: string, fn: (tx: Tx) => Promise<{ before: unknown; after: T }>) {
    return withActor(actor, async (tx) => {
      const { before, after } = await fn(tx);
      if (!after) throw new BadRequestException('not found');
      await audit(tx, actor, 'metamodel.change', entity, id, before, after);
      return after;
    });
  }

  patchDomain(actor: Actor, code: string, body: unknown) {
    const p = z.object({ name_ar: z.string(), name_en: z.string(), active: z.boolean() }).partial().parse(body);
    return this.change(actor, 'mm_domain', code, async (tx) => {
      const before = (await tx.query('select * from mm_domains where code=$1', [code])).rows[0];
      const after = (await tx.query(`update mm_domains set name_ar=coalesce($2,name_ar), name_en=coalesce($3,name_en), active=coalesce($4,active)
        where code=$1 returning *`, [code, p.name_ar, p.name_en, p.active])).rows[0];
      return { before, after };
    });
  }

  createBlock(actor: Actor, body: unknown) {
    const d = BlockDto.parse(body);
    return this.change(actor, 'mm_block', d.code, async (tx) => {
      const after = (await tx.query(`insert into mm_blocks (tenant_id, code, domain_code, name_ar, name_en, title_key, is_custom, sort)
        values (app_tenant(), $1,$2,$3,$4,$5,true,999) returning *`, [d.code, d.domain_code, d.name_ar, d.name_en, d.title_key])).rows[0];
      await tx.query(`insert into mm_attributes (tenant_id, block_code, key, name_ar, name_en, type, required, is_custom, sort)
        values (app_tenant(), $1, $2, 'الاسم', 'Name', 'text', true, true, 1) on conflict do nothing`, [d.code, d.title_key]);
      return { before: null, after };
    });
  }

  patchBlock(actor: Actor, code: string, body: unknown) {
    const p = BlockPatch.parse(body);
    return this.change(actor, 'mm_block', code, async (tx) => {
      const before = (await tx.query('select * from mm_blocks where code=$1', [code])).rows[0];
      const after = (await tx.query(`update mm_blocks set name_ar=coalesce($2,name_ar), name_en=coalesce($3,name_en), active=coalesce($4,active), title_key=coalesce($5,title_key)
        where code=$1 returning *`, [code, p.name_ar, p.name_en, p.active, p.title_key])).rows[0];
      return { before, after };
    });
  }

  createAttr(actor: Actor, block: string, body: unknown) {
    const d = AttrDto.parse(body);
    return this.change(actor, 'mm_attribute', `${block}.${d.key}`, async (tx) => {
      const after = (await tx.query(`insert into mm_attributes (tenant_id, block_code, key, name_ar, name_en, description, type, required, options, multiple, strict, is_custom, sort)
        values (app_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) returning *`,
        [block, d.key, d.name_ar, d.name_en, d.description ?? null, d.type, d.required, JSON.stringify(d.options), d.multiple, d.strict, d.sort])).rows[0];
      return { before: null, after };
    });
  }

  patchAttr(actor: Actor, block: string, key: string, body: unknown) {
    const p = AttrPatch.parse(body);
    return this.change(actor, 'mm_attribute', `${block}.${key}`, async (tx) => {
      const before = (await tx.query('select * from mm_attributes where block_code=$1 and key=$2', [block, key])).rows[0];
      const after = (await tx.query(`update mm_attributes set name_ar=coalesce($3,name_ar), name_en=coalesce($4,name_en), type=coalesce($5,type),
          required=coalesce($6,required), options=coalesce($7,options), description=coalesce($8,description), active=coalesce($9,active), sort=coalesce($10,sort),
          multiple=coalesce($11,multiple), strict=coalesce($12,strict)
        where block_code=$1 and key=$2 returning *`,
        [block, key, p.name_ar, p.name_en, p.type, p.required, p.options ? JSON.stringify(p.options) : null, p.description, p.active, p.sort, p.multiple, p.strict])).rows[0];
      return { before, after };
    });
  }

  /** Template attributes are deactivated (never deleted) so the national baseline stays comparable; custom ones are removed. */
  deleteAttr(actor: Actor, block: string, key: string) {
    return this.change(actor, 'mm_attribute', `${block}.${key}`, async (tx) => {
      const before = (await tx.query('select * from mm_attributes where block_code=$1 and key=$2', [block, key])).rows[0];
      if (!before) return { before, after: null };
      const after = before.is_custom
        ? (await tx.query('delete from mm_attributes where block_code=$1 and key=$2 returning *, false as active', [block, key])).rows[0]
        : (await tx.query('update mm_attributes set active=false where block_code=$1 and key=$2 returning *', [block, key])).rows[0];
      return { before, after };
    });
  }

  createRelation(actor: Actor, body: unknown) {
    const d = RelDto.parse(body);
    return this.change(actor, 'mm_relation', `${d.source_code}.${d.verb}.${d.target_code}`, async (tx) => {
      const after = (await tx.query(`insert into mm_relations (tenant_id, source_code, verb, target_code, name_ar, description, is_custom)
        values (app_tenant(), $1,$2,$3,$4,$5,true) returning *`, [d.source_code, d.verb, d.target_code, d.name_ar ?? null, d.description ?? null])).rows[0];
      return { before: null, after };
    });
  }

  patchRelation(actor: Actor, id: string, body: unknown) {
    const p = z.object({ name_ar: z.string(), description: z.string(), active: z.boolean() }).partial().parse(body);
    return this.change(actor, 'mm_relation', id, async (tx) => {
      const before = (await tx.query('select * from mm_relations where id=$1', [id])).rows[0];
      const after = (await tx.query(`update mm_relations set name_ar=coalesce($2,name_ar), description=coalesce($3,description), active=coalesce($4,active)
        where id=$1 returning *`, [id, p.name_ar, p.description, p.active])).rows[0];
      return { before, after };
    });
  }
}

@Controller('metamodel')
export class MetamodelController {
  constructor(private svc: MetamodelService) {}

  @Get()
  get(@CurrentUser() u: SessionUser) {
    return withActor(actorOf(u), loadModel);
  }

  @Perm('metamodel.edit') @Patch('domains/:code')
  patchDomain(@CurrentUser() u: SessionUser, @Param('code') c: string, @Body() b: unknown) { return this.svc.patchDomain(actorOf(u), c, b); }

  @Perm('metamodel.edit') @Post('blocks')
  createBlock(@CurrentUser() u: SessionUser, @Body() b: unknown) { return this.svc.createBlock(actorOf(u), b); }

  @Perm('metamodel.edit') @Patch('blocks/:code')
  patchBlock(@CurrentUser() u: SessionUser, @Param('code') c: string, @Body() b: unknown) { return this.svc.patchBlock(actorOf(u), c, b); }

  @Perm('metamodel.edit') @Post('blocks/:code/attributes')
  createAttr(@CurrentUser() u: SessionUser, @Param('code') c: string, @Body() b: unknown) { return this.svc.createAttr(actorOf(u), c, b); }

  @Perm('metamodel.edit') @Patch('blocks/:code/attributes/:key')
  patchAttr(@CurrentUser() u: SessionUser, @Param('code') c: string, @Param('key') k: string, @Body() b: unknown) { return this.svc.patchAttr(actorOf(u), c, k, b); }

  @Perm('metamodel.edit') @Delete('blocks/:code/attributes/:key')
  deleteAttr(@CurrentUser() u: SessionUser, @Param('code') c: string, @Param('key') k: string) { return this.svc.deleteAttr(actorOf(u), c, k); }

  @Perm('metamodel.edit') @Post('relations')
  createRelation(@CurrentUser() u: SessionUser, @Body() b: unknown) { return this.svc.createRelation(actorOf(u), b); }

  @Perm('metamodel.edit') @Patch('relations/:id')
  patchRelation(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() b: unknown) { return this.svc.patchRelation(actorOf(u), id, b); }
}
