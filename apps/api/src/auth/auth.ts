import {
  Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, HttpStatus, Injectable, Post,
  SetMetadata, UnauthorizedException, createParamDecorator, BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../common/config.js';
import { pool, Actor, withActor, audit } from '../common/db.js';
import { newTotpSecret, passwordProblems, seal, unseal, verifyTotp } from '../common/crypto.js';
import { can, Permission, UserScope, ROLES } from './permissions.js';

/**
 * Sessions (NCA ECC 2-2):
 *  - password + optional TOTP; TOTP is mandatory for the roles in MFA_REQUIRED_ROLES (default R0, R1, R2);
 *  - accounts lock after LOCKOUT_ATTEMPTS failures for LOCKOUT_MINUTES;
 *  - tokens live SESSION_IDLE_MINUTES and are renewed while the user is active, never beyond SESSION_MAX_HOURS;
 *  - every request re-checks that the account is active and the token version is current, so disabling a user
 *    or resetting their password ends their sessions within seconds.
 * A "limited" session (password change or MFA enrolment pending) can only reach the endpoints that finish that step.
 */
export interface SessionUser {
  id: string;
  tenantId: string | null;
  email: string;
  name: string;
  roles: string[];
  scope: UserScope;
  tv: number;
  authTime: number;
  limited?: 'password_change' | 'mfa_setup';
}

export function actorOf(u: SessionUser): Actor {
  return { userId: u.id, tenantId: u.tenantId, platform: u.roles.includes('R0') };
}

const PERM_KEY = 'perm';
const PUBLIC_KEY = 'public';
const LIMITED_KEY = 'limited_ok';
/** Require a permission from the BRD matrix. */
export const Perm = (p: Permission) => SetMetadata(PERM_KEY, p);
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Reachable with a limited session (to finish a password change or MFA enrolment). */
export const AllowLimited = () => SetMetadata(LIMITED_KEY, true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as SessionUser);

interface AccountRow {
  id: string; tenant_id: string | null; email: string; display_name: string; password_hash: string | null; roles: string[]; scope: UserScope;
  active: boolean; failed_attempts: number; locked_until: string | null; mfa_secret: string | null; mfa_enabled: boolean;
  must_change_password: boolean; token_version: number;
}

// Short cache so the per-request account check does not hit the database on every call.
const accountCache = new Map<string, { at: number; row: AccountRow | undefined }>();
export function forgetAccount(id: string) { accountCache.delete(id); }
async function account(id: string): Promise<AccountRow | undefined> {
  const hit = accountCache.get(id);
  if (hit && Date.now() - hit.at < 15_000) return hit.row;
  const row = (await pool.query('select * from auth_by_id($1)', [id])).rows[0];
  accountCache.set(id, { at: Date.now(), row });
  return row;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException();
    let s: SessionUser & { purpose?: string };
    try {
      s = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as SessionUser & { purpose?: string };
    } catch {
      throw new UnauthorizedException();
    }
    if (s.purpose) throw new UnauthorizedException(); // MFA challenge tokens are not sessions
    const acc = await account(s.id);
    if (!acc || !acc.active || acc.token_version !== s.tv) throw new UnauthorizedException();
    if (s.limited && !this.reflector.getAllAndOverride<boolean>(LIMITED_KEY, targets)) {
      throw new ForbiddenException(s.limited === 'mfa_setup' ? 'فعّل التحقق الثنائي أولاً' : 'غيّر كلمة المرور أولاً');
    }
    // Roles and scope come from the database, so a change by the admin applies to the next request.
    req.user = { ...s, roles: acc.roles, scope: acc.scope ?? {}, tenantId: acc.tenant_id } as SessionUser;
    const perm = this.reflector.getAllAndOverride<Permission>(PERM_KEY, targets);
    if (perm && !can(req.user.roles, perm)) throw new ForbiddenException(`missing permission ${perm}`);
    return true;
  }
}

function needsMfa(roles: string[]) {
  return roles.some((r) => config.mfaRequiredRoles.includes(r));
}

/** Build the session that matches where the account stands: full, or limited to the step still owed. */
function issue(u: AccountRow, authTime = Date.now()) {
  const limited: SessionUser['limited'] = u.must_change_password ? 'password_change'
    : needsMfa(u.roles) && !u.mfa_enabled ? 'mfa_setup' : undefined;
  const session: SessionUser = {
    id: u.id, tenantId: u.tenant_id, email: u.email, name: u.display_name, roles: u.roles, scope: u.scope ?? {},
    tv: u.token_version, authTime, ...(limited ? { limited } : {}),
  };
  const remainingMin = Math.max(1, Math.floor((authTime + config.sessionMaxHours * 3_600_000 - Date.now()) / 60_000));
  const ttl = Math.min(config.sessionIdleMinutes, remainingMin);
  const token = jwt.sign(session, config.jwtSecret, { algorithm: 'HS256', expiresIn: `${ttl}m` });
  return { token, user: session, expiresInMinutes: ttl, limited: limited ?? null };
}

// Login throttling per address and account (in addition to account lockout).
const attempts = new Map<string, number[]>();
function throttle(key: string) {
  const now = Date.now();
  const list = (attempts.get(key) ?? []).filter((t) => now - t < 5 * 60_000);
  list.push(now);
  attempts.set(key, list);
  if (list.length > 20) throw new HttpException({ message: 'محاولات كثيرة؛ انتظر قليلاً ثم حاول مجدداً' }, HttpStatus.TOO_MANY_REQUESTS);
}

async function touchAccount(u: { id: string; tenant_id: string | null; roles: string[] }, fn: (tx: import('../common/db.js').Tx) => Promise<void>) {
  await withActor({ userId: u.id, tenantId: u.tenant_id, platform: u.roles.includes('R0') }, fn);
  forgetAccount(u.id);
}

const LoginDto = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });

@Controller('auth')
export class AuthController {
  private jwks = config.oidcIssuer ? createRemoteJWKSet(new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`)) : null;

  @Public()
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, password } = LoginDto.parse(body);
    throttle(`login:${email.toLowerCase()}`);
    const u: AccountRow | undefined = (await pool.query('select * from auth_lookup($1)', [email])).rows[0];
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      throw new HttpException({ message: 'الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة' }, HttpStatus.LOCKED);
    }
    const ok = !!u && u.active && !!u.password_hash && (await bcrypt.compare(password, u.password_hash));
    if (!ok) {
      if (u) {
        const lock = (await pool.query('select auth_attempt($1,false,$2,$3) as l', [u.id, config.lockoutAttempts, config.lockoutMinutes])).rows[0].l;
        await touchAccount(u, (tx) => audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, lock ? 'lockout' : 'login_failed', 'user', u.id, null, null, u.tenant_id));
      }
      // Same message for unknown accounts and wrong passwords, to avoid revealing which accounts exist.
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }
    if (u.mfa_enabled) {
      const challenge = jwt.sign({ id: u.id, purpose: 'mfa' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '5m' });
      return { mfa_required: true, challenge };
    }
    await pool.query('select auth_attempt($1,true,$2,$3)', [u.id, config.lockoutAttempts, config.lockoutMinutes]);
    await touchAccount(u, (tx) => audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, 'login', 'user', u.id, null, null, u.tenant_id));
    return issue(u);
  }

  /** Second step when the account has TOTP enabled. Failed codes count towards the lockout. */
  @Public()
  @Post('mfa/verify')
  async mfaVerify(@Body() body: { challenge?: string; code?: string }) {
    let c: { id: string; purpose: string };
    try { c = jwt.verify(String(body?.challenge ?? ''), config.jwtSecret, { algorithms: ['HS256'] }) as typeof c; }
    catch { throw new UnauthorizedException('انتهت صلاحية الطلب؛ سجّل الدخول من جديد'); }
    if (c.purpose !== 'mfa') throw new UnauthorizedException();
    throttle(`mfa:${c.id}`);
    const u: AccountRow | undefined = (await pool.query('select * from auth_by_id($1)', [c.id])).rows[0];
    if (!u?.active || !u.mfa_enabled) throw new UnauthorizedException();
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpException({ message: 'الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة' }, HttpStatus.LOCKED);
    const secret = unseal<{ s: string }>(u.mfa_secret).s;
    if (!verifyTotp(secret, String(body?.code ?? ''))) {
      await pool.query('select auth_attempt($1,false,$2,$3)', [u.id, config.lockoutAttempts, config.lockoutMinutes]);
      forgetAccount(u.id);
      throw new UnauthorizedException('رمز التحقق غير صحيح');
    }
    await pool.query('select auth_attempt($1,true,$2,$3)', [u.id, config.lockoutAttempts, config.lockoutMinutes]);
    await touchAccount(u, (tx) => audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, 'login', 'user', u.id, null, { mfa: true }, u.tenant_id));
    return issue(u);
  }

  /** Start TOTP enrolment: returns the secret and an otpauth:// link for the authenticator app. */
  @AllowLimited()
  @Post('mfa/setup')
  async mfaSetup(@CurrentUser() s: SessionUser) {
    const u = (await account(s.id))!;
    if (u.mfa_enabled) throw new BadRequestException('التحقق الثنائي مفعّل مسبقاً');
    const secret = newTotpSecret();
    await touchAccount(u, async (tx) => { await tx.query('update users set mfa_secret=$2 where id=$1', [u.id, seal({ s: secret })]); });
    const label = encodeURIComponent(`Bunyan:${u.email}`);
    return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Bunyan&digits=6&period=30` };
  }

  /** Confirm enrolment with a first code; ends every other session. */
  @AllowLimited()
  @Post('mfa/enable')
  async mfaEnable(@CurrentUser() s: SessionUser, @Body() body: { code?: string }) {
    const u = (await pool.query('select * from auth_by_id($1)', [s.id])).rows[0] as AccountRow;
    if (!u.mfa_secret) throw new BadRequestException('ابدأ إعداد التحقق الثنائي أولاً');
    if (!verifyTotp(unseal<{ s: string }>(u.mfa_secret).s, String(body?.code ?? ''))) throw new BadRequestException('رمز التحقق غير صحيح');
    await touchAccount(u, async (tx) => {
      await tx.query('update users set mfa_enabled=true, token_version=token_version+1 where id=$1', [u.id]);
      await audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, 'mfa_enabled', 'user', u.id, null, null, u.tenant_id);
    });
    return issue({ ...u, mfa_enabled: true, token_version: u.token_version + 1 }, s.authTime);
  }

  /** Change own password (also the forced first-login change). */
  @AllowLimited()
  @Post('password')
  async changePassword(@CurrentUser() s: SessionUser, @Body() body: { current?: string; next?: string }) {
    const u = (await pool.query('select * from auth_by_id($1)', [s.id])).rows[0] as AccountRow;
    if (!u.password_hash || !(await bcrypt.compare(String(body?.current ?? ''), u.password_hash))) throw new BadRequestException('كلمة المرور الحالية غير صحيحة');
    const next = String(body?.next ?? '');
    const problems = passwordProblems(next, u.email);
    if (await bcrypt.compare(next, u.password_hash)) problems.push('يجب أن تختلف كلمة المرور الجديدة عن الحالية');
    if (problems.length) throw new BadRequestException({ message: 'كلمة المرور لا تستوفي السياسة', errors: problems.map((m) => ({ key: 'next', message: m })) });
    const hash = await bcrypt.hash(next, 12);
    await touchAccount(u, async (tx) => {
      await tx.query('update users set password_hash=$2, must_change_password=false, password_changed_at=now(), token_version=token_version+1 where id=$1', [u.id, hash]);
      await audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, 'password_changed', 'user', u.id, null, null, u.tenant_id);
    });
    return issue({ ...u, must_change_password: false, token_version: u.token_version + 1 }, s.authTime);
  }

  /** Renew an active session (the client calls this while the user is working). */
  @AllowLimited()
  @Post('refresh')
  async refresh(@CurrentUser() s: SessionUser) {
    if (Date.now() - s.authTime > config.sessionMaxHours * 3_600_000) throw new UnauthorizedException();
    const u = (await account(s.id))!;
    return issue(u, s.authTime);
  }

  /** SSO: exchange an OIDC id_token (Keycloak federating AD / Nafath) for a Bunyan session. Users must be pre-provisioned. */
  @Public()
  @Post('oidc')
  async oidc(@Body() body: { id_token?: string }) {
    if (!this.jwks) throw new BadRequestException('SSO is not configured');
    if (!body?.id_token) throw new BadRequestException('id_token required');
    const { payload } = await jwtVerify(body.id_token, this.jwks, { issuer: config.oidcIssuer, audience: config.oidcAudience || undefined })
      .catch(() => { throw new UnauthorizedException(); });
    const email = String(payload.email ?? payload.preferred_username ?? '');
    const u: AccountRow | undefined = (await pool.query('select * from auth_lookup($1)', [email])).rows[0];
    if (!u?.active) throw new UnauthorizedException('المستخدم غير مسجل في المنصة');
    // The identity provider performed the authentication (and its own MFA): no password change is owed here.
    return issue({ ...u, must_change_password: false, mfa_enabled: true });
  }

  @AllowLimited()
  @Get('me')
  async me(@CurrentUser() u: SessionUser) {
    const acc = await account(u.id);
    let classification: string | null = null;
    if (u.tenantId) classification = await withActor(actorOf(u), async (tx) => (await tx.query('select classification from tenants where id=$1', [u.tenantId])).rows[0]?.classification ?? null);
    return { ...u, mfaEnabled: !!acc?.mfa_enabled, mfaRequired: needsMfa(u.roles), classification, roleNames: u.roles.map((r) => ROLES[r as keyof typeof ROLES]) };
  }

  @Public()
  @Get('policy')
  policy() {
    return { passwordMinLength: config.passwordMinLength, sessionIdleMinutes: config.sessionIdleMinutes, mfaRequiredRoles: config.mfaRequiredRoles };
  }

  @Public()
  @Get('roles')
  roles() {
    return ROLES;
  }
}
