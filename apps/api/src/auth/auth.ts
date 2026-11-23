import {
  Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post,
  SetMetadata, UnauthorizedException, createParamDecorator, BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../common/config.js';
import { pool, Actor, withActor, audit } from '../common/db.js';
import { can, Permission, UserScope, ROLES } from './permissions.js';

export interface SessionUser {
  id: string;
  tenantId: string | null;
  email: string;
  name: string;
  roles: string[];
  scope: UserScope;
}

export function actorOf(u: SessionUser): Actor {
  return { userId: u.id, tenantId: u.tenantId, platform: u.roles.includes('R0') };
}

const PERM_KEY = 'perm';
const PUBLIC_KEY = 'public';
/** Require a permission from the BRD matrix. */
export const Perm = (p: Permission) => SetMetadata(PERM_KEY, p);
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as SessionUser);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException();
    try {
      req.user = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as SessionUser;
    } catch {
      throw new UnauthorizedException();
    }
    const perm = this.reflector.getAllAndOverride<Permission>(PERM_KEY, targets);
    if (perm && !can(req.user.roles, perm)) throw new ForbiddenException(`missing permission ${perm}`);
    return true;
  }
}

function issue(u: { id: string; tenant_id: string | null; email: string; display_name: string; roles: string[]; scope: UserScope }) {
  const session: SessionUser = { id: u.id, tenantId: u.tenant_id, email: u.email, name: u.display_name, roles: u.roles, scope: u.scope ?? {} };
  const token = jwt.sign(session, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.jwtTtl as jwt.SignOptions['expiresIn'] });
  return { token, user: session };
}

const LoginDto = z.object({ email: z.string().email(), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  private jwks = config.oidcIssuer ? createRemoteJWKSet(new URL(`${config.oidcIssuer}/protocol/openid-connect/certs`)) : null;

  @Public()
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, password } = LoginDto.parse(body);
    const { rows } = await pool.query('select * from auth_lookup($1)', [email]);
    const u = rows[0];
    // Same error for unknown user and wrong password, to avoid account enumeration.
    if (!u || !u.active || !u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    }
    await withActor({ userId: u.id, tenantId: u.tenant_id, platform: u.roles.includes('R0') }, (tx) =>
      audit(tx, { userId: u.id, tenantId: u.tenant_id, platform: false }, 'login', 'user', u.id, null, null));
    return issue(u);
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
    const { rows } = await pool.query('select * from auth_lookup($1)', [email]);
    if (!rows[0]?.active) throw new UnauthorizedException('المستخدم غير مسجل في المنصة');
    return issue(rows[0]);
  }

  @Get('me')
  me(@CurrentUser() u: SessionUser) {
    return { ...u, roleNames: u.roles.map((r) => ROLES[r as keyof typeof ROLES]) };
  }

  @Public()
  @Get('roles')
  roles() {
    return ROLES;
  }
}
