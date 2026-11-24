'use client';
import { useState } from 'react';
import { setToken } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/lib/i18n';
import { MfaSetup, PasswordForm } from '@/lib/AccountForms';

export default function Account() {
  const { user } = useSession();
  const { t } = useI18n();
  const [msg, setMsg] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  if (!user) return null;
  return (
    <>
      <div className="page-head"><div><h1>{t('acc.title')}</h1><p>{user.email}</p></div></div>
      {msg && <div className="banner ok" role="status">{msg}</div>}
      <section className="section">
        <h2>{t('acc.passwordSection')}</h2>
        <div style={{ marginTop: 'var(--s-3)' }}>
          <PasswordForm onDone={(s) => { setToken(s.token); setMsg(t('acc.changed')); }} />
        </div>
      </section>
      <section className="section">
        <h2>{t('acc.mfaSection')}</h2>
        {user.mfaEnabled ? (
          <p className="banner ok" style={{ marginTop: 'var(--s-3)' }}>{t('acc.mfaOn')}</p>
        ) : enrolling ? (
          <div style={{ marginTop: 'var(--s-3)' }}><MfaSetup onDone={(s) => { setToken(s.token); window.location.reload(); }} /></div>
        ) : (
          <>
            <p className="hint" style={{ margin: 'var(--s-2) 0 var(--s-3)' }}>{t(user.mfaRequired ? 'acc.mfaRequired' : 'acc.mfaOptional')}</p>
            <button className="btn primary" onClick={() => setEnrolling(true)}>{t('acc.setupMfa')}</button>
          </>
        )}
      </section>
    </>
  );
}
