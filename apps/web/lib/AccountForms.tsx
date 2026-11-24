'use client';
import { FormEvent, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, Session } from './api';
import { useI18n } from './i18n';

/** Change own password. Calls onDone with the new session (the old one ends). */
export function PasswordForm({ onDone }: { onDone: (s: Session) => void }) {
  const { t } = useI18n();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [minLen, setMinLen] = useState(12);
  useEffect(() => { api<{ passwordMinLength: number }>('/auth/policy').then((p) => setMinLen(p.passwordMinLength)).catch(() => undefined); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) { setErr([t('acc.mismatch')]); return; }
    setBusy(true); setErr([]);
    try { onDone(await api<Session>('/auth/password', { method: 'POST', json: { current: cur, next } })); }
    catch (x) { setErr(x instanceof ApiError && x.errors.length ? x.errors.map((e) => e.message) : [(x as Error).message]); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--s-3)', maxWidth: 420 }}>
      <p className="hint">{t('acc.policy', { n: minLen })}</p>
      {err.length > 0 && <div className="banner error" role="alert">{err.map((m) => <div key={m}>{m}</div>)}</div>}
      <label className="field">{t('acc.current')}<input type="password" dir="ltr" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      <label className="field">{t('acc.new')}<input type="password" dir="ltr" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label className="field">{t('acc.again')}<input type="password" dir="ltr" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      <button className="btn primary" disabled={busy}>{t('acc.change')}</button>
    </form>
  );
}

/** Enrol an authenticator app: scan the QR code (or type the key), then confirm with a first code. */
export function MfaSetup({ onDone }: { onDone: (s: Session) => void }) {
  const { t } = useI18n();
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ secret: string; otpauth: string }>('/auth/mfa/setup', { method: 'POST' })
      .then(async (r) => { setSecret(r.secret); setQr(await QRCode.toDataURL(r.otpauth, { margin: 1, width: 200 })); })
      .catch((e) => setErr(e.message));
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    try { onDone(await api<Session>('/auth/mfa/enable', { method: 'POST', json: { code } })); }
    catch (x) { setErr((x as Error).message); }
  }
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--s-3)', maxWidth: 420 }}>
      <p className="hint">{t('acc.mfaSteps')}</p>
      {err && <div className="banner error" role="alert">{err}</div>}
      {qr && <img src={qr} alt={t('acc.qrAlt')} width={200} height={200} style={{ border: '1px solid var(--rule)', borderRadius: 'var(--r-sm)' }} />}
      {secret && <p className="hint">{t('acc.key')} <code dir="ltr" style={{ userSelect: 'all' }}>{secret.match(/.{1,4}/g)?.join(' ')}</code></p>}
      <label className="field">{t('acc.code')}<input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
      <button className="btn primary" disabled={code.length !== 6}>{t('acc.enableMfa')}</button>
    </form>
  );
}
