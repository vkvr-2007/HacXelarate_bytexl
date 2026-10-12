import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, card, input, primary } from '../ui.jsx';

export default function Account() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api('/auth/password', { method: 'POST', body: form });
      setForm({ currentPassword: '', newPassword: '' });
      setDone(true);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 max-w-md">
      <h1 className="text-2xl font-bold text-white">My account</h1>
      <form onSubmit={submit} className={`${card} space-y-3`} aria-label="Change password">
        <h2 className="text-sm font-bold text-white">Change password</h2>
        <label className="block text-sm text-slate-300">Current password<input className={`${input} mt-1`} type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} required /></label>
        <label className="block text-sm text-slate-300">New password (12+ characters)<input className={`${input} mt-1`} type="password" autoComplete="new-password" minLength={12} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} required /></label>
        <ErrorBanner error={error} />
        {done && <p role="status" className="text-sm text-emerald-300">Password changed. Your other sessions were signed out.</p>}
        <button className={primary} disabled={busy}>Change password</button>
      </form>
      <p className="text-xs text-slate-400">Forgot your password? Self-service recovery is not supported. Ask an admin to reset it from the Users page.</p>
    </div>
  );
}
