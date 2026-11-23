-- بُنيان — المخطط الأساسي لقاعدة البيانات (الإصدار 1 - النواة)
-- Every tenant-owned table has tenant_id, and row-level security isolates tenants.
-- The application connects as role bunyan_app (not the owner, no BYPASSRLS), so the policies always apply.

create extension if not exists pgcrypto;

-- ───────────── Session context helpers ─────────────
create or replace function app_tenant() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create or replace function app_user() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function app_is_platform() returns boolean language sql stable as
$$ select coalesce(current_setting('app.platform', true), '') = 'on' $$;

-- ───────────── Tenancy: national → sector office → entity ─────────────
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_ar     text not null,
  name_en     text,
  kind        text not null check (kind in ('sector','entity')),
  parent_id   uuid references tenants(id),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id),          -- null = platform admin (R0)
  email         text not null unique,
  display_name  text not null,
  password_hash text,                                  -- null when the user signs in only via SSO
  roles         text[] not null default '{R6}',        -- FR-15-05: new users start as viewer
  scope         jsonb not null default '{}'::jsonb,    -- FR-15-03: limit by domain / block type
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ───────────── Configurable meta-model (per tenant, seeded from the DGA template) ─────────────
create table mm_domains (
  tenant_id uuid not null references tenants(id) on delete cascade,
  code      text not null,
  name_ar   text not null,
  name_en   text not null,
  active    boolean not null default true,
  sort      int not null default 0,
  primary key (tenant_id, code)
);

create table mm_blocks (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  code        text not null,
  domain_code text not null,
  name_ar     text not null,
  name_en     text not null,
  active      boolean not null default true,
  title_key   text,                              -- attribute used as the record's display name
  is_custom   boolean not null default false,   -- added by the entity (not from the national template)
  sort        int not null default 0,
  primary key (tenant_id, code),
  foreign key (tenant_id, domain_code) references mm_domains(tenant_id, code)
);

create table mm_attributes (
  tenant_id   uuid not null,
  block_code  text not null,
  key         text not null,
  name_ar     text not null,
  name_en     text not null,
  description text,
  type        text not null check (type in ('text','multi_text','number','date','enum','url','duration','reference')),
  required    boolean not null default false,
  options     jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  is_custom   boolean not null default false,
  sort        int not null default 0,
  primary key (tenant_id, block_code, key),
  foreign key (tenant_id, block_code) references mm_blocks(tenant_id, code) on delete cascade
);

create table mm_relations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  source_code text not null,
  verb        text not null,
  target_code text not null,
  name_ar     text,
  description text,
  active      boolean not null default true,
  is_custom   boolean not null default false,
  unique (tenant_id, source_code, verb, target_code),
  foreign key (tenant_id, source_code) references mm_blocks(tenant_id, code) on delete cascade,
  foreign key (tenant_id, target_code) references mm_blocks(tenant_id, code) on delete cascade
);

-- ───────────── Repository ─────────────
create table records (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  block_code  text not null,
  name        text not null,
  attrs       jsonb not null default '{}'::jsonb,
  status      text not null default 'draft'
              check (status in ('draft','submitted','reviewed','approved','rejected','archived')),
  version     int not null default 1,
  source      text not null default 'manual',      -- manual | excel | integration
  created_by  uuid references users(id),
  updated_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, block_code) references mm_blocks(tenant_id, code)
);
create index records_tenant_block on records(tenant_id, block_code);
create index records_attrs on records using gin (attrs jsonb_path_ops);
create index records_name on records (tenant_id, lower(name));

create table record_links (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  relation_id uuid not null references mm_relations(id),
  source_id   uuid not null references records(id) on delete cascade,
  target_id   uuid not null references records(id) on delete cascade,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  unique (relation_id, source_id, target_id)
);

-- ───────────── Approval workflow & audit log ─────────────
create table approvals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  record_id   uuid not null references records(id) on delete cascade,
  from_status text not null,
  to_status   text not null,
  actor_id    uuid references users(id),
  comment     text,
  created_at  timestamptz not null default now()
);

create table audit_log (
  id          bigserial primary key,
  tenant_id   uuid,
  user_id     uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);
-- The audit log is append-only: the app role gets INSERT/SELECT only (see grants).

-- ───────────── Row-level security ─────────────
do $$
declare t text;
begin
  foreach t in array array['mm_domains','mm_blocks','mm_attributes','mm_relations','records','record_links','approvals']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
                     using (tenant_id = app_tenant() or app_is_platform())
                     with check (tenant_id = app_tenant() or app_is_platform())$p$, t);
  end loop;
end $$;

-- Audit log: read within the tenant; platform-level users (no tenant) may write their own events.
alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_read on audit_log for select using (tenant_id = app_tenant() or app_is_platform());
create policy audit_write on audit_log for insert with check (tenant_id is not distinct from app_tenant() or app_is_platform());

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenants_read on tenants for select
  using (app_is_platform() or id = app_tenant() or parent_id = app_tenant());
create policy tenants_write on tenants for all
  using (app_is_platform()) with check (app_is_platform());

alter table users enable row level security;
alter table users force row level security;
create policy users_isolation on users
  using (app_is_platform() or tenant_id = app_tenant() or id = app_user())
  with check (app_is_platform() or tenant_id = app_tenant());

-- Login has to find a user before any tenant is known; this narrow definer function is the only bypass.
create or replace function auth_lookup(p_email text)
returns table (id uuid, tenant_id uuid, email text, display_name text, password_hash text, roles text[], scope jsonb, active boolean)
language sql security definer set search_path = public as
$$ select id, tenant_id, email, display_name, password_hash, roles, scope, active from users where lower(email) = lower(p_email) $$;

-- National / sector dashboards: aggregated counts only (FR: R8/R9 see aggregates, never records).
create or replace function aggregate_counts(p_parent uuid default null)
returns table (tenant_id uuid, tenant_name text, parent_id uuid, domain_code text, block_code text, total bigint, approved bigint)
language sql security definer set search_path = public as
$$ select t.id, t.name_ar, t.parent_id, b.domain_code, r.block_code, count(*), count(*) filter (where r.status = 'approved')
     from records r join tenants t on t.id = r.tenant_id
     join mm_blocks b on b.tenant_id = r.tenant_id and b.code = r.block_code
    where r.status <> 'archived' and (p_parent is null or t.parent_id = p_parent)
    group by 1,2,3,4,5 $$;
