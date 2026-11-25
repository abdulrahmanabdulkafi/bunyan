'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, VpMeta } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';


const DOMAINS = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'];

export default function Viewpoints() {
  const { model } = useSession();
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
      </div></div>
      {DOMAINS.filter((d) => list.some((v) => v.domain === d)).map((d) => (
        <section key={d} className="vp-domain">
          <h2><span className="dom-dot" style={{ ['--c' as string]: `var(--d-${d})` }} />{t(`domain.${d}`)}</h2>
          <ul className="vp-list">
            {list.filter((v) => v.domain === d).map((v) => (
              <li key={v.code} className={v.missing.length ? 'off' : undefined}>
                <span className="vp-kind">{t(`vp.kind.${v.kind}`)}</span>
                <span>
                  <Link href={`/views/${v.code}`}>{nm(v)}</Link>
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
