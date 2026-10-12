import { AlertTriangle, CheckCircle2, CircleSlash, Clock, CloudOff, KeyRound, LoaderCircle, Lock, PauseCircle, Ban } from 'lucide-react';

export const card = 'p-5 rounded-xl bg-slate-900/60 border border-slate-800/80 shadow-xl';
export const input = 'w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/60';
export const button = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed';
export const primary = `${button} bg-indigo-600 hover:bg-indigo-500 text-white`;
export const secondary = `${button} bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700`;

export const SEVERITY_TONE = {
  Critical: 'text-rose-300 bg-rose-950/50 border-rose-800/70',
  High: 'text-amber-300 bg-amber-950/50 border-amber-800/70',
  Medium: 'text-indigo-300 bg-indigo-950/50 border-indigo-800/70',
  Low: 'text-slate-300 bg-slate-900 border-slate-700',
};

export const STATUS_LABEL = {
  new: 'New', reviewing: 'Reviewing', confirmed: 'Confirmed impersonation', false_positive: 'False positive', official: 'Official', resolved: 'Resolved',
};
const STATUS_TONE = {
  new: 'text-rose-300 bg-rose-950/40 border-rose-800/60', reviewing: 'text-amber-300 bg-amber-950/40 border-amber-800/60',
  confirmed: 'text-fuchsia-300 bg-fuchsia-950/40 border-fuchsia-800/60', false_positive: 'text-slate-400 bg-slate-900 border-slate-700',
  official: 'text-emerald-300 bg-emerald-950/40 border-emerald-800/60', resolved: 'text-sky-300 bg-sky-950/40 border-sky-800/60',
};

export const SOURCE_STATUS = {
  ok: { label: 'Working', icon: CheckCircle2, tone: 'text-emerald-300 bg-emerald-950/40 border-emerald-800/60' },
  partial: { label: 'Partial', icon: AlertTriangle, tone: 'text-amber-300 bg-amber-950/40 border-amber-800/60' },
  cached: { label: 'Cached', icon: Clock, tone: 'text-amber-300 bg-amber-950/40 border-amber-800/60' },
  rate_limited: { label: 'Rate limited', icon: PauseCircle, tone: 'text-amber-300 bg-amber-950/40 border-amber-800/60' },
  unavailable: { label: 'Failing', icon: CloudOff, tone: 'text-rose-300 bg-rose-950/40 border-rose-800/60' },
  auth_failed: { label: 'Key rejected', icon: Lock, tone: 'text-rose-300 bg-rose-950/40 border-rose-800/60' },
  not_configured: { label: 'Needs key', icon: KeyRound, tone: 'text-slate-300 bg-slate-900 border-slate-700' },
  unsupported: { label: 'Not supported', icon: Ban, tone: 'text-slate-400 bg-slate-900 border-slate-800' },
  disabled: { label: 'Off', icon: CircleSlash, tone: 'text-slate-400 bg-slate-900 border-slate-800' },
};

export function Pill({ tone, children, title }) {
  return <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border whitespace-nowrap ${tone}`}>{children}</span>;
}

export const SeverityBadge = ({ severity, score }) => <Pill tone={SEVERITY_TONE[severity] || SEVERITY_TONE.Low}>{severity}{score != null && <span className="font-mono">{score}</span>}</Pill>;
export const StatusBadge = ({ status }) => <Pill tone={STATUS_TONE[status] || STATUS_TONE.new}>{STATUS_LABEL[status] || status}</Pill>;

export function SourceStatus({ status }) {
  const meta = SOURCE_STATUS[status] || SOURCE_STATUS.unavailable;
  const Icon = meta.icon;
  return <Pill tone={meta.tone}><Icon size={11} />{meta.label}</Pill>;
}

export const ModeBadge = ({ mode }) => (mode === 'demo'
  ? <Pill tone="text-amber-200 bg-amber-950/60 border-amber-700" title="Fictional, hand-labelled data. Never mixed with live results.">DEMO DATA</Pill>
  : <Pill tone="text-emerald-200 bg-emerald-950/50 border-emerald-800" title="Live sources only">LIVE</Pill>);

export function Spinner({ label }) {
  return <span className="inline-flex items-center gap-2 text-sm text-slate-400"><LoaderCircle size={15} className="animate-spin" />{label}</span>;
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  return (
    <div role="alert" className="p-3 rounded-lg border border-rose-800/70 bg-rose-950/40 text-sm text-rose-200 flex items-center justify-between gap-3">
      <span>{error.message || String(error)}</span>
      {onRetry && <button type="button" onClick={onRetry} className="text-xs underline">Retry</button>}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="p-8 text-center rounded-xl border border-dashed border-slate-800">
      <p className="text-sm font-semibold text-slate-200">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-400">{children}</div>}
    </div>
  );
}

export function timeAgo(value) {
  if (!value) return 'never';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(value).toLocaleDateString();
}

export const formatTime = (value) => (value ? new Date(value).toLocaleString() : '—');
