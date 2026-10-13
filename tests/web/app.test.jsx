// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import App from '../../src/App.jsx';

const LIVE = { id: 1, name: 'Acme Pay', mode: 'live', domain: 'acmepay.com', domains: [], aliases: [], keywords: [], officialSocials: [], officialApps: [], sources: null, scanIntervalMinutes: 1440, nextScanAt: null, description: '', logoUrl: '' };
const DEMO = { ...LIVE, id: 2, name: 'Northstar', mode: 'demo', scanIntervalMinutes: null };
const FINDING = {
  id: 7, brandId: 1, mode: 'live', type: 'social', platform: 'Bluesky', name: 'Acme Pay Support', handle: '@acmepay-help.bsky.social', score: 91, severity: 'Critical',
  status: 'new', category: 'Customer support scam', reasons: ['Name is a look-alike of the brand', 'Bio asks for account details'], factors: [], probability: 0.91,
  url: 'https://bsky.app/profile/acmepay-help.bsky.social', evidence: { source: 'bluesky', query: 'Acme Pay support', collectedAt: '2026-10-12T08:00:00Z', scoredAt: '2026-10-12T08:00:01Z', modelVersion: 'm1' },
  firstSeenAt: '2026-10-12T08:00:00Z', lastSeenAt: '2026-10-12T08:00:00Z', source: 'bluesky',
};
const SUMMARY = (brand) => ({ brand, byStatus: { new: 1 }, bySeverity: { Critical: 1 }, byType: { social: 1 }, byPlatform: [{ platform: 'Bluesky', count: 1 }], lastScan: null });

let routes;
let calls;
const json = (status, body) => Promise.resolve(new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  calls = [];
  window.location.hash = '';
  routes = {
    'GET /api/auth/me': () => json(200, { user: { id: 1, email: 'analyst@example.com', role: 'analyst' } }),
    'GET /api/brands': () => json(200, [LIVE, DEMO]),
    'GET /api/brands/1/summary': () => json(200, SUMMARY(LIVE)),
    'GET /api/brands/2/summary': () => json(200, SUMMARY(DEMO)),
    'GET /api/findings': () => json(200, { total: 1, items: [FINDING] }),
    'GET /api/findings/7': () => json(200, { ...FINDING, events: [{ id: 1, kind: 'detected', score: 91, createdAt: '2026-10-12T08:00:00Z' }] }),
    'PATCH /api/findings/7': () => json(200, { ...FINDING, status: 'confirmed' }),
    'GET /api/system': () => json(200, { worker: { active: true, kind: 'worker', lastSeenAt: '2026-10-12T08:00:00Z' }, scheduler: { cadenceMinutes: 0, kind: 'worker', canRunOnDemand: false }, alerts: { configured: true } }),
    'GET /api/alerts': () => json(200, []),
    'GET /api/sources': () => json(200, { sources: [
      { key: 'tiktok', label: 'TikTok', category: 'social', mode: 'live', support: 'unsupported', configured: false, missing: [], access: 'Research API is academic only.', docs: 'https://developers.tiktok.com' },
      { key: 'x', label: 'X (Twitter)', category: 'social', mode: 'live', support: 'paid', configured: false, missing: ['X_BEARER_TOKEN'], access: 'Bearer token', cost: 'Paid', docs: 'https://docs.x.com' },
      { key: 'bluesky', label: 'Bluesky', category: 'social', mode: 'live', support: 'supported', configured: true, missing: [], access: 'Public', lastStatus: 'rate_limited', consecutiveFailures: 3, docs: 'https://docs.bsky.app' },
    ] }),
  };
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    const key = `${options.method || 'GET'} ${path}`;
    calls.push({ key, url, body: options.body && JSON.parse(options.body) });
    return (routes[key] || (() => json(404, { error: `no route ${key}` })))();
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('dashboard', () => {
  it('shows the sign-in form when there is no session and signs in', async () => {
    let signedIn = false;
    routes['GET /api/auth/me'] = () => (signedIn ? json(200, { user: { id: 1, email: 'a@example.com', role: 'viewer' } }) : json(401, { error: 'Sign in to continue.' }));
    routes['POST /api/auth/login'] = () => { signedIn = true; return json(200, { user: { id: 1, email: 'a@example.com', role: 'viewer' } }); };
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Acme Pay/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Scan now/ })).not.toBeInTheDocument(); // viewers cannot scan
  });

  it('shows a sign-in error from the API', async () => {
    routes['GET /api/auth/me'] = () => json(401, { error: 'Sign in to continue.' });
    routes['POST /api/auth/login'] = () => json(401, { error: 'Email or password is incorrect.' });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
  });

  it('labels live and demo brands and explains demo data', async () => {
    window.location.hash = '#overview/2';
    render(<App />);
    expect(await screen.findByText(/Northstar is a fictional brand/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Acme Pay (live)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Northstar (demo data)' })).toBeInTheDocument();
  });

  it('queues a scan and asks the server to run it', async () => {
    routes['POST /api/brands/1/scans'] = () => json(202, { id: 9, status: 'queued', mode: 'live' });
    routes['POST /api/scans/9/run'] = () => json(202, { queued: true });
    routes['GET /api/scans/9'] = () => json(200, { id: 9, status: 'running' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan now/ }));
    expect(await screen.findByRole('button', { name: /Scanning/ })).toBeDisabled();
    await waitFor(() => expect(calls.map((c) => c.key)).toContain('POST /api/scans/9/run'));
  });

  it('opens a finding, shows evidence and records a review decision with a note', async () => {
    window.location.hash = '#findings/1';
    render(<App />);
    fireEvent.click(await screen.findByText('Acme Pay Support'));
    const dialog = await screen.findByRole('dialog', { name: 'Finding detail' });
    expect(await within(dialog).findByText('Bio asks for account details')).toBeInTheDocument();
    expect(within(dialog).getByText('Acme Pay support')).toBeInTheDocument(); // the search query that found it
    expect(within(dialog).getByText(/risk estimate, not proof/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Asks for card number' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm impersonation' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'PATCH /api/findings/7')?.body).toEqual({ status: 'confirmed', note: 'Asks for card number' }));
  });

  it('sends filters to the API', async () => {
    window.location.hash = '#findings/1';
    render(<App />);
    await screen.findByText('Acme Pay Support');
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'Critical' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'app' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('severity=Critical') && c.url.includes('type=app'))).toBe(true));
  });

  it('shows unsupported, unconfigured and failing sources honestly', async () => {
    window.location.hash = '#sources/1';
    render(<App />);
    const tiktok = await screen.findByRole('article', { name: 'TikTok' });
    expect(within(tiktok).getByText('Not supported')).toBeInTheDocument();
    const x = screen.getByRole('article', { name: 'X (Twitter)' });
    expect(within(x).getByText('X_BEARER_TOKEN')).toBeInTheDocument();
    expect(within(x).getByText('Paid API')).toBeInTheDocument();
    const bluesky = screen.getByRole('article', { name: 'Bluesky' });
    expect(within(bluesky).getByText('Rate limited')).toBeInTheDocument();
    expect(within(bluesky).getByText('3 failures in a row')).toBeInTheDocument();
  });

  it('shows an error when the API is unreachable', async () => {
    routes['GET /api/brands'] = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the OmniScout API');
  });

  it('shows field errors from brand validation', async () => {
    window.location.hash = '#new';
    routes['POST /api/brands'] = () => json(400, { error: 'Enter a valid domain such as brand.com', issues: [{ path: 'domain', message: 'Enter a valid domain such as brand.com' }] });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Brand name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Official domain'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create brand' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid domain');
  });

  it('returns to the sign-in screen when any call finds the session has ended', async () => {
    window.location.hash = '#findings/1';
    render(<App />);
    await screen.findByText('Acme Pay Support');
    routes['GET /api/findings'] = () => json(401, { error: 'Sign in to continue.' });
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'High' } });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('lets a user change their password and says other sessions were signed out', async () => {
    window.location.hash = '#account/1';
    routes['POST /api/auth/password'] = () => json(204, null);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'old-password-123' } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'new-password-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('other sessions were signed out');
    expect(calls.find((c) => c.key === 'POST /api/auth/password').body).toEqual({ currentPassword: 'old-password-123', newPassword: 'new-password-1234' });
  });

  it('shows the admin user list with disable and reset actions, and tells non-admins they need the role', async () => {
    window.location.hash = '#users/1';
    routes['GET /api/auth/me'] = () => json(200, { user: { id: 1, email: 'admin@example.com', role: 'admin' } });
    routes['GET /api/users'] = () => json(200, [{ id: 2, email: 'viewer@example.com', role: 'viewer', disabled_at: null, last_login_at: null }]);
    routes['GET /api/audit'] = () => json(200, [{ id: 1, kind: 'login_failed', target: 'viewer@example.com', created_at: '2026-10-12T08:00:00Z' }]);
    routes['PATCH /api/users/2'] = () => json(200, {});
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'PATCH /api/users/2')?.body).toEqual({ disabled: true }));
    expect(await screen.findByText('login_failed')).toBeInTheDocument();
    cleanup();
    routes['GET /api/auth/me'] = () => json(200, { user: { id: 3, email: 'v@example.com', role: 'viewer' } });
    render(<App />);
    expect(await screen.findByText(/needs the admin role/)).toBeInTheDocument();
  });

  it('pages through findings 50 at a time and resets to the first page when a filter changes', async () => {
    window.location.hash = '#findings/1';
    const item = (id) => ({ ...FINDING, id, name: `Candidate ${id}` });
    routes['GET /api/findings'] = () => {
      const offset = Number(new URL(calls.at(-1).url, 'http://x').searchParams.get('offset'));
      return json(200, { total: 120, items: Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => item(offset + i + 1)) });
    };
    render(<App />);
    expect(await screen.findByText(/Showing 1–50 of 120/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Showing 51–100 of 120/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Showing 101–120 of 120/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(calls.filter((c) => c.key === 'GET /api/findings').map((c) => new URL(c.url, 'http://x').searchParams.get('offset'))).toEqual(expect.arrayContaining(['0', '50', '100']));
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'High' } });
    expect(await screen.findByText(/Showing 1–50 of 120/)).toBeInTheDocument();
  });

  it('flags findings that a complete scan no longer returned, and shows what each scan saw', async () => {
    window.location.hash = '#findings/1';
    routes['GET /api/findings'] = () => json(200, { total: 1, items: [{ ...FINDING, missedScans: 2 }] });
    routes['GET /api/findings/7'] = () => json(200, { ...FINDING, missedScans: 2, evidence: { ...FINDING.evidence, declaredAsset: 'Matches declared account @acmepay, which is unverified' }, events: [] });
    routes['GET /api/findings/7/observations'] = () => json(200, [{ id: 1, scanId: 12, observedAt: '2026-10-12T08:00:00Z', score: 91, source: 'bluesky', reasons: ['Name is a look-alike of the brand'] }]);
    render(<App />);
    expect(await screen.findByText('Not seen in last 2 scans')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Acme Pay Support'));
    const history = await screen.findByRole('region', { name: 'Scan history' });
    expect(within(history).getByText('#12')).toBeInTheDocument();
    expect(screen.getByText(/Matches declared account @acmepay, which is unverified/)).toBeInTheDocument();
    expect(screen.getByText(/Its status was not changed/)).toBeInTheDocument();
  });

  describe('brand profile trust', () => {
    const PROFILE = {
      ...LIVE,
      officialSocials: [{ platform: 'X', handle: '@acmepay', trust: 'unverified' }, { platform: 'Bluesky', handle: '@acmepay.bsky.social', trust: 'suggested' }],
      officialApps: [{ store: 'Google Play', name: 'Acme Pay', appId: 'com.acmepay.app', publisher: 'Acme Pay Inc.', trust: 'confirmed' }],
      officialDomains: [{ domain: 'acmepay.com', primary: true, trust: 'unverified', method: null }],
    };
    beforeEach(() => {
      window.location.hash = '#brand/1';
      routes['GET /api/brands'] = () => json(200, [PROFILE, DEMO]);
    });

    it('labels each asset and says only confirmed ones are hidden from results', async () => {
      render(<App />);
      const group = await screen.findByRole('group', { name: /Official social accounts/ });
      expect(within(group).getByText('Unverified')).toBeInTheDocument();
      expect(within(group).getByText('Suggested')).toBeInTheDocument();
      expect(within(group).getByText(/Only accounts you have/)).toHaveTextContent('confirmed');
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
    });

    it('confirms an account only after the analyst says how they checked it', async () => {
      routes['POST /api/brands/1/assets/trust'] = () => json(200, PROFILE);
      render(<App />);
      const group = await screen.findByRole('group', { name: /Official social accounts/ });
      fireEvent.click(within(group).getAllByRole('button', { name: 'Confirm' })[0]);
      const confirm = await screen.findByRole('group', { name: 'Confirm asset' });
      const submit = within(confirm).getByRole('button', { name: 'Confirm asset' });
      expect(submit).toBeDisabled();
      fireEvent.change(within(confirm).getByLabelText('How you confirmed it'), { target: { value: 'Linked from the website footer' } });
      fireEvent.click(submit);
      await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/brands/1/assets/trust')?.body).toEqual({
        kind: 'social', platform: 'X', handle: '@acmepay', trust: 'confirmed', evidence: 'Linked from the website footer',
      }));
    });

    it('walks through domain proof: shows the DNS and file options, then checks', async () => {
      routes['POST /api/brands/1/domains/acmepay.com/challenge'] = () => json(200, {
        domain: 'acmepay.com', dnsTxt: { name: '_signalguard.acmepay.com', value: 'signalguard-verify=abc' }, file: { url: 'https://acmepay.com/.well-known/signalguard-verify.txt', contents: 'abc' },
      });
      routes['POST /api/brands/1/domains/acmepay.com/verify'] = () => json(422, { error: 'x', detail: 'Not proven: no TXT record.' });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Prove ownership' }));
      expect(await screen.findByText('signalguard-verify=abc')).toBeInTheDocument();
      expect(screen.getByText('https://acmepay.com/.well-known/signalguard-verify.txt')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('acmepay.com: Not proven: no TXT record.');
    });

    it('shows the problems when the profile fails validation and nothing is saved', async () => {
      routes['PUT /api/brands/1'] = () => json(422, { error: 'Fix these problems before saving the profile.', validation: { valid: false, errors: [{ field: 'officialApps[0]', message: 'Not a valid package name' }], warnings: [], checks: [] } });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Save profile' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Fix these problems');
      expect(screen.getByText(/Not a valid package name/)).toBeInTheDocument();
    });

    it('warns that turning every source off means no scans', async () => {
      routes['GET /api/brands'] = () => json(200, [{ ...PROFILE, sources: [] }, DEMO]);
      render(<App />);
      expect(await screen.findByText(/Every source is off/)).toBeInTheDocument();
    });
  });

  describe('live monitoring honesty', () => {
    const queued = (minutesAgo) => ({ id: 30, brandId: 1, mode: 'live', status: 'queued', trigger: 'manual', attempts: 0, queuedAt: new Date(Date.now() - minutesAgo * 60000).toISOString() });

    it('says a queued scan is waiting for a worker when none has checked in', async () => {
      routes['GET /api/brands/1/summary'] = () => json(200, { ...SUMMARY(LIVE), lastScan: queued(7) });
      routes['GET /api/system'] = () => json(200, { worker: { active: false, kind: null, lastSeenAt: null }, scheduler: { cadenceMinutes: 0, kind: 'worker', canRunOnDemand: false }, alerts: { configured: false } });
      render(<App />);
      const notice = await screen.findByText(/Waiting for a worker/);
      expect(notice).toHaveTextContent('queued for 7 min');
      expect(notice).toHaveTextContent('npm run worker');
    });

    it('stays quiet when a worker is alive', async () => {
      routes['GET /api/brands/1/summary'] = () => json(200, { ...SUMMARY(LIVE), lastScan: queued(7) });
      render(<App />);
      await screen.findByText(/Scan queued/);
      expect(screen.queryByText(/Waiting for a worker/)).not.toBeInTheDocument();
    });

    it('warns when the scheduler is slower than the chosen rescan interval', async () => {
      window.location.hash = '#brand/1';
      routes['GET /api/system'] = () => json(200, { worker: { active: true, kind: 'cron', lastSeenAt: null }, scheduler: { cadenceMinutes: 1440, kind: 'cron', canRunOnDemand: true }, alerts: { configured: true } });
      routes['GET /api/brands'] = () => json(200, [{ ...LIVE, scanIntervalMinutes: 360 }, DEMO]);
      render(<App />);
      expect(await screen.findByText(/scheduler runs about every 24 h/)).toBeInTheDocument();
    });

    it('shows alert deliveries, why one failed, and lets an analyst retry it', async () => {
      window.location.hash = '#scans/1';
      routes['GET /api/brands/1/scans'] = () => json(200, []);
      routes['GET /api/alerts'] = () => json(200, [{ id: 5, kind: 'findings', ok: false, error: 'Webhook answered HTTP 500', findings: 2, scanId: 12, redelivered: false, createdAt: '2026-10-12T08:00:00Z' }]);
      routes['POST /api/alerts/5/retry'] = () => json(200, { ok: true, error: null });
      render(<App />);
      const section = await screen.findByRole('region', { name: 'Alerts' });
      expect(within(section).getByText('Webhook answered HTTP 500')).toBeInTheDocument();
      fireEvent.click(within(section).getByRole('button', { name: 'Retry' }));
      expect(await within(section).findByText('Alert redelivered.')).toBeInTheDocument();
      expect(calls.some((c) => c.key === 'POST /api/alerts/5/retry')).toBe(true);
      expect(within(section).queryByRole('button', { name: 'Send test alert' })).not.toBeInTheDocument(); // admins only
    });

    it('says plainly when no alert webhook is configured', async () => {
      window.location.hash = '#scans/1';
      routes['GET /api/brands/1/scans'] = () => json(200, []);
      routes['GET /api/system'] = () => json(200, { worker: { active: true, kind: 'worker', lastSeenAt: null }, scheduler: { cadenceMinutes: 0, kind: 'worker', canRunOnDemand: false }, alerts: { configured: false } });
      render(<App />);
      expect(await screen.findByText(/No alert webhook is set/)).toBeInTheDocument();
    });
  });

  it('will not mark a finding official without a written reason', async () => {
    window.location.hash = '#findings/1';
    render(<App />);
    fireEvent.click(await screen.findByText('Acme Pay Support'));
    const official = await screen.findByRole('button', { name: 'Mark official' });
    expect(official).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Seen on site' } });
    expect(official).toBeEnabled();
    expect(screen.getByText(/hides this item from every future scan/)).toBeInTheDocument();
    expect(screen.getByText(/can train the next model once enough of both kinds exist/)).toBeInTheDocument();
  });

  it('says demo decisions never train the model', async () => {
    window.location.hash = '#findings/2';
    routes['GET /api/findings'] = () => json(200, { total: 1, items: [{ ...FINDING, mode: 'demo' }] });
    routes['GET /api/findings/7'] = () => json(200, { ...FINDING, mode: 'demo', events: [] });
    render(<App />);
    fireEvent.click(await screen.findByText('Acme Pay Support'));
    expect(await screen.findByText(/Decisions on demo data never train the model/)).toBeInTheDocument();
  });

  describe('keyboard and screen reader basics', () => {
    // jsdom has no layout, so colour contrast is checked separately in a real browser; everything structural is checked here.
    const violations = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.nodes[0].html.slice(0, 90)}`);

    it.each([['overview', '#overview/1'], ['findings', '#findings/1'], ['scans', '#scans/1'], ['sources', '#sources/1'], ['brand profile', '#brand/1'], ['new brand', '#new/1'], ['account', '#account/1']])('%s page has no structural accessibility violations', async (_name, hash) => {
      window.location.hash = hash;
      routes['GET /api/brands/1/scans'] = () => json(200, [{ id: 3, brandId: 1, mode: 'live', status: 'succeeded', trigger: 'manual', queuedAt: '2026-10-12T08:00:00Z', stats: { detections: 1 }, sources: [{ key: 'bluesky', label: 'Bluesky', status: 'ok', count: 1 }] }]);
      render(<App />);
      await screen.findByRole('heading', { level: 1 });
      await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
      expect(await violations()).toEqual([]);
    });

    it('the finding drawer takes focus, keeps Tab inside, closes with Escape and gives focus back', async () => {
      window.location.hash = '#findings/1';
      render(<App />);
      const opener = await screen.findByRole('button', { name: 'Acme Pay Support' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog', { name: 'Finding detail' });
      await waitFor(() => expect(dialog).toHaveFocus());
      expect(await violations()).toEqual([]);
      const close = within(dialog).getByRole('button', { name: 'Close' });
      const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), textarea')];
      focusable.at(-1).focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(focusable[0]).toHaveFocus(); // wraps forward instead of leaving the drawer
      close.focus();
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(focusable.at(-1)).toHaveFocus(); // and backward
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
    });
  });

  it('lets people open the findings a scan saw from the scan history', async () => {
    window.location.hash = '#scans/1';
    routes['GET /api/brands/1/scans'] = () => json(200, [{ id: 3, brandId: 1, mode: 'live', status: 'succeeded', trigger: 'manual', queuedAt: '2026-10-12T08:00:00Z', stats: { detections: 1 }, sources: [] }]);
    routes['GET /api/scans/3/findings'] = () => json(200, { total: 1, items: [{ id: 7, name: 'Acme Pay Support', handle: '@x', platform: 'Bluesky', status: 'new', score: 91, severity: 'Critical', newInScan: true }] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan #3/ }));
    const summary = await screen.findByText('Findings this scan saw');
    fireEvent.click(summary);
    expect(await screen.findByText('new in this scan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acme Pay Support' }));
    expect(await screen.findByRole('dialog', { name: 'Finding detail' })).toBeInTheDocument();
  });
});
