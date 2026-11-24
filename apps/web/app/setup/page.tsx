'use client';
import { useEffect, useState } from 'react';
import { api, getToken, setToken, startSession, User } from '@/lib/api';
import { MfaSetup, PasswordForm } from '@/lib/AccountForms';
import { LanguageToggle, useI18n } from '@/lib/i18n';

/** Finish what a limited session owes before entering the platform: a new password, then two-step verification. */
export default function Setup() {
  const { t } = useI18n();
  const [me, setMe] = useState<User | null>(null);
  useEffect(() => {
    if (!getToken()) { window.location.href = '/login'; return; }
    api<User>('/auth/me').then((u) => { if (!u.limited) window.location.href = '/'; else setMe(u); });
  }, []);
  if (!me) return null;
  const step = me.limited === 'password_change' ? 'password' : 'mfa';
  return (
    <main className="login" style={{ gridTemplateColumns: '1fr' }}>
      <section className="login-form" style={{ maxWidth: 520, margin: '0 auto' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{t(step === 'password' ? 'setup.passwordTitle' : 'setup.mfaTitle')}</h2>
          <LanguageToggle />
        </div>
        <p>{t(step === 'password' ? 'setup.passwordWhy' : 'setup.mfaWhy')}</p>
        {step === 'password'
          ? <PasswordForm onDone={(s) => { setToken(s.token); if (s.limited) window.location.reload(); else startSession(s); }} />
          : <MfaSetup onDone={startSession} />}
        <button className="btn quiet" onClick={() => { setToken(null); window.location.href = '/login'; }}>{t('nav.signOut')}</button>
      </section>
    </main>
  );
}
