import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'postgres://bunyan_app:bunyan_app@localhost:5432/bunyan'),
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 20),
  // In production the secret must be provided; the dev fallback is refused.
  jwtSecret: isProd ? required('JWT_SECRET') : (process.env.JWT_SECRET ?? 'dev-only-secret-change-me'),
  // Sessions: short-lived tokens renewed while the user is active (idle timeout), with an absolute cap.
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),
  sessionMaxHours: Number(process.env.SESSION_MAX_HOURS ?? 12),
  // Account protection (NCA ECC 2-2).
  passwordMinLength: Number(process.env.PASSWORD_MIN_LENGTH ?? 12),
  lockoutAttempts: Number(process.env.LOCKOUT_ATTEMPTS ?? 5),
  lockoutMinutes: Number(process.env.LOCKOUT_MINUTES ?? 15),
  /** Roles that must use multi-factor authentication. Read on each use so it can be changed without a restart. 'none' disables. */
  get mfaRequiredRoles(): string[] {
    const v = process.env.MFA_REQUIRED_ROLES ?? 'R0,R1,R2';
    return v === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
  },
  // Optional OIDC (Keycloak / AD FS / Nafath gateway). When set, /auth/oidc accepts id_tokens from this issuer.
  oidcIssuer: process.env.OIDC_ISSUER ?? '',
  oidcAudience: process.env.OIDC_AUDIENCE ?? '',
  // 32-byte base64 key encrypting connector credentials. Required in production.
  connectorKey: isProd ? required('CONNECTOR_KEY') : (process.env.CONNECTOR_KEY ?? ''),
  scheduler: process.env.SCHEDULER !== 'off',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  seedFile: process.env.SEED_FILE ?? path.resolve(here, '../../../../packages/seed/metamodel.seed.json'),
};
