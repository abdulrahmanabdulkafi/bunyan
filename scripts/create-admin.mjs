// First platform administrator for a fresh installation (no demo data).
// Usage: ADMIN_DATABASE_URL=postgres://postgres@host:5432/postgres node scripts/create-admin.mjs admin@example.gov.sa "اسم المدير"
// Prints a one-time password; the administrator must change it and set up two-step verification at first sign-in.
import crypto from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const [email, name = 'مدير المنصة'] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('usage: node scripts/create-admin.mjs <email> [name]'); process.exit(1); }
const admin = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres');
admin.username = 'bunyan_owner'; admin.password = process.env.DB_OWNER_PASSWORD ?? 'bunyan_owner'; admin.pathname = `/${process.env.DB_NAME ?? 'bunyan'}`;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const temp = [...crypto.randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('') + '#7';
const db = new pg.Client({ connectionString: admin.toString() });
await db.connect();
await db.query('begin');
await db.query(`select set_config('app.platform','on',true)`);
const exists = (await db.query('select id from users where lower(email)=lower($1)', [email])).rows[0];
if (exists) { console.error('A user with this email already exists.'); await db.query('rollback'); process.exit(1); }
await db.query(`insert into users (tenant_id, email, display_name, password_hash, roles, must_change_password) values (null, lower($1), $2, $3, '{R0}', true)`,
  [email, name, await bcrypt.hash(temp, 12)]);
await db.query(`insert into audit_log (tenant_id, user_id, action, entity, entity_id) values (null, null, 'bootstrap_admin', 'user', $1)`, [email]);
await db.query('commit');
await db.end();
console.log(`Platform administrator created: ${email}\nOne-time password: ${temp}\nChange it and set up two-step verification at first sign-in.`);
