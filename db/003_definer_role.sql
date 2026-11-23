-- The two security-definer functions (login lookup, national aggregates) must read across tenants.
-- They are owned by bunyan_definer (NOLOGIN, BYPASSRLS), created by scripts/db-setup.mjs, so the
-- application role itself never bypasses row-level security.
grant usage, create on schema public to bunyan_definer;
grant select on users, tenants, records, mm_blocks to bunyan_definer;
alter function auth_lookup(text) owner to bunyan_definer;
alter function aggregate_counts(uuid) owner to bunyan_definer;
revoke execute on function auth_lookup(text), aggregate_counts(uuid) from public;
revoke create on schema public from bunyan_definer;
grant execute on function auth_lookup(text), aggregate_counts(uuid) to bunyan_app;
