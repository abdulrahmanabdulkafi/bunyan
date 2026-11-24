'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { can, canInScope, setToken } from '@/lib/api';
import { LanguageToggle, useI18n } from '@/lib/i18n';

function Rail() {
  const { user, model, tenant, queue } = useSession();
  const { t, nm } = useI18n();
  const path = usePathname();
  const [open, setOpen] = useState<Record<string, boolean>>({ applications: true, technology: true, security: true });
  const cur = (href: string) => (path === href || (href !== '/' && path.startsWith(href + '/')) ? 'page' : undefined);

  return (
    <nav className="rail" aria-label={t('nav.main')}>
      <div className="brand">
        <div className="brand-name">{t('brand')}</div>
        <div className="brand-tenant">{tenant ? nm(tenant) : t('nav.nationalPlatform')}</div>
      </div>
      <div className="rail-nav">
        {can(user, 'records.read') && <Link href="/" aria-current={cur('/')}>{t('nav.dashboard')}</Link>}
        {can(user, 'records.review') && <Link href="/approvals" aria-current={cur('/approvals')}>{t('nav.approvals')} {queue > 0 && <span className="count">{queue}</span>}</Link>}
        {can(user, 'records.read') && <Link href="/views" aria-current={cur('/views')}>{t('nav.viewpoints')}</Link>}
        {can(user, 'records.read') && user?.tenantId && <Link href="/reports" aria-current={cur('/reports')}>{t('nav.reports')}</Link>}
        {can(user, 'compliance.read') && <Link href="/compliance" aria-current={cur('/compliance')}>{t('nav.compliance')}</Link>}
        {can(user, 'compliance.library') && <Link href="/library" aria-current={cur('/library')}>{t('nav.library')}</Link>}
        {can(user, 'records.import') && <Link href="/io" aria-current={cur('/io')}>{t('nav.io')}</Link>}
        {can(user, 'integrations.manage') && user?.tenantId && <Link href="/integrations" aria-current={cur('/integrations')}>{t('nav.integrations')}</Link>}
        {can(user, 'dashboard.national') && <Link href="/national" aria-current={cur('/national')}>{t('nav.national')}</Link>}
        {can(user, 'metamodel.edit') && user?.tenantId && <Link href="/studio" aria-current={cur('/studio')}>{t('nav.studio')}</Link>}
        {can(user, 'tenant.manage') && <Link href="/admin/entities" aria-current={cur('/admin/entities')}>{t('nav.entities')}</Link>}
        {can(user, 'users.manage') && <Link href="/admin/users" aria-current={cur('/admin/users')}>{t('nav.users')}</Link>}
        {can(user, 'audit.read') && <Link href="/audit" aria-current={cur('/audit')}>{t('nav.audit')}</Link>}
      </div>
      {model && can(user, 'records.read') && (
        <div className="courses">
          <div className="courses-title">{t('nav.domains')}</div>
          {model.domains.map((d) => {
            const blocks = model.blocks.filter((b) => b.domain_code === d.code && b.active && canInScope(user, 'records.read', b));
            const off = !d.active;
            return (
              <div key={d.code} className={`course${off ? ' off' : ''}`} style={{ ['--c' as string]: `var(--d-${d.code})` }}>
                <button aria-expanded={!!open[d.code] && !off} onClick={() => setOpen({ ...open, [d.code]: !open[d.code] })} disabled={off}
                  title={off ? t('nav.domainOffHint') : undefined}>
                  <span>{nm(d)}</span><span>{off ? t('nav.domainOff') : blocks.length}</span>
                </button>
                {open[d.code] && !off && (
                  <ul>{blocks.map((b) => <li key={b.code}><Link href={`/repo/${b.code}`} aria-current={cur(`/repo/${b.code}`)}>{nm(b)}</Link></li>)}</ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

function Top() {
  const { user } = useSession();
  const { t } = useI18n();
  if (!user) return null;
  return (
    <div className="topbar">
      {user.classification ? <span className={`cls cls-${user.classification}`} title={t('cls.hint')}>{t('cls.label')}: {t(`cls.${user.classification}`)}</span> : <span />}
      <div className="who">
        <Link href="/account">{user.name}</Link>
        <span className="hint">{user.roles.map((r) => t(`role.${r}`)).join(t('list.sep'))}</span>
        <LanguageToggle />
        <button className="btn quiet" onClick={() => { setToken(null); window.location.href = '/login'; }}>{t('nav.signOut')}</button>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <div className="shell">
        <Rail />
        <main className="main"><Top />{children}</main>
      </div>
    </SessionProvider>
  );
}
