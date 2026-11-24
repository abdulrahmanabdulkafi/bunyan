-- M10 — Security compliance (FR-10-01 … FR-10-05).
-- The control library is national content, shared by all entities and maintained by the platform admin (R0).
-- Each new version of a framework is a new framework row, so earlier assessments stay intact (NFR-CFG-02).

create table compliance_frameworks (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,                 -- ECC, CCC, DCC …
  version     text not null,                 -- 2:2024
  name_ar     text not null,
  name_en     text not null,
  issuer_ar   text,
  issuer_en   text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (code, version)
);

create table compliance_items (
  id            uuid primary key default gen_random_uuid(),
  framework_id  uuid not null references compliance_frameworks(id) on delete cascade,
  parent_id     uuid references compliance_items(id) on delete cascade,
  code          text not null,                -- 1, 1-1, 1-1-1, 1-1-1-1
  level         text not null check (level in ('domain','subdomain','control','subcontrol')),
  title_ar      text not null,
  title_en      text,
  text_ar       text,
  text_en       text,
  sort          int not null default 0,
  unique (framework_id, code)
);
create index compliance_items_parent on compliance_items(parent_id);

-- Which frameworks an entity adopts.
create table tenant_frameworks (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  framework_id  uuid not null references compliance_frameworks(id) on delete cascade,
  enabled       boolean not null default true,
  primary key (tenant_id, framework_id)
);

-- One row per (control, asset), or per control for the entity as a whole (record_id is null).
-- A row with a record is also the mapping "this control applies to / is met by this asset" (FR-10-02).
create table control_assessments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  item_id      uuid not null references compliance_items(id) on delete cascade,
  record_id    uuid references records(id) on delete cascade,
  status       text not null default 'not_assessed'
               check (status in ('compliant','partial','non_compliant','not_applicable','not_assessed')),
  evidence     text,
  evidence_url text,
  assessed_at  date,
  remediation  text,
  due_date     date,
  updated_by   uuid references users(id),
  updated_at   timestamptz not null default now()
);
create unique index control_assessments_one on control_assessments (item_id, tenant_id, coalesce(record_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index control_assessments_record on control_assessments(record_id);

-- Library tables: everyone signed in may read; only the platform admin writes.
alter table compliance_frameworks enable row level security;
alter table compliance_frameworks force row level security;
create policy read_all on compliance_frameworks for select using (true);
create policy platform_write on compliance_frameworks for all using (app_is_platform()) with check (app_is_platform());

alter table compliance_items enable row level security;
alter table compliance_items force row level security;
create policy read_all on compliance_items for select using (true);
create policy platform_write on compliance_items for all using (app_is_platform()) with check (app_is_platform());

do $$
declare t text;
begin
  foreach t in array array['tenant_frameworks','control_assessments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
                     using (tenant_id = app_tenant() or app_is_platform())
                     with check (tenant_id = app_tenant() or app_is_platform())$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on compliance_frameworks, compliance_items, tenant_frameworks, control_assessments to bunyan_app;

-- National / sector dashboards (FR-13-02): per entity, how many leaf controls of each enabled framework are
-- covered by at least one security asset, and how many are assessed compliant. Aggregates only.
create or replace function aggregate_compliance(p_parent uuid default null)
returns table (tenant_id uuid, framework text, leaves bigint, covered bigint, compliant bigint)
language sql security definer set search_path = public as
$$
  with leaves as (
    select i.id, i.framework_id from compliance_items i
     where not exists (select 1 from compliance_items c where c.parent_id = i.id)
  )
  select t.id, f.code || '-' || f.version,
         count(distinct l.id),
         count(distinct l.id) filter (where exists (
           select 1 from control_assessments a join records r on r.id = a.record_id
            where a.item_id = l.id and a.tenant_id = t.id and r.block_code in ('security_hardware','security_software','security_service') and r.status <> 'archived')),
         count(distinct l.id) filter (where exists (
           select 1 from control_assessments a where a.item_id = l.id and a.tenant_id = t.id and a.record_id is null and a.status = 'compliant'))
    from tenants t
    join tenant_frameworks tf on tf.tenant_id = t.id and tf.enabled
    join compliance_frameworks f on f.id = tf.framework_id
    join leaves l on l.framework_id = f.id
   where (p_parent is null or t.parent_id = p_parent)
   group by 1, 2
$$;
grant select on compliance_frameworks, compliance_items, tenant_frameworks, control_assessments to bunyan_definer;
grant usage, create on schema public to bunyan_definer;
alter function aggregate_compliance(uuid) owner to bunyan_definer;
revoke create on schema public from bunyan_definer;
revoke execute on function aggregate_compliance(uuid) from public;
grant execute on function aggregate_compliance(uuid) to bunyan_app;
