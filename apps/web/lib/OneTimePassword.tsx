'use client';
import { useI18n } from './i18n';

/** Shown once after creating an account or resetting a password. */
export function OneTimePassword({ email, pw, onClose }: { email: string; pw: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="banner warn" role="alert">
      <b>{t('users.tempTitle', { email })}</b>
      <p style={{ margin: '6px 0' }}><code dir="ltr" style={{ fontSize: 16, userSelect: 'all' }}>{pw}</code></p>
      <p className="hint">{t('users.tempHint')}</p>
      <button className="btn" onClick={() => { navigator.clipboard?.writeText(pw); }}>{t('users.copy')}</button>{' '}
      <button className="btn quiet" onClick={onClose}>{t('common.close')}</button>
    </div>
  );
}

