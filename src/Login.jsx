import { useState } from 'react';
import OwlLogo from './OwlLogo.jsx';
import { api } from './api.js';
import { ErrorBanner, card, input, primary } from './ui.jsx';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email, password } });
      onSignedIn(user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className={`${card} w-full max-w-sm space-y-4`} aria-label="Sign in">
        <div className="flex items-center gap-2 text-white font-extrabold text-lg"><OwlLogo className="text-indigo-400" /> OmniScout</div>
        <p className="text-sm text-slate-400">Sign in to review brand impersonation findings.</p>
        <label className="block text-sm text-slate-300">Email
          <input className={`${input} mt-1`} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block text-sm text-slate-300">Password
          <input className={`${input} mt-1`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorBanner error={error} />
        <button className={`${primary} w-full justify-center`} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
