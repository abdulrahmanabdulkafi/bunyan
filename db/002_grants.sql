-- The application role: never the owner, never BYPASSRLS, so RLS always applies.
grant usage on schema public to bunyan_app;
grant select, insert, update, delete on tenants, users, mm_domains, mm_blocks, mm_attributes, mm_relations, records, record_links, approvals to bunyan_app;
grant select, insert on audit_log to bunyan_app;
grant usage on all sequences in schema public to bunyan_app;
grant execute on all functions in schema public to bunyan_app;
