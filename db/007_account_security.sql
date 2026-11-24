-- Account security for the platform itself (NCA ECC 2-2: identity and access management).
alter table users add column failed_attempts      int not null default 0;
alter table users add column locked_until         timestamptz;
alter table users add column mfa_secret           text;          -- AES-GCM sealed TOTP secret
alter table users add column mfa_enabled          boolean not null default false;
alter table users add column must_change_password boolean not null default false;
alter table users add column password_changed_at  timestamptz;
alter table users add column last_login_at        timestamptz;
alter table users add column token_version        int not null default 0;  -- bump to revoke every session

-- Data classification of each entity's repository (NDMO data classification levels).
alter table tenants add column classification text not null default 'restricted'
  check (classification in ('top_secret','secret','restricted','public'));

-- Login and session checks run before any tenant context exists: narrow definer functions only.
drop function if exists auth_lookup(text);
create function auth_lookup(p_email text)
returns table (id uuid, tenant_id uuid, email text, display_name text, password_hash text, roles text[], scope jsonb, active boolean,
               failed_attempts int, locked_until timestamptz, mfa_secret text, mfa_enabled boolean, must_change_password boolean, token_version int)
language sql security definer set search_path = public as
$$ select id, tenant_id, email, display_name, password_hash, roles, scope, active, failed_attempts, locked_until, mfa_secret, mfa_enabled,
          must_change_password, token_version
     from users where lower(email) = lower(p_email) $$;

create function auth_by_id(p_id uuid)
returns table (id uuid, tenant_id uuid, email text, display_name text, password_hash text, roles text[], scope jsonb, active boolean,
               failed_attempts int, locked_until timestamptz, mfa_secret text, mfa_enabled boolean, must_change_password boolean, token_version int)
language sql security definer set search_path = public as
$$ select id, tenant_id, email, display_name, password_hash, roles, scope, active, failed_attempts, locked_until, mfa_secret, mfa_enabled,
          must_change_password, token_version
     from users where id = p_id $$;

-- Record a sign-in attempt: count failures, lock after p_max, reset on success.
create function auth_attempt(p_id uuid, p_success boolean, p_max int, p_lock_minutes int)
returns timestamptz
language plpgsql security definer set search_path = public as
$$
declare lock timestamptz;
begin
  if p_success then
    update users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = p_id;
    return null;
  end if;
  update users set failed_attempts = failed_attempts + 1,
                   locked_until = case when failed_attempts + 1 >= p_max then now() + make_interval(mins => p_lock_minutes) else locked_until end
   where id = p_id returning locked_until into lock;
  return lock;
end $$;

grant select, update on users to bunyan_definer;
grant usage, create on schema public to bunyan_definer;
alter function auth_lookup(text) owner to bunyan_definer;
alter function auth_by_id(uuid) owner to bunyan_definer;
alter function auth_attempt(uuid, boolean, int, int) owner to bunyan_definer;
revoke create on schema public from bunyan_definer;
revoke execute on function auth_lookup(text), auth_by_id(uuid), auth_attempt(uuid, boolean, int, int) from public;
grant execute on function auth_lookup(text), auth_by_id(uuid), auth_attempt(uuid, boolean, int, int) to bunyan_app;

-- Users may update their own row (password, MFA enrolment); the application decides which columns.
drop policy users_isolation on users;
create policy users_isolation on users
  using (app_is_platform() or tenant_id = app_tenant() or id = app_user())
  with check (app_is_platform() or tenant_id = app_tenant() or id = app_user());
