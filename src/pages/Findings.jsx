import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { api, downloadUrl } from '../api.js';
import { useApi } from '../useApi.js';
import {
  Empty, ErrorBanner, ModeBadge, Pill, STATUS_LABEL, SeverityBadge, Spinner, StatusBadge, card, formatTime, input, primary, secondary, timeAgo,
} from '../ui.jsx';

const TYPES = { '': 'All types', social: 'Social', app: 'Apps', domain: 'Domains', web: 'Web pages' };
const SEVERITIES = ['', 'Critical', 'High', 'Medium', 'Low'];
export const PAGE_SIZE = 50;

export default function Findings({ brand, canEdit }) {
  const [filters, setFilters] = useState({ type: '', status: '', severity: '', q: '', sort: 'score', minScore: '', page: 0 });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const page = filters.page;
  const setPage = (next) => setFilters((f) => ({ ...f, page: next }));
  useEffect(() => {
    const t = setTimeout(() => { setFilters((f) => (f.q === search ? f : { ...f, q: search, page: 0 })); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  // The page is stored with the result so the range label never describes a page that has not arrived yet.
  const { data, error, reload: load } = useApi(() => api('/findings', { query: { brandId: brand.id, ...filters, page: undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE } }).then((result) => ({ ...result, page })), [brand.id, filters, page]);
  const loading = data && data.page !== page;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const set = (key) => (event) => setFilters((f) => ({ ...f, [key]: event.target.value, page: 0 }));
  const { page: _page, ...active } = filters;
  const query = { brandId: brand.id, ...Object.fromEntries(Object.entries(active).filter(([, v]) => v)) };

  return (
    <div className="space-y-4 max-w-7xl">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">Findings <ModeBadge mode={brand.mode} /></h1>
        <a className={secondary} href={downloadUrl('/findings/export.csv', query)}><Download size={14} /> Export CSV</a>
      </header>
      <form className="grid grid-cols-2 md:grid-cols-6 gap-2" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <input aria-label="Search" className={`${input} col-span-2`} placeholder="Search name, handle, URL, publisher" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Type" className={input} value={filters.type} onChange={set('type')}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Status" className={input} value={filters.status} onChange={set('status')}>
          <option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select aria-label="Severity" className={input} value={filters.severity} onChange={set('severity')}>{SEVERITIES.map((s) => <option key={s} value={s}>{s || 'All severities'}</option>)}</select>
        <select aria-label="Sort" className={input} value={filters.sort} onChange={set('sort')}>
          <option value="score">Highest risk</option><option value="last_seen">Recently seen</option><option value="first_seen">Newest</option>
        </select>
      </form>
      <ErrorBanner error={error} onRetry={load} />
      {!data ? <Spinner label="Loading findings" /> : data.items.length === 0 ? (
        <Empty title="No findings match">Change the filters, or run a scan from the overview.</Empty>
      ) : (
        <div className={`${card} p-0 overflow-x-auto`}>
          <table className="w-full text-sm">
            <caption className="sr-only">Findings for {brand.name}</caption>
            <thead className="text-left text-xs text-slate-400 border-b border-slate-800">
              <tr><th className="p-3">Risk</th><th className="p-3">Candidate</th><th className="p-3">Platform</th><th className="p-3">Why</th><th className="p-3">Status</th><th className="p-3">Last seen</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {data.items.map((f) => (
                <tr key={f.id} className="hover:bg-slate-900/80 cursor-pointer" onClick={() => setSelected(f.id)}>
                  <td className="p-3"><SeverityBadge severity={f.severity} score={f.score} /></td>
                  <td className="p-3 max-w-xs">
                    <button type="button" className="text-left text-slate-100 font-medium hover:underline truncate block max-w-full">{f.name || f.handle}</button>
                    <div className="text-xs text-slate-400 truncate">{f.handle || f.appId} {f.publisher && `· ${f.publisher}`}</div>
                    {f.missedScans > 0 && <Pill tone="text-slate-300 border-slate-700" title="A complete scan of its source did not return it. It may have been removed, renamed or hidden.">Not seen in last {f.missedScans === 1 ? 'scan' : `${f.missedScans} scans`}</Pill>}
                  </td>
                  <td className="p-3 text-slate-300 whitespace-nowrap">{f.platform}<div className="text-xs text-slate-400">{f.category}</div></td>
                  <td className="p-3 text-xs text-slate-400 max-w-sm">{(f.reasons || []).slice(0, 2).join(' · ')}</td>
                  <td className="p-3"><StatusBadge status={f.status} /></td>
                  <td className="p-3 text-xs text-slate-400 whitespace-nowrap">{timeAgo(f.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <p>Showing {data.page * PAGE_SIZE + 1}–{data.page * PAGE_SIZE + data.items.length} of {data.total} findings. Scores are model risk estimates to help prioritise review, not proof of impersonation.</p>
            <nav className="flex items-center gap-2" aria-label="Pages">
              <button type="button" className={secondary} disabled={loading || page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page + 1} of {pages}</span>
              <button type="button" className={secondary} disabled={loading || page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </nav>
          </div>
        </div>
      )}
      {selected && <FindingDetail id={selected} canEdit={canEdit} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

const ACTIONS = [
  ['reviewing', 'Start review'], ['confirmed', 'Confirm impersonation'], ['false_positive', 'False positive'],
  ['official', 'Mark official'], ['resolved', 'Resolved (taken down)'], ['new', 'Reopen'],
];

export function FindingDetail({ id, canEdit, onClose, onChanged }) {
  const { data: finding, error: loadError, reload: load } = useApi(() => api(`/findings/${id}`), [id]);
  const { data: observations } = useApi(() => api(`/findings/${id}/observations`), [id]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  // Keyboard users: focus moves into the drawer, Tab stays inside it, Escape closes it and focus returns to where it was.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { close.current(); return; }
      if (e.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll('a[href], button:not([disabled]), textarea, input, select')];
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (opener instanceof HTMLElement && document.contains(opener)) opener.focus(); };
  }, []);

  async function act(body) {
    setBusy(true);
    setError(null);
    try {
      if (body.status) await api(`/findings/${id}`, { method: 'PATCH', body: { status: body.status, ...(note ? { note } : {}) } });
      else await api(`/findings/${id}/notes`, { method: 'POST', body: { note } });
      setNote('');
      load();
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const e = finding?.evidence || {};
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Finding detail" tabIndex={-1} className="w-full max-w-2xl h-full overflow-y-auto bg-slate-950 border-l border-slate-800 p-5 space-y-4 focus:outline-none" onClick={(ev) => ev.stopPropagation()}>
        <div className="flex justify-between items-start gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white break-words">{finding?.name || 'Finding'}</h2>
            {finding && <p className="text-sm text-slate-400 break-all">{finding.platform} · {finding.handle || finding.appId} {finding.publisher && `· ${finding.publisher}`}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-white"><X /></button>
        </div>
        <ErrorBanner error={error || loadError} />
        {!finding ? <Spinner label="Loading" /> : (
          <>
            <div className="flex flex-wrap gap-2 items-center">
              <SeverityBadge severity={finding.severity} score={finding.score} /><StatusBadge status={finding.status} /><Pill tone="text-slate-300 border-slate-700">{finding.category}</Pill>
              {e.cached && <Pill tone="text-amber-300 border-amber-800">from cached results</Pill>}
              {finding.mode === 'demo' && <ModeBadge mode="demo" />}
            </div>
            {finding.url && <a className="inline-flex items-center gap-1 text-sm text-indigo-300 hover:underline break-all" href={finding.url} target="_blank" rel="noopener noreferrer nofollow">{finding.url} <ExternalLink size={12} /></a>}
            <section className={card}>
              <h3 className="text-sm font-bold text-white mb-2">Why it was flagged</h3>
              <ul className="space-y-1 text-sm text-slate-300 list-disc pl-5">{(finding.reasons || []).map((r) => <li key={r}>{r}</li>)}</ul>
              {finding.factors?.length > 0 && (
                <table className="w-full mt-3 text-xs"><tbody>
                  {finding.factors.map((f) => <tr key={f.factor}><td className="py-0.5 text-slate-400">{f.factor}</td><td className={`text-right font-mono ${f.points < 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{f.points > 0 ? '+' : ''}{f.points}</td></tr>)}
                </tbody></table>
              )}
              <p className="mt-2 text-xs text-slate-400">Model probability {finding.probability != null ? `${(finding.probability * 100).toFixed(1)}%` : '—'}. This is a risk estimate, not proof.</p>
            </section>
            <section className={card}>
              <h3 className="text-sm font-bold text-white mb-2">Evidence</h3>
              <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                <dt className="text-slate-400">Source</dt><dd className="col-span-2 text-slate-300">{finding.source}{e.provider ? ` via ${e.provider}` : ''}</dd>
                <dt className="text-slate-400">Search query</dt><dd className="col-span-2 text-slate-300 break-words">{e.query || '—'}</dd>
                <dt className="text-slate-400">Collected</dt><dd className="col-span-2 text-slate-300">{formatTime(e.collectedAt)}</dd>
                <dt className="text-slate-400">Scored</dt><dd className="col-span-2 text-slate-300">{formatTime(e.scoredAt)} · model {e.modelVersion}</dd>
                <dt className="text-slate-400">First / last seen</dt><dd className="col-span-2 text-slate-300">{formatTime(finding.firstSeenAt)} / {formatTime(finding.lastSeenAt)}</dd>
                {e.dns && <><dt className="text-slate-400">DNS</dt><dd className="col-span-2 text-slate-300 break-all">A {e.dns.a?.join(', ') || '—'} · MX {e.dns.mx?.join(', ') || '—'}</dd></>}
                {e.certificate && <><dt className="text-slate-400">Certificate</dt><dd className="col-span-2 text-slate-300 break-words">{e.certificate.issuer} · from {e.certificate.notBefore}</dd></>}
                {e.page && <><dt className="text-slate-400">Page check</dt><dd className="col-span-2 text-slate-300 break-words">{e.page.fetched ? `HTTP ${e.page.status}, "${e.page.title || 'no title'}", ${e.page.passwordFields || 0} password fields` : e.page.reason}</dd></>}
              </dl>
              {finding.description && <p className="mt-2 text-xs text-slate-400 italic break-words">“{finding.description}”</p>}
              <a className="mt-3 inline-flex items-center gap-1 text-xs text-indigo-300 hover:underline" href={downloadUrl(`/findings/${finding.id}/evidence.json`)}><Download size={12} /> Download evidence (JSON)</a>
            </section>
            {e.declaredAsset && <p className="text-xs text-amber-300 border border-amber-800/60 rounded-lg p-2" role="note">{e.declaredAsset}. Confirm the asset in the brand profile to hide it from results.</p>}
            {finding.missedScans > 0 && <p className="text-xs text-slate-300 border border-slate-700 rounded-lg p-2" role="note">Not returned by a complete scan of its source in the last {finding.missedScans} scan(s). Its status was not changed.</p>}
            {observations?.length > 0 && (
              <section className={card} aria-label="Scan history">
                <h3 className="text-sm font-bold text-white mb-2">What each scan saw</h3>
                <table className="w-full text-xs"><thead className="text-left text-slate-400"><tr><th className="py-1">Scan</th><th>When</th><th>Score</th><th>Source</th><th>Top reason</th></tr></thead>
                  <tbody>{observations.map((o) => (
                    <tr key={o.id} className="border-t border-slate-800"><td className="py-1 font-mono">#{o.scanId}</td><td>{formatTime(o.observedAt)}</td><td className="font-mono">{o.score}</td><td>{o.source}</td><td className="text-slate-400">{o.reasons?.[0] || '—'}</td></tr>
                  ))}</tbody></table>
              </section>
            )}
            {canEdit && (
              <section className={card}>
                <h3 className="text-sm font-bold text-white mb-2">Review decision</h3>
                <textarea aria-label="Note" rows={2} className={input} placeholder="Note for the audit trail (optional)" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={2000} />
                <div className="mt-2 flex flex-wrap gap-2">
                  {ACTIONS.filter(([s]) => s !== finding.status).map(([status, label]) => (
                    <button key={status} type="button" disabled={busy || (status === 'official' && note.trim().length < 8)} title={status === 'official' ? 'Needs a note of at least 8 characters saying how you know it is official' : undefined} className={status === 'confirmed' ? primary : secondary} onClick={() => act({ status })}>{label}</button>
                  ))}
                  <button type="button" disabled={busy || !note.trim()} className={secondary} onClick={() => act({})}>Add note</button>
                </div>
                <p className="mt-2 text-xs text-slate-400">Marking official needs a note and hides this item from every future scan. {finding.mode === 'demo' ? 'Decisions on demo data never train the model.' : 'Confirmed and dismissed live findings can train the next model once enough of both kinds exist.'}</p>
              </section>
            )}
            <section className={card}>
              <h3 className="text-sm font-bold text-white mb-2">Audit trail</h3>
              <ol className="space-y-2 text-xs">
                {finding.events.map((ev) => (
                  <li key={ev.id} className="border-l-2 border-slate-700 pl-3">
                    <div className="text-slate-300">
                      {ev.kind === 'status_change' ? `${STATUS_LABEL[ev.fromStatus] || ev.fromStatus} → ${STATUS_LABEL[ev.toStatus] || ev.toStatus}` : { detected: `Detected with score ${ev.score}`, rescored: ev.note, note: 'Note', alerted: 'Alert sent', not_seen: 'Not seen in a complete scan', seen_again: 'Seen again' }[ev.kind]}
                      <span className="text-slate-400"> · {ev.actor || 'system'} · {formatTime(ev.createdAt)}</span>
                    </div>
                    {ev.note && ev.kind !== 'rescored' && <div className="text-slate-400 break-words">{ev.note}</div>}
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
