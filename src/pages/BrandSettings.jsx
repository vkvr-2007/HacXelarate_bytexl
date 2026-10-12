import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { ErrorBanner, Pill, card, input, primary, secondary } from '../ui.jsx';

const PLATFORMS = ['Instagram', 'X', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'Bluesky', 'Mastodon', 'Telegram', 'Threads', 'Reddit'];
const INTERVALS = [[null, 'Manual only'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Daily'], [10080, 'Weekly']];
const EMPTY = { name: '', domain: '', domains: [], description: '', logoUrl: '', aliases: [], keywords: [], officialSocials: [], officialApps: [], sources: null, scanIntervalMinutes: null };
const TRUST = {
  confirmed: ['Confirmed', 'text-emerald-300 border-emerald-800', 'A person confirmed this asset. It is hidden from results.'],
  unverified: ['Unverified', 'text-amber-300 border-amber-800', 'Typed in, not checked. It is NOT hidden from results.'],
  suggested: ['Suggested', 'text-sky-300 border-sky-800', 'Guessed from store search. It is NOT hidden from results until you confirm it.'],
  new: ['Not saved yet', 'text-slate-300 border-slate-700', 'Save the profile first.'],
};
const socialKey = (a) => `${String(a.platform).toLowerCase()}:${String(a.handle).trim().replace(/^@/, '').toLowerCase()}`;
const appKey = (a) => `${a.store}:${String(a.appId).trim().toLowerCase()}`;
const split = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

function fromBrand(brand) {
  if (!brand) return EMPTY;
  const { name, domain, domains, description, logoUrl, aliases, keywords, officialSocials, officialApps, sources, scanIntervalMinutes } = brand;
  return { name, domain, domains, description, logoUrl, aliases, keywords, officialSocials, officialApps, sources, scanIntervalMinutes };
}

export default function BrandSettings({ brand, canEdit, onChanged, go, user }) {
  const [form, setForm] = useState(() => fromBrand(brand));
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState('');
  const [verification, setVerification] = useState(brand?.verification || null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null); // { kind, item, evidence }
  const [challenge, setChallenge] = useState(null);
  const readOnly = !canEdit || brand?.mode === 'demo';

  const sources = useApi(() => api('/sources'), []);
  const { data: system } = useApi(() => api('/system'), []);
  const catalog = (sources.data?.sources || []).filter((s) => s.mode === 'live');

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const listField = (key, index, field, value) => set(key, form[key].map((item, i) => (i === index ? { ...item, [field]: value } : item)));

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved('');
    try {
      const result = brand ? await api(`/brands/${brand.id}`, { method: 'PUT', body: form }) : await api('/brands', { method: 'POST', body: form });
      setVerification(result.validation);
      await onChanged();
      setSaved(result.validation?.unavailable ? 'Saved, but the profile could not be checked right now.' : 'Saved.');
      if (!brand) go('overview', result.id);
    } catch (err) {
      if (err.data?.validation) setVerification(err.data.validation);
      setError(err);
    } finally { setBusy(false); }
  }

  async function suggest() {
    setBusy(true);
    setError(null);
    try {
      const s = await api('/brands/suggest', { method: 'POST', body: { name: form.name } });
      setForm((f) => ({
        ...f,
        officialApps: f.officialApps.length ? f.officialApps : s.officialApps.map(({ iconUrl, ...rest }) => rest),
        officialSocials: f.officialSocials.length ? f.officialSocials : s.officialSocials,
        logoUrl: f.logoUrl || s.logoUrl || '',
      }));
      setSaved(`Found ${s.officialApps.length} apps and ${s.officialSocials.length} accounts. They are marked Suggested: guesses from store search that stay in your results until you confirm each one.`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true);
    try { setVerification(await api(`/brands/${brand.id}/verify`, { method: 'POST' })); } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete ${brand.name} and all of its findings and scans? This cannot be undone.`)) return;
    try { await api(`/brands/${brand.id}`, { method: 'DELETE' }); await onChanged(); go('overview', null); } catch (err) { setError(err); }
  }

  const trustOf = (kind, item) => {
    const saved = (kind === 'social' ? brand?.officialSocials : brand?.officialApps)?.find((x) => (kind === 'social' ? socialKey(x) === socialKey(item) : appKey(x) === appKey(item)));
    return saved ? saved.trust : 'new';
  };

  async function setTrust(kind, item, trust, evidence = '') {
    setBusy(true);
    setError(null);
    try {
      const ref = kind === 'social' ? { platform: item.platform, handle: item.handle } : { store: item.store, appId: item.appId };
      await api(`/brands/${brand.id}/assets/trust`, { method: 'POST', body: { kind, ...ref, trust, evidence } });
      setConfirming(null);
      await onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function startChallenge(domain) {
    setBusy(true);
    setError(null);
    try { setChallenge({ domain, ...(await api(`/brands/${brand.id}/domains/${domain}/challenge`, { method: 'POST' })) }); } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function checkDomain(domain) {
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/brands/${brand.id}/domains/${domain}/verify`, { method: 'POST' });
      setSaved(`${domain}: ${result.detail}`);
      setChallenge(null);
      await onChanged();
    } catch (err) { setError(err.data?.detail ? new Error(`${domain}: ${err.data.detail}`) : err); } finally { setBusy(false); }
  }

  const TrustControls = ({ kind, item }) => {
    const trust = trustOf(kind, item);
    const [label, tone, hint] = TRUST[trust] || TRUST.unverified;
    const canAct = !readOnly && brand && trust !== 'new';
    return (
      <span className="flex items-center gap-2">
        <Pill tone={tone} title={hint}>{label}</Pill>
        {canAct && trust !== 'confirmed' && <button type="button" className="text-xs text-indigo-300 underline" onClick={() => setConfirming({ kind, item, evidence: '' })}>Confirm</button>}
        {canAct && trust === 'confirmed' && <button type="button" className="text-xs text-slate-400 underline" onClick={() => setTrust(kind, item, 'unverified')}>Withdraw</button>}
      </span>
    );
  };

  const enabled = (key) => form.sources === null || form.sources.includes(key);
  const toggleSource = (key) => {
    const all = catalog.map((s) => s.key);
    const current = form.sources ?? all;
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    set('sources', next.length === all.length ? null : next);
  };

  return (
    <form onSubmit={save} className="space-y-4 max-w-4xl" aria-label="Brand profile">
      <h1 className="text-2xl font-bold text-white">{brand ? `${brand.name} profile` : 'New live brand'}</h1>
      {brand?.mode === 'demo' && <p className="text-sm text-amber-200">The demo brand's profile is fixed so its labelled results stay measurable.</p>}
      <ErrorBanner error={error} />
      {saved && <p className="text-sm text-emerald-300" role="status">{saved}</p>}
      <fieldset disabled={readOnly || busy} className={`${card} grid md:grid-cols-2 gap-3`}>
        <legend className="sr-only">Identity</legend>
        <label className="text-sm text-slate-300">Brand name<input className={`${input} mt-1`} value={form.name} onChange={(e) => set('name', e.target.value)} required minLength={2} /></label>
        <label className="text-sm text-slate-300">Official domain<input className={`${input} mt-1`} value={form.domain} onChange={(e) => set('domain', e.target.value.trim().toLowerCase())} placeholder="brand.com" required /></label>
        <label className="text-sm text-slate-300">Other official domains (comma separated)<input className={`${input} mt-1`} value={form.domains.join(', ')} onChange={(e) => set('domains', split(e.target.value))} /></label>
        <label className="text-sm text-slate-300">Logo URL (https)<input className={`${input} mt-1`} value={form.logoUrl} onChange={(e) => set('logoUrl', e.target.value.trim())} /></label>
        <label className="text-sm text-slate-300">Aliases<input className={`${input} mt-1`} value={form.aliases.join(', ')} onChange={(e) => set('aliases', split(e.target.value))} /></label>
        <label className="text-sm text-slate-300">Keywords<input className={`${input} mt-1`} value={form.keywords.join(', ')} onChange={(e) => set('keywords', split(e.target.value))} /></label>
        <label className="text-sm text-slate-300 md:col-span-2">Description<textarea rows={2} className={`${input} mt-1`} value={form.description} onChange={(e) => set('description', e.target.value)} /></label>
      </fieldset>
      <fieldset disabled={readOnly || busy} className={card}>
        <legend className="text-sm font-bold text-white">Official social accounts</legend>
        <p className="text-xs text-slate-400 mb-2">Only accounts you have <strong>confirmed</strong> are excluded from results. Anything else stays visible so a wrong or attacker-made entry cannot hide a threat.</p>
        {form.officialSocials.map((acct, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <select aria-label="Platform" className={`${input} w-40`} value={acct.platform} onChange={(e) => listField('officialSocials', i, 'platform', e.target.value)}>{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select>
            <input aria-label="Handle" className={input} value={acct.handle} onChange={(e) => listField('officialSocials', i, 'handle', e.target.value)} placeholder="@handle" required />
            {brand && <TrustControls kind="social" item={acct} />}
            <button type="button" aria-label="Remove account" className={secondary} onClick={() => set('officialSocials', form.officialSocials.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" className={secondary} onClick={() => set('officialSocials', [...form.officialSocials, { platform: 'Instagram', handle: '' }])}><Plus size={14} /> Account</button>
      </fieldset>
      <fieldset disabled={readOnly || busy} className={card}>
        <legend className="text-sm font-bold text-white">Official apps</legend>
        <p className="text-xs text-slate-400 mb-2">Apps from a different publisher that look like these are flagged. Only <strong>confirmed</strong> apps (and their publisher) are excluded.</p>
        {form.officialApps.map((app, i) => (
          <div key={i} className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2 items-center">
            <select aria-label="Store" className={input} value={app.store} onChange={(e) => listField('officialApps', i, 'store', e.target.value)}><option>App Store</option><option>Google Play</option></select>
            <input aria-label="App name" className={input} value={app.name} onChange={(e) => listField('officialApps', i, 'name', e.target.value)} placeholder="App name" />
            <input aria-label="App id" className={input} value={app.appId} onChange={(e) => listField('officialApps', i, 'appId', e.target.value)} placeholder="id123… or com.brand.app" required />
            <input aria-label="Publisher" className={input} value={app.publisher} onChange={(e) => listField('officialApps', i, 'publisher', e.target.value)} placeholder="Publisher" />
            <button type="button" aria-label="Remove app" className={secondary} onClick={() => set('officialApps', form.officialApps.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
            {brand && <div className="col-span-2 md:col-span-5"><TrustControls kind="app" item={app} /></div>}
          </div>
        ))}
        <div className="flex gap-2">
          <button type="button" className={secondary} onClick={() => set('officialApps', [...form.officialApps, { store: 'Google Play', name: '', appId: '', publisher: '' }])}><Plus size={14} /> App</button>
          <button type="button" className={secondary} disabled={form.name.length < 2} onClick={suggest}>Suggest from app stores</button>
        </div>
      </fieldset>
      {confirming && (
        <section className={card} role="group" aria-label="Confirm asset">
          <h2 className="text-sm font-bold text-white">Confirm {confirming.kind === 'social' ? confirming.item.handle : confirming.item.appId}</h2>
          <p className="text-xs text-slate-400 mb-2">Platforms offer no ownership proof, so this is your decision and it is recorded with your name. How did you check it?</p>
          <input aria-label="How you confirmed it" className={input} value={confirming.evidence} maxLength={500} placeholder="e.g. Linked from the footer of the company website" onChange={(e) => setConfirming({ ...confirming, evidence: e.target.value })} />
          <div className="mt-2 flex gap-2">
            <button type="button" className={primary} disabled={busy || confirming.evidence.trim().length < 8} onClick={() => setTrust(confirming.kind, confirming.item, 'confirmed', confirming.evidence.trim())}>Confirm asset</button>
            <button type="button" className={secondary} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </section>
      )}
      {brand && brand.mode !== 'demo' && brand.officialDomains && (
        <section className={card} aria-label="Domain ownership">
          <h2 className="text-sm font-bold text-white">Domain ownership</h2>
          <p className="text-xs text-slate-400 mb-2">A domain hides its own pages from results only after you prove you control it, with a DNS TXT record or a file on the site.</p>
          {brand.officialDomains.map((d) => (
            <div key={d.domain} className="flex flex-wrap items-center gap-2 mb-1 text-sm text-slate-200">
              <span className="font-mono">{d.domain}</span>
              <Pill tone={d.trust === 'confirmed' ? TRUST.confirmed[1] : TRUST.unverified[1]}>{d.trust === 'confirmed' ? `Proven (${d.method === 'dns_txt' ? 'DNS' : 'file'})` : 'Not proven'}</Pill>
              {!readOnly && d.trust !== 'confirmed' && <button type="button" className={secondary} disabled={busy} onClick={() => startChallenge(d.domain)}>Prove ownership</button>}
            </div>
          ))}
          {challenge && (
            <div className="mt-2 text-xs text-slate-300 space-y-1" role="status">
              <p>For <strong>{challenge.domain}</strong>, add one of these, then check:</p>
              <p>DNS TXT record <code className="font-mono">{challenge.dnsTxt.name}</code> = <code className="font-mono break-all">{challenge.dnsTxt.value}</code></p>
              <p>or a file at <code className="font-mono break-all">{challenge.file.url}</code> containing <code className="font-mono break-all">{challenge.file.contents}</code></p>
              <button type="button" className={primary} disabled={busy} onClick={() => checkDomain(challenge.domain)}>Check now</button>
            </div>
          )}
        </section>
      )}
      {brand?.mode !== 'demo' && (
        <fieldset disabled={readOnly || busy} className={card}>
          <legend className="text-sm font-bold text-white">Monitoring</legend>
          <label className="text-sm text-slate-300 block mb-3">Automatic rescans
            <select className={`${input} mt-1 max-w-xs`} value={form.scanIntervalMinutes ?? ''} onChange={(e) => set('scanIntervalMinutes', e.target.value ? Number(e.target.value) : null)}>
              {INTERVALS.map(([v, label]) => <option key={label} value={v ?? ''}>{label}</option>)}
            </select>
            {system?.scheduler.cadenceMinutes > 0 && form.scanIntervalMinutes && form.scanIntervalMinutes < system.scheduler.cadenceMinutes && (
              <span className="block mt-1 text-xs text-amber-300">On this deployment the scheduler runs about every {Math.round(system.scheduler.cadenceMinutes / 60)} h, so scans will not happen more often than that.</span>
            )}
          </label>
          <p className="text-sm text-slate-300 mb-1">Sources</p>
          {form.sources?.length === 0 && <p className="text-xs text-amber-300 mb-1" role="alert">Every source is off, so this brand will not be scanned until you turn one on.</p>}
          <div className="grid md:grid-cols-3 gap-1">
            {catalog.map((s) => (
              <label key={s.key} className={`text-sm flex items-center gap-2 ${s.support === 'unsupported' ? 'text-slate-600' : 'text-slate-300'}`}>
                <input type="checkbox" checked={enabled(s.key)} onChange={() => toggleSource(s.key)} disabled={s.support === 'unsupported'} />
                {s.label}{!s.configured && s.support !== 'unsupported' && <span className="text-[11px] text-amber-300">needs key</span>}{s.support === 'unsupported' && <span className="text-[11px]">unsupported</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button className={primary} disabled={busy}>{brand ? 'Save profile' : 'Create brand'}</button>
          {brand && <button type="button" className={secondary} disabled={busy} onClick={verify}>Verify official assets</button>}
          {brand && user.role === 'admin' && <button type="button" className={`${secondary} text-rose-300`} onClick={remove}><Trash2 size={14} /> Delete brand</button>}
        </div>
      )}
      {verification && (
        <section className={card} aria-label="Verification">
          <h2 className="text-sm font-bold text-white">{verification.valid ? 'Profile checks passed' : `${verification.errors.length} problems to fix`}</h2>
          {verification.errors.map((x) => <p key={x.field + x.message} className="text-xs text-rose-300">✕ {x.message}</p>)}
          {verification.warnings.map((x) => <p key={x.field + x.message} className="text-xs text-amber-300">! {x.message}</p>)}
          {verification.checks.map((x) => <p key={x.field} className="text-xs text-slate-300">{x.status === 'verified' ? '✓' : x.status === 'not_found' ? '✕' : '?'} {x.appId}: {x.message}</p>)}
        </section>
      )}
    </form>
  );
}
