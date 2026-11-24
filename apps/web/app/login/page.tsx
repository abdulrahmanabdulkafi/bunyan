'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api, Session, startSession } from '@/lib/api';
import { LanguageToggle, useI18n } from '@/lib/i18n';

const COURSES = ['strategy', 'business', 'beneficiary', 'data', 'applications', 'technology', 'security'];

export default function Login() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('idle')) setNotice(t('login.idle'));
    else if (q.get('expired')) setNotice(t('login.expired'));
  }, [t]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (!challenge) {
        const r = await api<Session & { mfa_required?: boolean; challenge?: string }>('/auth/login', { method: 'POST', json: { email, password } });
        if (r.mfa_required && r.challenge) { setChallenge(r.challenge); setPassword(''); return; }
        startSession(r);
      } else {
        startSession(await api<Session>('/auth/mfa/verify', { method: 'POST', json: { challenge, code } }));
      }
    } catch (err) {
      setError((err as Error).message);
      if (challenge && /انتهت|expired/i.test((err as Error).message)) { setChallenge(''); setCode(''); }
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
          <h2>{challenge ? t('login.mfaTitle') : t('login.title')}</h2>
          <LanguageToggle />
        </div>
        {notice && !error && <div className="banner warn" role="status">{notice}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}
        {!challenge ? (
          <>
            <label className="field">{t('login.email')}
              <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">{t('login.password')}
              <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="hint">{t('login.mfaHint')}</p>
            <label className="field">{t('acc.code')}
              <input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
          </>
        )}
        <button className="btn primary" disabled={busy || (!!challenge && code.length !== 6)}>{busy ? t('login.signingIn') : challenge ? t('login.verify') : t('login.signIn')}</button>
        {challenge && <button type="button" className="btn quiet" onClick={() => { setChallenge(''); setCode(''); }}>{t('login.back')}</button>}
        <p className="hint">{t('login.ssoHint')}</p>
      </form>
    </main>
  );
}
