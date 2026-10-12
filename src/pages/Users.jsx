import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { ErrorBanner, Pill, Spinner, card, formatTime, input, primary, secondary } from '../ui.jsx';

export default function Users() {
  const [form, setForm] = useState({ email: '', password: '', role: 'analyst' });
  const [error, setError] = useState(null);
  const { data: users, error: loadError, reload } = useApi(() => api('/users'), []);
  const { data: audit, reload: reloadAudit } = useApi(() => api('/audit', { query: { limit: 30 } }), []);

  async function run(work) {
    try { await work(); setError(null); reload(); reloadAudit(); } catch (err) { setError(err); }
  }
  const add = (event) => { event.preventDefault(); run(async () => { await api('/users', { method: 'POST', body: form }); setForm({ email: '', password: '', role: 'analyst' }); }); };
  const update = (id, body) => run(() => api(`/users/${id}`, { method: 'PATCH', body }));
  const resetPassword = (u) => {
    const newPassword = window.prompt(`New password for ${u.email} (12+ characters). Their sessions will be signed out.`);
    if (newPassword) run(() => api(`/users/${u.id}/password`, { method: 'POST', body: { newPassword } }));
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Users</h1>
      <ErrorBanner error={error || loadError} />
      <form onSubmit={add} className={`${card} grid md:grid-cols-4 gap-2`} aria-label="Add user">
        <input aria-label="Email" className={input} type="email" placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input aria-label="Password" className={input} type="password" placeholder="password (12+)" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <select aria-label="Role" className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="viewer">Viewer (read only)</option><option value="analyst">Analyst (scan and review)</option><option value="admin">Admin</option>
        </select>
        <button className={primary}>Add user</button>
      </form>
      {!users ? <Spinner /> : (
        <table className={`${card} w-full text-sm`}>
          <caption className="sr-only">Users</caption>
          <tbody className="divide-y divide-slate-800">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="py-2 text-slate-100">{u.email} {u.disabled_at && <Pill tone="text-rose-300 border-rose-800">disabled</Pill>}</td>
                <td>
                  <select aria-label={`Role of ${u.email}`} className={`${input} py-1`} value={u.role} onChange={(e) => update(u.id, { role: e.target.value })}>
                    <option value="viewer">viewer</option><option value="analyst">analyst</option><option value="admin">admin</option>
                  </select>
                </td>
                <td className="text-xs text-slate-400">last sign-in {formatTime(u.last_login_at)}</td>
                <td className="text-right space-x-1">
                  <button type="button" className={`${secondary} py-1 text-xs`} onClick={() => resetPassword(u)}>Reset password</button>
                  <button type="button" className={`${secondary} py-1 text-xs`} onClick={() => update(u.id, { disabled: !u.disabled_at })}>{u.disabled_at ? 'Enable' : 'Disable'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section className={card} aria-label="Security log">
        <h2 className="text-sm font-bold text-white mb-2">Security log</h2>
        <ul className="space-y-1 text-xs text-slate-400">
          {(audit || []).map((a) => <li key={a.id}>{formatTime(a.created_at)} · <span className="text-slate-200">{a.kind}</span> {a.target && `· ${a.target}`} {a.actor && `· by ${a.actor}`}</li>)}
        </ul>
      </section>
    </div>
  );
}
