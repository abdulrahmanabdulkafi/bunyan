-- Predefined lists are open by default: options are suggestions, any value is accepted.
-- `multiple` lets an attribute hold a list of values; `strict` (opt-in) restricts values to the defined options.
alter table mm_attributes add column multiple boolean not null default false;
alter table mm_attributes add column strict boolean not null default false;
