'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, can, VpMeta } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';


const DOMAINS = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'];

export default function Page() { return <Suspense><Viewpoints /></Suspense>; }

function Viewpoints() {
  const { model, user } = useSession();
  const sp = useSearchParams();
  // Opened from a development cycle: every viewpoint keeps its current/target state.
  const carry = sp.get('cycle') ? `?cycle=${sp.get('cycle')}&state=${sp.get('state') === 'current' ? 'current' : 'target'}` : '';
  const { t, nm } = useI18n();
  const [list, setList] = useState<VpMeta[] | null>(null);
  useEffect(() => { api<VpMeta[]>('/viewpoints/catalog').then(setList); }, []);
  if (!list || !model) return <p className="hint">{t('common.loading')}</p>;
  const ready = list.filter((v) => !v.missing.length).length;
  const blockName = (c: string) => nm(model.blocks.find((b) => b.code === c)) || c;

  return (
    <>
      <div className="page-head"><div>
        <h1>{t('vp.title')}</h1>
        <p>{t('vp.subtitle', { ready, total: list.length })}</p>
      </div>
      {can(user, 'viewpoints.build') && <Link className="btn primary" href="/views/builder">{t('vb.new')}</Link>}
      </div>
      {carry && <div className="banner ok">{t(sp.get('state') === 'current' ? 'vp.currentHint' : 'vp.targetHint')} <Link href={`/cycles/${sp.get('cycle')}`}>{t('vp.openCycle')}</Link></div>}
      {DOMAINS.filter((d) => list.some((v) => v.domain === d)).map((d) => (
        <section key={d} className="vp-domain">
          <h2><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${d})` }} />{t(`domain.${d}`)}</h2>
          <ul className="vp-list">
            {list.filter((v) => v.domain === d).map((v) => (
              <li key={v.code} className={v.missing.length ? 'off' : undefined}>
                <span className="vp-kind">{t(`vp.kind.${v.kind}`)}</span>
                <span>
                  <Link href={`/views/${v.code}${carry}`}>{nm(v)}</Link>{v.custom && <span className="tag-custom">{t('vb.customTag')}</span>}
                  <span className="hint" style={{ display: 'block' }}>
                    {v.missing.length ? t('vp.needs', { blocks: v.missing.map(blockName).join(t('list.sep')) }) : nm(v, 'purpose')}
                  </span>
                </span>
                <span className="hint" dir="ltr">{v.code}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
