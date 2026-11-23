'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

const COURSES: [string, string][] = [
  ['المواءمة الاستراتيجية', 'var(--d-strategy)'], ['الأعمال', 'var(--d-business)'], ['تجربة المستفيد', 'var(--d-beneficiary)'],
  ['البيانات', 'var(--d-data)'], ['التطبيقات', 'var(--d-applications)'], ['التقنية', 'var(--d-technology)'], ['الأمن السيبراني', 'var(--d-security)'],
];

export default function Login() {
  const router = useRouter();
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
        <h1>بُنيان</h1>
        <div className="stack">
          {COURSES.map(([n, c]) => <div key={n} style={{ ['--c' as string]: c }}>{n}</div>)}
        </div>
        <p style={{ color: '#9fb2b0', fontSize: 13 }}>مستودع البنية المؤسسية وفق النموذج العام لمحتوى البنية المؤسسية الصادر عن هيئة الحكومة الرقمية</p>
      </section>
      <form className="login-form" onSubmit={submit}>
        <h2>تسجيل الدخول</h2>
        {error && <div className="banner error" role="alert">{error}</div>}
        <label className="field">البريد الإلكتروني
          <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">كلمة المرور
          <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy}>{busy ? 'جارٍ الدخول…' : 'دخول'}</button>
        <p className="hint">الدخول الموحد عبر الدليل النشط أو نفاذ يُفعَّل من إعدادات الجهة.</p>
      </form>
    </main>
  );
}
