'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MESSAGES } from './messages';

export type Locale = 'ar' | 'en';
export const LANG_KEY = 'bunyan.lang';

export function storedLocale(): Locale {
  if (typeof window === 'undefined') return 'ar';
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ar'; } catch { return 'ar'; }
}

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Interface text by key; `{name}` placeholders are filled from vars. Arabic is the source language. */
  t: (key: keyof typeof MESSAGES | string, vars?: Record<string, string | number>) => string;
  /** Pick the Arabic or English name of anything from the meta-model (name_ar / name_en, label_ar / label_en …). */
  nm: (o: object | null | undefined, field?: string) => string;
  date: (s: string) => string;
  num: (n: number) => string;
  pct: (x: number) => string;
}

const Ctx = createContext<I18n | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLoc] = useState<Locale>('ar');
  useEffect(() => { setLoc(storedLocale()); }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
    setLoc(l);
  }, []);

  const value = useMemo<I18n>(() => {
    const t: I18n['t'] = (key, vars) => {
      const m = MESSAGES[key as keyof typeof MESSAGES];
      let s = m ? m[locale] : String(key);
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    const nm: I18n['nm'] = (o, field = 'name') => {
      if (!o) return '';
      const r = o as Record<string, unknown>;
      const v = r[`${field}_${locale}`] ?? r[`${field}_ar`] ?? r[field];
      return v === undefined || v === null ? '' : String(v);
    };
    const tag = locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB';
    return {
      locale, setLocale, t, nm,
      date: (s) => new Date(s).toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' }),
      num: (n) => n.toLocaleString('en-US'),
      pct: (x) => `${Math.round(x * 100)}${locale === 'ar' ? '٪' : '%'}`,
    };
  }, [locale, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside LocaleProvider');
  return c;
}

/** One button: shows the other language, switches the whole interface (text, direction, names). */
export function LanguageToggle({ className = 'btn quiet' }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <button className={className} onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} lang={locale === 'ar' ? 'en' : 'ar'}
      aria-label={locale === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}>
      {locale === 'ar' ? 'English' : 'العربية'}
    </button>
  );
}
