import { Fragment, useCallback, useEffect, useState } from 'react';
import { Activity, KeyRound, Building2, Database, FlaskConical, LayoutDashboard, ListChecks, LogOut, Plus, ShieldCheck, Users } from 'lucide-react';
import { api } from './api.js';
import Login from './Login.jsx';
import BrandSettings from './pages/BrandSettings.jsx';
import Findings from './pages/Findings.jsx';
import Overview from './pages/Overview.jsx';
import Scans from './pages/Scans.jsx';
import Sources from './pages/Sources.jsx';
import Tools from './pages/Tools.jsx';
import UsersPage from './pages/Users.jsx';
import AccountPage from './pages/Account.jsx';
import { ErrorBanner, ModeBadge, Spinner, secondary } from './ui.jsx';

const PAGES = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'findings', label: 'Findings', icon: ListChecks },
  { id: 'scans', label: 'Scan history', icon: Activity },
  { id: 'sources', label: 'Source health', icon: Database },
  { id: 'brand', label: 'Brand profile', icon: Building2 },
  { id: 'tools', label: 'Model & tools', icon: FlaskConical },
  { id: 'users', label: 'Users', icon: Users, role: 'admin' },
  { id: 'account', label: 'My account', icon: KeyRound },
];

const readHash = () => {
  const [page, brandId] = window.location.hash.replace('#', '').split('/');
  return { page: PAGES.some((p) => p.id === page) || page === 'new' ? page : 'overview', brandId: Number(brandId) || null };
};

export default function App() {
  const [user, setUser] = useState(undefined);
  const [brands, setBrands] = useState(null);
  const [route, setRoute] = useState(readHash);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/auth/me').then((data) => setUser(data.user)).catch(() => setUser(null));
    const onHash = () => setRoute(readHash());
    const onSignedOut = () => setUser(null);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('sg:signed-out', onSignedOut);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('sg:signed-out', onSignedOut); };
  }, []);

  const loadBrands = useCallback(async () => {
    try {
      setBrands(await api('/brands'));
      setError(null);
    } catch (err) {
      if (err.status === 401) setUser(null);
      else setError(err);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    api('/brands').then(setBrands, (err) => (err.status === 401 ? setUser(null) : setError(err)));
  }, [user]);

  const go = (page, brandId = route.brandId) => { window.location.hash = `${page}${brandId ? `/${brandId}` : ''}`; };

  if (user === undefined) return <div className="p-8"><Spinner label="Loading" /></div>;
  if (!user) return <Login onSignedIn={setUser} />;

  const brand = brands?.find((b) => b.id === route.brandId) || brands?.[0] || null;
  const canEdit = user.role !== 'viewer';

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  async function addDemo() {
    try {
      const demo = await api('/brands/demo', { method: 'POST' });
      await loadBrands();
      go('overview', demo.id);
    } catch (err) { setError(err); }
  }

  const page = route.page === 'new' ? 'new' : route.page;
  const props = { brand, user, canEdit, onChanged: loadBrands, go };

  return (
    <div className="min-h-screen lg:flex">
      <aside className="lg:w-64 lg:min-h-screen border-b lg:border-b-0 lg:border-r border-slate-800 bg-slate-950/80 p-4 space-y-4">
        <div className="flex items-center gap-2 font-extrabold text-white"><ShieldCheck className="text-indigo-400" size={20} /> SignalGuard</div>
        <div>
          <label htmlFor="brand-select" className="text-[11px] uppercase tracking-wide text-slate-400">Brand</label>
          {brands === null ? <Spinner /> : brands.length ? (
            <select id="brand-select" className="mt-1 w-full px-2 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm" value={brand?.id || ''}
              onChange={(e) => go(route.page === 'new' ? 'overview' : route.page, Number(e.target.value))}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name} {b.mode === 'demo' ? '(demo data)' : '(live)'}</option>)}
            </select>
          ) : <p className="text-xs text-slate-400 mt-1">No brands yet.</p>}
          {brand && <div className="mt-2"><ModeBadge mode={brand.mode} /></div>}
          {canEdit && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={`${secondary} text-xs px-2 py-1`} onClick={() => go('new', null)}><Plus size={12} /> Live brand</button>
              {!brands?.some((b) => b.mode === 'demo') && <button type="button" className={`${secondary} text-xs px-2 py-1`} onClick={addDemo}>Add demo brand</button>}
            </div>
          )}
        </div>
        <nav className="flex lg:flex-col gap-1 overflow-x-auto" aria-label="Sections">
          {PAGES.filter((p) => !p.role || p.role === user.role).map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${id}${brand ? `/${brand.id}` : ''}`} aria-current={page === id ? 'page' : undefined}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap ${page === id ? 'bg-indigo-950/70 text-white border border-indigo-800/60' : 'text-slate-400 hover:text-white'}`}>
              <Icon size={15} /> {label}
            </a>
          ))}
        </nav>
        <div className="text-xs text-slate-400 flex items-center justify-between">
          <span className="truncate" title={user.email}>{user.email} · {user.role}</span>
          <button type="button" onClick={signOut} className="p-1 hover:text-white" aria-label="Sign out"><LogOut size={14} /></button>
        </div>
      </aside>
      <main className="flex-1 p-4 lg:p-8 space-y-4 min-w-0">
        <ErrorBanner error={error} onRetry={loadBrands} />
        {page === 'new' && <BrandSettings {...props} brand={null} />}
        {page !== 'new' && !brand && brands && page !== 'sources' && page !== 'users' && (
          <div className="max-w-xl space-y-2 text-slate-300">
            <h1 className="text-xl font-bold text-white">Start monitoring a brand</h1>
            <p className="text-sm">Add a live brand to search real platforms, or add the fictional demo brand to explore the workflow with labelled data. The two never mix.</p>
          </div>
        )}
        <Fragment key={brand?.id ?? 'none'}>
        {page === 'overview' && brand && <Overview {...props} />}
        {page === 'findings' && brand && <Findings key={brand.id} {...props} />}
        {page === 'scans' && brand && <Scans {...props} />}
        {page === 'brand' && brand && <BrandSettings {...props} />}
        {page === 'tools' && brand && <Tools {...props} />}
        </Fragment>
        {page === 'sources' && <Sources {...props} />}
        {page === 'users' && user.role === 'admin' && <UsersPage />}
        {page === 'users' && user.role !== 'admin' && <p className="text-sm text-slate-300">User administration needs the admin role.</p>}
        {page === 'account' && <AccountPage />}
      </main>
    </div>
  );
}
