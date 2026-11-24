/**
 * Role catalogue and permission matrix — BRD section 2 (R0–R9).
 * ◐ (partial) cells are enforced as "scoped": the user's `scope` (domains / blocks) narrows them.
 */
export const ROLES = {
  R0: { ar: 'مدير المنصة', en: 'Platform Admin' },
  R1: { ar: 'مدير النظام في الجهة', en: 'Entity System Admin' },
  R2: { ar: 'مسؤول البنية المؤسسية', en: 'EA Owner' },
  R3: { ar: 'مهندس/محلل بنية مؤسسية', en: 'Enterprise Architect' },
  R4: { ar: 'مالك البيانات', en: 'Data Owner' },
  R5: { ar: 'مُدخل البيانات', en: 'Data Contributor' },
  R6: { ar: 'مستعرض/قيادي', en: 'Viewer / Executive' },
  R7: { ar: 'مدقق/مراجع امتثال', en: 'Auditor' },
  R8: { ar: 'مستعرض اللوحة الوطنية', en: 'National Dashboard Viewer' },
  R9: { ar: 'مسؤول المكتب القطاعي', en: 'Sector Office Lead' },
} as const;
export type Role = keyof typeof ROLES;

export type Permission =
  | 'tenant.manage'
  | 'users.manage'
  | 'metamodel.edit'
  | 'records.read'
  | 'records.write'
  | 'records.import'
  | 'records.review'
  | 'records.approve'
  | 'records.archive'
  | 'cost.read'
  | 'reports.export'
  | 'audit.read'
  | 'integrations.manage'
  | 'compliance.library'
  | 'compliance.read'
  | 'compliance.assess'
  | 'dashboard.sector'
  | 'dashboard.national';

const MATRIX: Record<Permission, Role[]> = {
  'tenant.manage': ['R0'],
  'users.manage': ['R0', 'R1'],
  'metamodel.edit': ['R0', 'R2'],
  'records.read': ['R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
  'records.write': ['R2', 'R3', 'R4', 'R5'],
  'records.import': ['R2', 'R3', 'R4', 'R5'],
  'records.review': ['R2', 'R3', 'R4'],
  'records.approve': ['R2'],
  'records.archive': ['R2'],
  'cost.read': ['R2', 'R3', 'R4', 'R6', 'R7'],
  'reports.export': ['R2', 'R3', 'R4', 'R6', 'R7', 'R8', 'R9'],
  'audit.read': ['R0', 'R1', 'R2', 'R7'],
  'integrations.manage': ['R1', 'R2'],
  'compliance.library': ['R0'],
  'compliance.read': ['R2', 'R3', 'R4', 'R6', 'R7'],
  'compliance.assess': ['R2', 'R3', 'R4'],
  'dashboard.sector': ['R2', 'R6', 'R8', 'R9'],
  'dashboard.national': ['R2', 'R6', 'R8', 'R9'],
};

/** Roles whose record permissions are limited to the domains/blocks in their scope. */
export const SCOPED_ROLES: Role[] = ['R4', 'R5'];

export function can(roles: string[], perm: Permission): boolean {
  return MATRIX[perm].some((r) => roles.includes(r));
}

export interface UserScope {
  domains?: string[];
  blocks?: string[];
}

/**
 * For R4/R5 users, check that a block (and its domain) is inside their scope.
 * Users who also hold an unscoped role with the same permission are not limited.
 */
export function inScope(roles: string[], scope: UserScope, perm: Permission, block: string, domain: string): boolean {
  const unscoped = MATRIX[perm].filter((r) => !SCOPED_ROLES.includes(r));
  if (unscoped.some((r) => roles.includes(r))) return true;
  const hasDomains = !!scope.domains?.length;
  const hasBlocks = !!scope.blocks?.length;
  if (!hasDomains && !hasBlocks) return false; // a scoped role with no scope sees nothing
  return (hasDomains && scope.domains!.includes(domain)) || (hasBlocks && scope.blocks!.includes(block));
}

/** Attributes treated as cost data (hidden without cost.read). */
export const COST_KEYS = /(cost|fees|budget)/i;
