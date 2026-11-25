'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Notif { id: string; kind: string; payload: Record<string, string>; read_at: string | null; created_at: string; actor_name: string | null }

/** The bell: workflow and cycle notifications for the signed-in user, refreshed every minute. */
export function NotificationBell() {
  const { t, date, locale } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<{ unread: number; items: Notif[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api<typeof data>('/notifications').then(setData).catch(() => undefined), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    const onClick = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onClick);
    return () => { clearInterval(timer); window.removeEventListener('mousedown', onClick); };
  }, [load]);

  const text = (n: Notif) => t(`notif.${n.kind}`, {
    name: n.payload.name ?? '', comment: n.payload.comment ?? '', title: n.payload.title ?? '', cycle: n.payload.cycle ?? '',
    phase: n.payload.phase ? t(`cycle.phase.${n.payload.phase}`) : '',
  });
  async function go(n: Notif) {
    setOpen(false);
    if (!n.read_at) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
    load();
    if (n.payload.path) router.push(n.payload.path);
  }

  return (
    <div className="bell" ref={box}>
      <button className="btn quiet" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}
        aria-label={t('notif.label', { n: data.unread })}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z" /></svg>
        {data.unread > 0 && <span className="count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label={t('notif.title')}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{t('notif.title')}</b>
            {data.unread > 0 && <button className="btn quiet" onClick={async () => { await api('/notifications/read-all', { method: 'POST' }); load(); }}>{t('notif.readAll')}</button>}
          </div>
          {data.items.length === 0 ? <p className="hint">{t('notif.none')}</p> : (
            <ul>{data.items.map((n) => (
              <li key={n.id} className={n.read_at ? undefined : 'unread'}>
                <button onClick={() => go(n)} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
                  <span>{text(n)}</span>
                  <span className="hint">{n.actor_name ? `${n.actor_name} · ` : ''}{date(n.created_at)}</span>
                </button>
              </li>))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
