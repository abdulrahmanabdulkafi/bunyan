'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { can, canInScope, ROLE_NAMES, setToken } from '@/lib/api';

function Rail() {
  const { user, model, tenantName, queue } = useSession();
  const path = usePathname();
  const [open, setOpen] = useState<Record<string, boolean>>({ applications: true, technology: true, security: true });
  const cur = (href: string) => (path === href ? 'page' : undefined);

  return (
    <nav className="rail" aria-label="التنقل الرئيسي">
      <div className="brand">
        <div className="brand-name">بُنيان</div>
        <div className="brand-tenant">{tenantName}</div>
      </div>
      <div className="rail-nav">
        {can(user, 'records.read') && <Link href="/" aria-current={cur('/')}>لوحة الجهة</Link>}
        {can(user, 'records.review') && <Link href="/approvals" aria-current={cur('/approvals')}>طلبات الاعتماد {queue > 0 && <span className="count">{queue}</span>}</Link>}
        {can(user, 'records.read') && <Link href="/views" aria-current={cur('/views')}>المناظير</Link>}
        {can(user, 'records.import') && <Link href="/io" aria-current={cur('/io')}>الاستيراد والتصدير</Link>}
        {can(user, 'dashboard.national') && <Link href="/national" aria-current={cur('/national')}>اللوحة الوطنية</Link>}
        {can(user, 'metamodel.edit') && user?.tenantId && <Link href="/studio" aria-current={cur('/studio')}>تهيئة النموذج</Link>}
        {can(user, 'audit.read') && <Link href="/audit" aria-current={cur('/audit')}>سجل التدقيق</Link>}
      </div>
      {model && can(user, 'records.read') && (
        <div className="courses">
          <div className="courses-title">مجالات البنية المؤسسية</div>
          {model.domains.map((d) => {
            const blocks = model.blocks.filter((b) => b.domain_code === d.code && b.active && canInScope(user, 'records.read', b));
            const off = !d.active;
            return (
              <div key={d.code} className={`course${off ? ' off' : ''}`} style={{ ['--c' as string]: `var(--d-${d.code})` }}>
                <button aria-expanded={!!open[d.code] && !off} onClick={() => setOpen({ ...open, [d.code]: !open[d.code] })} disabled={off}
                  title={off ? 'هذا المجال غير مفعّل في جهتك' : undefined}>
                  <span>{d.name_ar}</span><span>{off ? 'غير مفعّل' : blocks.length}</span>
                </button>
                {open[d.code] && !off && (
                  <ul>{blocks.map((b) => <li key={b.code}><Link href={`/repo/${b.code}`} aria-current={cur(`/repo/${b.code}`)}>{b.name_ar}</Link></li>)}</ul>
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
  if (!user) return null;
  return (
    <div className="topbar">
      <span />
      <div className="who">
        <span>{user.name}</span>
        <span className="hint">{user.roles.map((r) => ROLE_NAMES[r]).join('، ')}</span>
        <button className="btn quiet" onClick={() => { setToken(null); window.location.href = '/login'; }}>خروج</button>
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
