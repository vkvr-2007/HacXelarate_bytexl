import { ExternalLink } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { ErrorBanner, Pill, Spinner, SourceStatus, card, timeAgo } from '../ui.jsx';

const CATEGORY = { app: 'App stores', social: 'Social platforms', web: 'Web search', domain: 'Domains', demo: 'Demo' };

function readiness(source) {
  if (source.support === 'unsupported') return 'unsupported';
  if (!source.configured) return 'not_configured';
  return source.lastStatus || null;
}

export default function Sources() {
  const { data, error, reload: load } = useApi(() => api('/sources'), []);

  const groups = {};
  for (const s of data?.sources || []) (groups[s.category] ||= []).push(s);

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-2xl font-bold text-white">Source health</h1>
      <p className="text-sm text-slate-400">Every source OmniScout knows about, what access it needs, and how it did on the last scan that used it. Unsupported platforms are listed so the gaps are visible.</p>
      <ErrorBanner error={error || (data?.mlError && new Error(`Source catalogue unavailable: ${data.mlError}`))} onRetry={load} />
      {!data ? <Spinner label="Loading sources" /> : Object.entries(groups).map(([category, sources]) => (
        <section key={category} className="space-y-2">
          <h2 className="text-sm font-bold text-slate-200">{CATEGORY[category] || category}</h2>
          <div className="grid md:grid-cols-2 gap-3">
            {sources.map((s) => {
              const state = readiness(s);
              return (
                <article key={s.key} className={`${card} min-w-0 break-words`} aria-label={s.label}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-white">{s.label}</h3>
                    <div className="flex gap-1">
                      {s.support === 'paid' && <Pill tone="text-amber-300 border-amber-800">Paid API</Pill>}
                      {s.support === 'approval_required' && <Pill tone="text-sky-300 border-sky-800">Needs platform approval</Pill>}
                      {state ? <SourceStatus status={state} /> : <Pill tone="text-slate-400 border-slate-700">Not run yet</Pill>}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{s.access}</p>
                  {s.missing?.length > 0 && s.support !== 'unsupported' && <p className="mt-1 text-xs text-slate-300">Set: <code className="text-amber-200">{s.missing.join(', ')}</code></p>}
                  {s.cost && s.cost !== 'Free' && <p className="mt-1 text-xs text-slate-400">Cost: {s.cost}</p>}
                  {s.lastMessage && <p className="mt-1 text-xs text-slate-400 break-words">Last result: {s.lastMessage}</p>}
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-400">
                    {s.lastOkAt && <span>last worked {timeAgo(s.lastOkAt)}</span>}
                    {s.consecutiveFailures > 0 && <span className="text-rose-300">{s.consecutiveFailures} failures in a row</span>}
                    {s.docs && <a className="inline-flex items-center gap-1 text-indigo-300 hover:underline" href={s.docs} target="_blank" rel="noopener noreferrer">Docs <ExternalLink size={10} /></a>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
