import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { Empty, ErrorBanner, Pill, SeverityBadge, Spinner, SourceStatus, StatusBadge, card, formatTime, secondary } from '../ui.jsx';
import { FindingDetail } from './Findings.jsx';
import { ScanSummary } from './Overview.jsx';

function ScanFindings({ scanId, canEdit }) {
  const [shown, setShown] = useState(false);
  const [selected, setSelected] = useState(null);
  const { data, error } = useApi(() => (shown ? api(`/scans/${scanId}/findings`) : Promise.resolve(null)), [scanId, shown]);
  return (
    <details onToggle={(e) => setShown(e.currentTarget.open)}>
      <summary className="text-xs text-slate-300 cursor-pointer">Findings this scan saw</summary>
      <ErrorBanner error={error} />
      {shown && !data && !error && <Spinner label="Loading" />}
      {data && (data.items.length === 0 ? <p className="mt-1 text-xs text-slate-400">This scan did not flag anything.</p> : (
        <ul className="mt-1 space-y-1">
          {data.items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs">
              <SeverityBadge severity={f.severity} score={f.score} /><StatusBadge status={f.status} />
              <button type="button" className="text-slate-100 hover:underline text-left" onClick={() => setSelected(f.id)}>{f.name || f.handle}</button>
              <span className="text-slate-400">{f.platform}</span>
              {f.newInScan && <Pill tone="text-indigo-300 border-indigo-800">new in this scan</Pill>}
            </li>
          ))}
        </ul>
      ))}
      {selected && <FindingDetail id={selected} canEdit={canEdit} onClose={() => setSelected(null)} onChanged={() => {}} />}
    </details>
  );
}

const TONE = { succeeded: 'text-emerald-300', partial: 'text-amber-300', failed: 'text-rose-300', queued: 'text-slate-300', running: 'text-indigo-300' };

export default function Scans({ brand, canEdit, user }) {
  const [open, setOpen] = useState(null);
  const [alertError, setAlertError] = useState(null);
  const [alertNote, setAlertNote] = useState('');
  const { data: system } = useApi(() => api('/system'), []);
  const { data: alerts, reload: loadAlerts } = useApi(() => api('/alerts', { query: { brandId: brand.id } }), [brand.id]);
  const { data: scans, error, reload: load } = useApi(() => api(`/brands/${brand.id}/scans`, { query: { limit: 50 } }), [brand.id]);

  async function act(path, done) {
    setAlertError(null);
    setAlertNote('');
    try { await api(path, { method: 'POST' }); setAlertNote(done); } catch (err) { setAlertError(err); }
    loadAlerts();
  }

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-2xl font-bold text-white">Scan history</h1>
      <ErrorBanner error={error} onRetry={load} />
      <section className={card} aria-label="Alerts">
        <h2 className="text-sm font-bold text-white">Alerts</h2>
        <p className="text-xs text-slate-400 mb-2">
          {system?.alerts.configured === false ? 'No alert webhook is set (ALERT_WEBHOOK_URL), so new High and Critical findings are not sent anywhere.'
            : system?.alerts.configured ? 'New High and Critical findings are posted to the configured webhook.' : 'Alert settings could not be read.'}
        </p>
        <ErrorBanner error={alertError} />
        {alertNote && <p className="text-xs text-emerald-300" role="status">{alertNote}</p>}
        {alerts?.length > 0 && (
          <ul className="space-y-1 text-xs">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <Pill tone={a.ok ? 'text-emerald-300 border-emerald-800' : a.redelivered ? 'text-slate-300 border-slate-700' : 'text-rose-300 border-rose-800'}>{a.ok ? 'Sent' : a.redelivered ? 'Failed, redelivered' : 'Failed'}</Pill>
                <span className="text-slate-300">{a.kind === 'test' ? 'Test alert' : `${a.findings} finding${a.findings === 1 ? '' : 's'}${a.scanId ? `, scan #${a.scanId}` : ''}`}</span>
                <span className="text-slate-400">{formatTime(a.createdAt)}</span>
                {a.error && <span className="text-rose-300">{a.error}</span>}
                {!a.ok && !a.redelivered && a.kind === 'findings' && canEdit && (
                  <button type="button" className="text-indigo-300 underline" onClick={() => act(`/alerts/${a.id}/retry`, 'Alert redelivered.')}>Retry</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {user?.role === 'admin' && system?.alerts.configured && <button type="button" className={`${secondary} mt-2`} onClick={() => act('/alerts/test', 'Test alert sent.')}>Send test alert</button>}
      </section>
      {!scans ? <Spinner label="Loading scans" /> : !scans.length ? <Empty title="No scans yet" /> : (
        <ul className="space-y-2">
          {scans.map((scan) => (
            <li key={scan.id} className={card}>
              <button type="button" className="w-full flex flex-wrap justify-between gap-2 text-left" onClick={() => setOpen(open === scan.id ? null : scan.id)} aria-expanded={open === scan.id}>
                <span className="text-sm text-white">Scan #{scan.id} · <span className={TONE[scan.status]}>{scan.status}</span> · {scan.trigger}</span>
                <span className="text-xs text-slate-400">{formatTime(scan.finishedAt || scan.startedAt || scan.queuedAt)} · {scan.stats?.detections ?? '—'} flagged</span>
              </button>
              {open === scan.id && (
                <div className="mt-3 space-y-3">
                  <ScanSummary scan={scan} />
                  <ScanFindings scanId={scan.id} canEdit={canEdit} />
                  <table className="w-full text-xs">
                    <thead className="text-left text-slate-400"><tr><th className="py-1">Source</th><th>Status</th><th>Results</th><th>Time</th><th>Detail</th></tr></thead>
                    <tbody className="divide-y divide-slate-800">
                      {(scan.sources || []).map((s) => (
                        <tr key={s.key}><td className="py-1 text-slate-200">{s.label}</td><td><SourceStatus status={s.status} /></td><td className="font-mono">{s.count ?? 0}</td>
                          <td className="font-mono text-slate-400">{s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(1)} s` : ''}</td><td className="text-slate-400 break-words max-w-md">{s.message}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {scan.excluded?.length > 0 && (
                    <details><summary className="text-xs text-slate-300 cursor-pointer">{scan.excluded.length} official assets recognised and excluded</summary>
                      <ul className="mt-1 text-xs text-slate-400">{scan.excluded.map((x) => <li key={`${x.platform}${x.handle || x.appId || x.url}`}>{x.platform}: {x.name || x.handle} ({x.reason})</li>)}</ul>
                    </details>
                  )}
                  {scan.queries && <p className="text-xs text-slate-400">Queries: {scan.queries.join(', ')}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
