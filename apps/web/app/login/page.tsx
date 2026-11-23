'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';
import { LanguageToggle, useI18n } from '@/lib/i18n';

const COURSES = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'];

export default function Login() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ token: string }>('/auth/login', { method: 'POST', json: { email, password } });
      setToken(r.token);
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <section className="login-art" aria-hidden="true">
        <h1>{t('brand')}</h1>
        <div className="stack">
          {COURSES.map((c) => <div key={c} style={{ ['--c' as string]: `var(--d-${c})` }}>{t(`domain.${c}`)}</div>)}
        </div>
        <p style={{ color: '#9fb2b0', fontSize: 13 }}>{t('login.tagline')}</p>
      </section>
      <form className="login-form" onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{t('login.title')}</h2>
          <LanguageToggle />
        </div>
        {error && <div className="banner error" role="alert">{error}</div>}
        <label className="field">{t('login.email')}
          <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">{t('login.password')}
          <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy}>{busy ? t('login.signingIn') : t('login.signIn')}</button>
        <p className="hint">{t('login.ssoHint')}</p>
      </form>
    </main>
  );
}
