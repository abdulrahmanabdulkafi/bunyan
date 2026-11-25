'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';

interface Hit { id: string; name: string; block_code: string; status: string }

/** One search box for the whole repository (Ctrl+K or "/"), across every building block the user can read. */
export function GlobalSearch() {
  const { model } = useSession();
  const { t, nm } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); input.current?.focus(); }
    };
    const onClick = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey); window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const timer = setTimeout(() => api<{ total: number; items: Hit[] }>(`/search?q=${encodeURIComponent(q.trim())}&limit=12`)
      .then((r) => { setHits(r.items); setTotal(r.total); setActive(0); setOpen(true); }).catch(() => setHits([])), 200);
    return () => clearTimeout(timer);
  }, [q]);

  const go = (h: Hit) => { setOpen(false); setQ(''); input.current?.blur(); router.push(`/records/${h.id}`); };
  const block = (c: string) => model?.blocks.find((b) => b.code === c);

  return (
    <div className="gsearch" ref={box}>
      <input ref={input} type="search" value={q} placeholder={t('search.placeholder')} aria-label={t('search.label')}
        role="combobox" aria-expanded={open && !!hits} aria-controls="gsearch-list" aria-autocomplete="list"
        onFocus={() => hits && setOpen(true)} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (!hits?.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % hits.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + hits.length) % hits.length); }
          else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      <kbd className="hint" aria-hidden>Ctrl K</kbd>
      {open && hits && (
        <ul id="gsearch-list" role="listbox" className="gsearch-list">
          {hits.length === 0 && <li className="hint">{t('search.none')}</li>}
          {hits.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
              <span className="dom-dot" style={{ ['--c' as string]: `var(--d-${block(h.block_code)?.domain_code ?? ''})` }} />
              <span className="gsearch-name">{h.name || t('common.unnamed')}</span>
              <span className="hint">{nm(block(h.block_code)) || h.block_code}</span>
              <span className={`status st-${h.status}`}>{t(`status.${h.status}`)}</span>
            </li>
          ))}
          {total > hits.length && <li className="hint">{t('search.more', { n: total - hits.length })}</li>}
        </ul>
      )}
    </div>
  );
}
