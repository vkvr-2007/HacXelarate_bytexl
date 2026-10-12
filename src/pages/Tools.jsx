import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { ErrorBanner, card, input, primary } from '../ui.jsx';

const samples = (name) => {
  const n = name || 'Brand';
  const swapped = n.length > 4 ? n.slice(0, 2) + n[3] + n[2] + n.slice(4) : `${n}x`;
  return [n.replace(/o/i, '0'), swapped, `${n} Support`, `Official ${n} Giveaway`, `${n} Fan Club`, 'Morning Brew Coffee'].join('\n');
};

export default function Tools({ brand, user }) {
  const [text, setText] = useState(() => samples(brand.name));
  const [type, setType] = useState('social');
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data: model, error: modelError, reload: reloadModel } = useApi(() => api('/model'), []);

  async function run(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const names = text.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      setResults((await api('/lookalike', { method: 'POST', query: { brandId: brand.id }, body: { names, type } })).results);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function retrain() {
    setBusy(true);
    try { await api('/model/retrain', { method: 'POST' }); reloadModel(); } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const m = model?.metrics;
  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Model and tools</h1>
      <ErrorBanner error={error || modelError} />
      <form onSubmit={run} className={card} aria-label="Look-alike tester">
        <h2 className="text-sm font-bold text-white">Look-alike name tester</h2>
        <p className="text-xs text-slate-400 mb-2">One name per line, scored against {brand.name}. Nothing is searched or saved.</p>
        <textarea aria-label="Names" rows={6} className={`${input} font-mono`} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mt-2 flex gap-2">
          <select aria-label="Treat as" className={`${input} w-44`} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="social">Social account</option><option value="app">App</option><option value="domain">Domain</option>
          </select>
          <button className={primary} disabled={busy}>Score names</button>
        </div>
        {results.length > 0 && (
          <table className="w-full mt-3 text-xs"><tbody className="divide-y divide-slate-800">
            {results.map((r) => (
              <tr key={r.name}><td className="py-1 font-mono text-slate-100">{r.name}</td><td className="text-slate-400">{r.signals.join(', ') || '—'}</td>
                <td className={`text-right font-mono ${r.score >= 55 ? 'text-rose-300' : 'text-emerald-300'}`}>{r.score} {r.severity}</td></tr>
            ))}
          </tbody></table>
        )}
      </form>
      <section className={card} aria-label="Detection model">
        <h2 className="text-sm font-bold text-white">Detection model {model?.version}</h2>
        {m ? (
          <>
            <p className="text-xs text-slate-400">Gradient-boosted ranker over {m.trainRows?.toLocaleString()} synthetic labelled pairs, evaluated on brands it never saw in training ({m.evaluation}). These numbers measure the synthetic benchmark, not real-world accuracy.</p>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center">
              {['precision', 'recall', 'f1', 'rocAuc'].map((k) => <div key={k} className="p-2 rounded bg-slate-950 border border-slate-800"><div className="font-mono text-white">{m[k]?.toFixed(3)}</div><div className="text-[10px] text-slate-400">{k}</div></div>)}
            </div>
            <p className="mt-2 text-xs text-slate-400">Reviewer labels waiting for the next retrain: {model.feedback.threat || 0} confirmed, {model.feedback.notThreat || 0} not threats.</p>
            {user.role === 'admin' && <button type="button" className={`${primary} mt-2`} disabled={busy} onClick={retrain}>Retrain with reviewer labels</button>}
          </>
        ) : <p className="text-xs text-slate-400">Model details unavailable.</p>}
      </section>
    </div>
  );
}
