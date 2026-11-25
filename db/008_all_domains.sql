-- The national meta-model is now used in full: every domain and building block of the DGA EA Content Meta Model
-- is active for existing entities too (each entity can still switch off what it does not use from Meta-model settings).
-- Runs across all entities, so it needs the platform context (tables force row-level security).
select set_config('app.platform', 'on', true);
update mm_domains set active = true;
update mm_blocks set active = true where not is_custom;
