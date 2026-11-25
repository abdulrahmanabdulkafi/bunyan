'use client';
import { useI18n } from '@/lib/i18n';

export const PHASES = ['scope', 'baseline', 'target', 'gap', 'roadmap', 'approval'] as const;
export interface CycleRow {
  id: string; code: string; name: string; objective: string | null; domains: string[]; start_date: string | null; end_date: string | null;
  status: 'planned' | 'active' | 'closed' | 'cancelled'; phase: (typeof PHASES)[number]; owner_name: string | null;
  tasks_total: number; tasks_done: number; tasks_overdue: number; changes: number;
}

/** The phase track: done phases filled, the current one marked. */
export function PhaseTrack({ phase, status, compact = false }: { phase: string; status: string; compact?: boolean }) {
  const { t } = useI18n();
  const at = PHASES.indexOf(phase as (typeof PHASES)[number]);
  return (
    <ol className={`phases${compact ? ' compact' : ''}`} aria-label={t('cycle.phases')}>
      {PHASES.map((p, i) => {
        const st = status === 'closed' || i < at ? 'done' : i === at && status === 'active' ? 'now' : 'next';
        return <li key={p} className={`ph-${st}`} aria-current={st === 'now' ? 'step' : undefined}><span>{i + 1}</span>{!compact && <b>{t(`cycle.phase.${p}`)}</b>}</li>;
      })}
    </ol>
  );
}

