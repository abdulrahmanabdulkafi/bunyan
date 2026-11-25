-- EA development cycles: a time-boxed round of architecture work (scope → baseline → target → gaps → roadmap → approval),
-- its tasks, and the changes it plans to the repository. Planned changes give each cycle a target state next to the current one.
create table ea_cycles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  name        text not null,
  objective   text,
  domains     text[] not null default '{}',        -- scope: empty = all domains
  start_date  date,
  end_date    date,
  status      text not null default 'planned' check (status in ('planned','active','closed','cancelled')),
  phase       text not null default 'scope' check (phase in ('scope','baseline','target','gap','roadmap','approval')),
  owner_id    uuid references users(id),
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz,
  unique (tenant_id, code),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table ea_cycle_tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  cycle_id     uuid not null references ea_cycles(id) on delete cascade,
  phase        text not null check (phase in ('scope','baseline','target','gap','roadmap','approval')),
  title        text not null,
  deliverable  text,
  assignee_id  uuid references users(id),
  due_date     date,
  status       text not null default 'todo' check (status in ('todo','doing','done')),
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index ea_cycle_tasks_cycle on ea_cycle_tasks(cycle_id, phase, sort);

create table ea_cycle_changes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  cycle_id     uuid not null references ea_cycles(id) on delete cascade,
  record_id    uuid not null references records(id) on delete cascade,
  change_type  text not null check (change_type in ('add','modify','retire')),
  rationale    text,
  target_date  date,
  status       text not null default 'planned' check (status in ('planned','done','cancelled')),
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  unique (cycle_id, record_id)
);
create index ea_cycle_changes_record on ea_cycle_changes(record_id);

-- Viewpoints an entity builds itself; same declarative spec as the national catalogue.
create table custom_viewpoints (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  code        text not null,
  domain      text not null,
  name_ar     text not null,
  name_en     text not null,
  purpose_ar  text,
  purpose_en  text,
  spec        jsonb not null,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

do $$
declare t text;
begin
  foreach t in array array['ea_cycles','ea_cycle_tasks','ea_cycle_changes','custom_viewpoints'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I
                     using (tenant_id = app_tenant() or app_is_platform())
                     with check (tenant_id = app_tenant() or app_is_platform())$p$, t);
  end loop;
end $$;

-- Notifications: anyone in the entity may notify a colleague, but each user reads and clears only their own.
create table notifications (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,                         -- submitted | reviewed | approved | rejected | task_assigned | cycle_phase
  payload     jsonb not null default '{}'::jsonb,    -- ids and names the interface needs to word the message
  actor_id    uuid references users(id),
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user on notifications(user_id, created_at desc);
alter table notifications enable row level security;
alter table notifications force row level security;
create policy notif_read on notifications for select using (tenant_id = app_tenant() and user_id = app_user());
create policy notif_update on notifications for update using (tenant_id = app_tenant() and user_id = app_user());
create policy notif_insert on notifications for insert with check (tenant_id = app_tenant());

grant select, insert, update, delete on ea_cycles, ea_cycle_tasks, ea_cycle_changes, custom_viewpoints to bunyan_app;
grant select, insert, update on notifications to bunyan_app;
grant usage on all sequences in schema public to bunyan_app;
