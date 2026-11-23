-- Integration framework (FR-05-03 … FR-05-10): connectors, encrypted credentials, run log, source keys.
create table connectors (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  name             text not null,
  type             text not null,                 -- vcenter | json_api | …
  config           jsonb not null default '{}'::jsonb,   -- non-secret settings + field mappings
  secret           text,                          -- AES-256-GCM ciphertext; never returned by the API
  schedule_minutes int check (schedule_minutes is null or schedule_minutes >= 15),
  auto_approve     boolean not null default false, -- FR-05-07: off = synced data enters as drafts
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  created_by       uuid references users(id),
  created_at       timestamptz not null default now()
);

create table connector_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  connector_id  uuid not null references connectors(id) on delete cascade,
  trigger       text not null,                   -- manual | schedule | dry_run
  status        text not null default 'running' check (status in ('running','succeeded','failed')),
  created       int not null default 0,
  updated       int not null default 0,
  unchanged     int not null default 0,
  conflicts     int not null default 0,
  details       jsonb not null default '[]'::jsonb,   -- conflicts and errors, capped
  started_by    uuid references users(id),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index connector_runs_recent on connector_runs(connector_id, started_at desc);

-- Which external object each record came from: the key for matching on the next sync (FR-05-06).
create table record_sources (
  tenant_id     uuid not null references tenants(id),
  record_id     uuid not null references records(id) on delete cascade,
  connector_id  uuid not null references connectors(id) on delete cascade,
  external_id   text not null,
  last_seen_at  timestamptz not null default now(),
  primary key (connector_id, external_id)
);
create index record_sources_record on record_sources(record_id);

do $$
declare t text;
begin
  foreach t in array array['connectors','connector_runs','record_sources'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
                     using (tenant_id = app_tenant() or app_is_platform())
                     with check (tenant_id = app_tenant() or app_is_platform())$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on connectors, connector_runs, record_sources to bunyan_app;

-- The scheduler has no user session: it asks only for due connector ids, then runs each inside its tenant.
create or replace function due_connectors()
returns table (id uuid, tenant_id uuid)
language sql security definer set search_path = public as
$$ select id, tenant_id from connectors
    where enabled and schedule_minutes is not null
      and (last_run_at is null or last_run_at + make_interval(mins => schedule_minutes) <= now()) $$;
grant select on connectors to bunyan_definer;
grant usage, create on schema public to bunyan_definer;
alter function due_connectors() owner to bunyan_definer;
revoke create on schema public from bunyan_definer;
revoke execute on function due_connectors() from public;
grant execute on function due_connectors() to bunyan_app;
