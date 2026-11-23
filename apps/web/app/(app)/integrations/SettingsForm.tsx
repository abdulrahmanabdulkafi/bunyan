'use client';
import { useI18n } from '@/lib/i18n';
import { SettingField } from '@/lib/integrations';

/** Connector settings. Secret fields are write-only: when editing, a blank secret keeps the stored value. */
export function SettingsForm({ fields, settings, secret, onSettings, onSecret, errors = {}, editing = false }: {
  fields: SettingField[]; settings: Record<string, unknown>; secret: Record<string, string>;
  onSettings: (s: Record<string, unknown>) => void; onSecret: (s: Record<string, string>) => void; errors?: Record<string, string>; editing?: boolean;
}) {
  const { t, nm } = useI18n();
  return (
    <div className="settings-grid" style={{ marginTop: 'var(--s-4)' }}>
      {fields.map((f) => {
        const label = <span>{nm(f)}{f.required && !(editing && f.secret) && <span className="req"> *</span>}</span>;
        const hint = nm(f, 'hint');
        if (f.type === 'boolean') {
          return <label key={f.key} className="row" style={{ gap: 6 }}><input type="checkbox" checked={settings[f.key] === true} onChange={(e) => onSettings({ ...settings, [f.key]: e.target.checked })} />{nm(f)}</label>;
        }
        return (
          <label key={f.key} className={`field${f.type === 'textarea' ? ' wide' : ''}`}>
            {label}
            {f.secret
              ? <input type={f.key.includes('password') || f.key.includes('value') ? 'password' : 'text'} dir="ltr" autoComplete="off" value={secret[f.key] ?? ''}
                  placeholder={editing ? t('int.secretKept') : undefined} onChange={(e) => onSecret({ ...secret, [f.key]: e.target.value })} />
              : f.type === 'textarea'
                ? <textarea dir="ltr" value={String(settings[f.key] ?? '')} onChange={(e) => onSettings({ ...settings, [f.key]: e.target.value })} />
                : <input dir="ltr" type={f.type === 'url' ? 'url' : 'text'} value={String(settings[f.key] ?? '')} onChange={(e) => onSettings({ ...settings, [f.key]: e.target.value })} />}
            {hint && <span className="hint">{hint}</span>}
            {errors[f.key] && <span className="field-error">{errors[f.key]}</span>}
          </label>
        );
      })}
    </div>
  );
}
