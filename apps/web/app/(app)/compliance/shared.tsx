'use client';
import { useI18n } from '@/lib/i18n';

export const CMP_STATUSES = ['compliant', 'partial', 'non_compliant', 'not_applicable', 'not_assessed'] as const;

export function CmpStatus({ s }: { s: string }) {
  const { t } = useI18n();
  return <span className={`status cs-${s}`}>{t(`cmp.st.${s}`)}</span>;
}

/** One proportional bar per row: how the domain's controls split across statuses. */
export function StatusBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  const { t } = useI18n();
  const label = CMP_STATUSES.filter((s) => counts[s]).map((s) => `${t(`cmp.st.${s}`)}: ${counts[s]}`).join(t('list.sep'));
  return (
    <span className="stackbar" role="img" aria-label={label} title={label}>
      {CMP_STATUSES.map((s) => (counts[s] ? <i key={s} className={`sw-${s}`} style={{ width: `${(counts[s] / Math.max(total, 1)) * 100}%` }} /> : null))}
    </span>
  );
}
