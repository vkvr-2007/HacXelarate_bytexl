import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { Empty, ErrorBanner, ModeBadge, Spinner, SourceStatus, card, formatTime, primary, secondary, timeAgo } from '../ui.jsx';

const ACTIVE = new Set(['queued', 'running']);
const minutesQueued = (scan) => Math.floor((Date.now() - new Date(scan.queuedAt).getTime()) / 60000);

/** Says why a queued scan is not moving, instead of spinning forever. */
export function QueueNotice({ scan, system }) {
  if (!scan || scan.status !== 'queued' || !system || system.worker.active) return null;
  const minutes = minutesQueued(scan);
  if (minutes < 1) return null;
  return (
    <p role="alert" className="p-3 rounded-lg border border-amber-800/60 bg-amber-950/30 text-sm text-amber-200">
      Waiting for a worker: scan #{scan.id} has been queued for {minutes} min and no worker has checked in{system.worker.lastSeenAt ? ` since ${formatTime(system.worker.lastSeenAt)}` : ''}.
      {system.scheduler.canRunOnDemand ? ' It will run when the scheduler next fires.' : ' Start one with `npm run worker`, or set WORKER_SECRET so scans can run on demand.'}
    </p>
  );
}

export function useScanRunner(brand, onFinished) {
  const [scan, setScan] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const finished = useRef(onFinished);
  useEffect(() => { finished.current = onFinished; }, [onFinished]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = useCallback((id) => {
    const tick = async () => {
      try {
        const next = await api(`/scans/${id}`);
        setScan(next);
        if (ACTIVE.has(next.status)) timer.current = setTimeout(tick, 2000);
        else finished.current?.(next);
      } catch (err) { setError(err); }
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(tick, 2000);
  }, []);

  async function start() {
    setError(null);
    try {
      let queued;
      try {
        queued = await api(`/brands/${brand.id}/scans`, { method: 'POST' });
      } catch (err) {
        if (err.status !== 409) throw err;
        queued = err.data.scan;
      }
      setScan(queued);
      poll(queued.id);
      // Ask the server to run it now (needed where no background worker runs). Locally the worker picks it up anyway.
      api(`/scans/${queued.id}/run`, { method: 'POST' }).catch((err) => { if (err.status !== 429) setError(err); });
    } catch (err) { setError(err); }
  }

  return { scan, error, start, poll, running: Boolean(scan && ACTIVE.has(scan.status)) };
}

export default function Overview({ brand, canEdit, go }) {
  const { data: summary, error, reload: load } = useApi(() => api(`/brands/${brand.id}/summary`), [brand.id]);
  const runner = useScanRunner(brand, load);
  const { data: system } = useApi(() => api('/system'), []);
  const { poll } = runner;
  const activeId = summary?.lastScan && ACTIVE.has(summary.lastScan.status) ? summary.lastScan.id : null;
  useEffect(() => { if (activeId) poll(activeId); }, [activeId, poll]);

  const running = runner.running || Boolean(activeId && !runner.scan);
  const last = runner.scan && !ACTIVE.has(runner.scan.status) ? runner.scan : summary?.lastScan;
  const open = Object.values(summary?.bySeverity || {}).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4 max-w-6xl">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">{brand.name} <ModeBadge mode={brand.mode} /></h1>
          <p className="text-sm text-slate-400">{brand.domain} · {brand.scanIntervalMinutes ? `rescans every ${brand.scanIntervalMinutes / 60} h${system?.scheduler.cadenceMinutes > brand.scanIntervalMinutes ? ` (but the scheduler only runs about every ${Math.round(system.scheduler.cadenceMinutes / 60)} h here)` : ''}, next ${formatTime(brand.nextScanAt)}` : 'manual scans only'}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={secondary} onClick={load}><RefreshCw size={14} /> Refresh</button>
          {canEdit && <button type="button" className={primary} onClick={runner.start} disabled={running}><Play size={14} /> {running ? 'Scanning…' : 'Scan now'}</button>}
        </div>
      </header>
      {brand.mode === 'demo' && (
        <p className="p-3 rounded-lg border border-amber-800/60 bg-amber-950/30 text-sm text-amber-200">
          Northstar is a fictional brand. Its scans read a hand-labelled demo dataset, so precision and recall can be measured. No live source is called and no live result is shown here.
        </p>
      )}
      <ErrorBanner error={error || runner.error} onRetry={load} />
      <QueueNotice scan={runner.scan || (running ? summary?.lastScan : null)} system={system} />
      {running && <div className={card}><Spinner label={`Scan ${runner.scan?.status || summary?.lastScan?.status}… searching sources and scoring candidates`} /></div>}
      {!summary ? <Spinner label="Loading summary" /> : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3" aria-label="Open findings">
            <Metric label="Open findings" value={open} onClick={() => go('findings')} />
            {['Critical', 'High', 'Medium', 'Low'].map((s) => <Metric key={s} label={s} value={summary.bySeverity[s] || 0} />)}
          </section>
          <section className="grid md:grid-cols-3 gap-3">
            <div className={card}>
              <h2 className="text-sm font-bold text-white mb-2">By type</h2>
              {['social', 'app', 'domain', 'web'].map((t) => <Row key={t} label={{ social: 'Social accounts', app: 'Apps', domain: 'Look-alike domains', web: 'Web pages' }[t]} value={summary.byType[t] || 0} />)}
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-white mb-2">By platform</h2>
              {summary.byPlatform.length ? summary.byPlatform.slice(0, 8).map((p) => <Row key={p.platform} label={p.platform} value={p.count} />) : <p className="text-sm text-slate-400">No open findings.</p>}
            </div>
            <div className={card}>
              <h2 className="text-sm font-bold text-white mb-2">Review status</h2>
              {['new', 'reviewing', 'confirmed', 'false_positive', 'official', 'resolved'].map((s) => <Row key={s} label={s.replace('_', ' ')} value={summary.byStatus[s] || 0} />)}
            </div>
          </section>
          {last ? <ScanSummary scan={last} /> : <Empty title="No scans yet">{canEdit ? 'Run a scan to search the enabled sources.' : 'An analyst needs to run the first scan.'}</Empty>}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`${card} text-left`}>
      <div className="text-2xl font-mono font-bold text-white">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </Tag>
  );
}

const Row = ({ label, value }) => <div className="flex justify-between text-sm py-0.5 capitalize"><span className="text-slate-400">{label}</span><span className="font-mono text-slate-100">{value}</span></div>;

export function ScanSummary({ scan }) {
  const s = scan.stats || {};
  const attempted = (scan.sources || []).filter((x) => !['disabled'].includes(x.status));
  return (
    <section className={card} aria-label="Last scan">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-white">Last scan: {scan.status} · {timeAgo(scan.finishedAt || scan.queuedAt)}</h2>
        <span className="text-xs text-slate-400">{scan.trigger} · model {scan.model?.version || '—'} · {((s.durationMs || 0) / 1000).toFixed(1)} s</span>
      </div>
      {scan.error && <p className="mt-2 text-sm text-rose-300">{scan.error}</p>}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
        {[['Collected', s.collected], ['Official excluded', s.excludedOfficial], ['Kept by retriever', s.retrieved], ['Below threshold', s.belowThreshold], ['Flagged', s.detections]].map(([k, v]) => (
          <div key={k} className="p-2 rounded-lg bg-slate-950 border border-slate-800"><div className="font-mono text-lg text-white">{v ?? 0}</div><div className="text-[11px] text-slate-400">{k}</div></div>
        ))}
      </div>
      {scan.evaluation && (
        <p className="mt-3 text-xs text-slate-400">Against the demo labels: caught {scan.evaluation.caught} of {scan.evaluation.plantedThreats} planted fakes, {scan.evaluation.falsePositives} false positives, {scan.evaluation.officialFlagged} official assets flagged.</p>
      )}
      <ul className="mt-3 flex flex-wrap gap-2">
        {attempted.map((source) => <li key={source.key} className="flex items-center gap-1 text-xs text-slate-300" title={source.message}>{source.label} <SourceStatus status={source.status} /> <span className="font-mono text-slate-400">{source.count ?? 0}</span></li>)}
      </ul>
    </section>
  );
}
