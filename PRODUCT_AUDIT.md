# SignalGuard product audit (Phase 0)

> **Updates:** rows marked **FIXED (Phase 1 to 5)** below were repaired and have regression tests. See `REPAIR_PROGRESS.md`. Descriptions are kept as audited.

Audited commit `e648ef1` on `ml-detection-engine`. No application code was changed. Labels: **V** verified by running it or by reading the code path, **A** assumption, **U** untested.

## Checks run

| Check | Result |
| --- | --- |
| `npm run check` (eslint, ruff, tsc, mypy, 32 JS tests, 102 Python tests, build) | Done+tested: passes when local Postgres is up. With Postgres down, all 23 API tests fail (expected: they need a real DB). |
| `npm audit` | 2 critical in dev tooling: `shell-quote` 1.8.4 to 1.10.0 via `concurrently` (GHSA-pqg4-j6r4-53mv). Dev-only, not shipped. `--omit=dev`: 0. |
| `pip-audit -r ml/requirements.txt` | 0 known vulnerabilities |
| Live stack probe (API, ML, Vite proxy, Postgres) | see defects |
| Live sources | **Blocked**: sandbox network proxy blocks them. Collector parsing is Mocked only. |

## Defects

### P0 (none confirmed)

No defect found that gives unauthenticated data access or code execution. Closest: P1-1 and P1-2.

### P1

| ID | Defect | Evidence | Impact | Acceptance criteria |
| --- | --- | --- | --- | --- |
| P1-1 | **FIXED (Phase 1): SSRF: connect to the validated IP; webhook posts use the same path.** **SSRF peer check runs after the request is sent.** `safe_http.fetch` validates DNS, then `client.stream()` connects and sends the GET; the peer address is checked only after response headers arrive (`safe_http.py:117-123`). V (code), U (not exploited). | Candidate URLs come from attackers who control DNS, so a rebinding record (public on first lookup, private on second) makes the server send a blind GET to an internal address. Body is discarded, but the request fires. | Connect to the validated IP only (custom transport or resolved-IP connect with Host/SNI preserved). Test: a resolver returning public then private never opens a socket to the private IP. |
| P1-2 | **FIXED (Phase 1): ML secret required in production; fails closed.** **ML service fails open without a secret.** `internal()` returns when `ML_SERVICE_SECRET` is unset (`service.py:55-57`). `/api/ml` is public on Vercel. V | A missing env var in production exposes `/scan`, `/score`, `/retrain`, `/validate` (the last two fetch URLs and run CPU work). | In production (`VERCEL` or `NODE_ENV=production`) the service refuses to start or answers 503 unless the secret is set. Test covers it. |
| P1-3 | **FIXED (Phase 1): pool error handler.** **API process crashes when an idle DB connection drops.** No `pool.on('error')` handler. V: terminating an idle backend made Node exit with "Unhandled 'error' event". | Neon or a network blip kills the local/long-running API. | Handler logs and lets the pool recover. Test terminates a backend and the next request succeeds. |
| P1-4 | **FIXED (Phase 2): suggested / unverified / confirmed states; only confirmed assets and proven domains exclude results; DNS TXT / file domain proof.** **Guessed or suggested assets are saved as official with no state.** "Suggest from app stores" fills official apps/accounts from a publisher-name prefix guess (`service.py suggest_profile`), and `brands.official_*` has no suggested/unverified/confirmed status. Official assets are excluded from all scoring. V (code) | A wrong or attacker-published "official" app is silently whitelisted, which hides the most dangerous result. No domain ownership proof exists either. | Each asset has a status (suggested, unverified, confirmed) and evidence. Only confirmed assets exclude findings. Domain proof (DNS TXT or file) is available. |
| P1-5 | **FIXED (Phase 4): only live decisions with a known origin and reviewer train the model, and only once 10 of each kind exist; demo never.** **Demo reviews can become training labels.** `PATCH /findings/:id` writes `ml_feedback` for any mode, and `train.py` folds every row into training (`findings.js:105-107`, `train.py load_feedback`). V (code) | Synthetic demo decisions and unreviewed analyst clicks become "trusted" labels. | Only live, reviewed findings by role/count rules are eligible; demo never. Test. |

### P2

| ID | Defect | Evidence | Acceptance criteria |
| --- | --- | --- | --- |
| P2-1 | **FIXED (Phase 2): `[]` runs nothing, scan refused with a message; scheduler skips it.** **Disabling every source runs every source.** UI can save `sources: []`; the worker treats `[]` as "all" (`jobs.py:217`). V (code) | `[]` means no scan, with a clear message. |
| P2-2 | **FIXED (Phase 1): account lifecycle (password change, admin reset, disable, role change, last-admin guard); recovery stays Unsupported.** **No account lifecycle.** No self-registration (intended), but also no password change, reset, disable, role change or delete. Account recovery is **Unsupported** (`/api/auth/forgot` is 404). V | Admin can change role, disable, reset password (audited). Document the recovery path. |
| P2-3 | **FIXED (Phase 1): server-side session revocation.** **Sessions are stateless; logout only clears the cookie.** A stolen token works until expiry (12 h). V (code) | Server-side revocation (session id or token version). |
| P2-4 | **FIXED (Phase 1): dev origins and clear error.** **Dev origin footgun.** Vite proxy login returns "Cross-site request refused." when the page is opened by an origin other than `APP_ORIGIN` (verified with `127.0.0.1:5173` vs `localhost:5173`). `web:dev` binds `127.0.0.1` while README says open `localhost:5173`. V | One documented dev URL works out of the box; the error names the expected origin. |
| P2-5 | **FIXED (Phase 1): public health is status only.** **ML `/health` is unauthenticated** and returns metrics plus which provider env vars are missing. V | Public health returns status only. |
| P2-6 | **FIXED (Phase 1): login throttling now in Postgres; general API limiter still per process.** **Rate limits are per process.** In-memory store gives no protection across Vercel instances. A | Shared store (Postgres) or edge limit; documented. |
| P2-7 | **FIXED (Phase 1): global 401 handling.** **Session expiry is handled only on the brands call.** Other pages show an error banner instead of returning to sign-in (`App.jsx:47,54`). V | Any 401 returns to login. |
| P2-8 | **FIXED (Phase 2): 50 per page with Previous/Next.** **Findings list has no pagination UI.** API supports `offset`; the page shows only the first 100 and a total. V | Page controls. |
| P2-9 | **FIXED (Phase 2): `finding_observations`, one row per finding per scan.** **Rescans overwrite evidence.** Upsert replaces `evidence`, `signals`, `reasons`; only a `rescored` event note remains. V (ran two scans: evidence reduced to the latest run). | Each scan's evidence retained (per-scan observations). |
| P2-10 | **FIXED (Phase 2): missed-scan counter, only from complete scans of a healthy source; no auto-resolve.** **Findings that disappear are not tracked** (no "not seen since scan N"). V (code) | Last-seen and "no longer observed" state. |
| P2-11 | **FIXED (Phase 2): brand create/update/verify/delete, asset confirmation and domain proof are in the audit log (user changes were done in Phase 1).** **Brand profile and user changes are not audited**, though they control what is excluded from detection. V (code) | Audit rows for brand, asset, user and login events. |
| P2-12 | **FIXED (Phase 2): create/update validate, block on errors (422), return and store the result; store lookups stay Untested live.** **Brand creation does no asset validation.** App id formats and store existence are only checked if someone clicks "Verify". V (code) | Create/update returns validation results. |
| P2-13 | **FIXED (Phase 3): workers and cron calls check in (`workers`); a queued scan with no live worker shows "Waiting for a worker" and how to fix it.** **Scan can hang forever without a worker.** With no `WORKER_SECRET`, `/scans/:id/run` returns "queued" and the UI polls indefinitely if no worker runs. V (code) | UI says "waiting for a worker" with a timeout. |
| P2-14 | **FIXED (Phase 3): `SCHEDULER_CADENCE_MINUTES` (default 1440 on Vercel); brand settings and overview state the real cadence.** **Schedule options misleading on Vercel Hobby** (daily cron) while UI offers 6 and 12 hours. A | UI/doc state the effective cadence per deployment. |
| P2-15 | **FIXED (Phase 3): every delivery is recorded; failures show the reason, analysts can retry, admins can send a test. Webhook URL itself stays in the environment.** **Alerts are webhook-only**, with no UI to configure or see delivery failures; a failed send is only logged. U | Alert settings, delivery state, retry. |
| P2-16 | **DECIDED (Phase 2): single tenant, documented; no answer was given, so the default stands. Per-brand access is not built.** **Single tenant.** Every user can see every brand and scan. A (by design?) | Decision recorded; per-brand access if multi-tenant. |

### P3

| ID | Defect | Acceptance criteria |
| --- | --- | --- |
| P3-1 | **FIXED (Phase 5): focus moves into the drawer, Tab stays inside, Escape closes and returns focus; one contrast failure found by a real-browser axe run and fixed; structural axe tests on 7 pages.** Finding drawer has no focus trap or focus return; contrast of `slate-500` text and keyboard flow of the rows are **U**. | Axe or manual keyboard pass. |
| P3-2 | `#users` as a non-admin renders a blank page. V (code) | Redirect with message. |
| P3-3 | **FIXED (Phase 5): Python tests block every non-local socket and datagram (and a test proves the block works); JS tests use fakes.** README says tests never reach the internet. Only `httpx.request` is patched; `httpx.Client`, sockets and `google-play-scraper` are not blocked. A | Block sockets in tests or soften the claim. |
| P3-4 | **FIXED (Phase 5): `/api/scans/:id/findings` and a list in scan history marking what was new in that scan.** No scan-to-findings view (which findings a given scan produced). V (code) | Link scan to its observations. |
| P3-5 | **FIXED (Phase 5): fonts bundled (fontsource); CSP no longer allows Google hosts.** Dashboard loads Google Fonts from a third party. V | Self-host or accept. |
| P3-6 | **FIXED (Phase 5): `npm audit fix` moved concurrently to a release that uses a fixed shell-quote; `npm audit` reports 0.** Dev-only `shell-quote` advisory via `concurrently`. V | Upgrade when a fixed release exists, or replace the runner. |

## Workflow trace (what exists)

| Workflow | Status |
| --- | --- |
| Registration | Unsupported by design. Admin creates users (UI/API/script). First admin only from env when the users table is empty. Done+tested. |
| Login, logout, role checks, demotion | Done+tested (see P2-3 for revocation). |
| Account recovery | Unsupported. |
| Brand create/edit, official assets | Done+tested for CRUD; trust model missing (P1-4). Domain verification: absent. |
| Demo scan | Done+tested end to end (16/16 planted fakes, 0 false positives). Synthetic data, labelled. |
| Live scan | Orchestration and failure paths Done+tested with fakes. **Live sources: Untested** (network blocked). Zero results versus failed versus unconfigured are distinct statuses. |
| Findings, evidence, review, audit trail | Done+tested; see P2-9, P2-11. |
| Scheduled rescans, retries | Done+tested on Postgres. Alerts: Mocked. |
| Source health | Done+tested. Unsupported: TikTok, LinkedIn, Telegram. Gated: X (paid), Instagram, Threads, Facebook (approval). |
| Vercel | **Untested.** Open questions: `-r` in root `requirements.txt`, rewrite path to the mounted FastAPI app, Python 3.12 vs local 3.13, 350 MB bundle, Deployment Protection between functions. |

## Found in Phase 4

| ID | Defect | Status |
| --- | --- | --- |
| P1-6 | **The demo brand (Northstar) was one of the 117 synthetic training brands**, so the demo benchmark (16/16 caught, 0 false positives) was not a held-out result. | FIXED: removed from training, retrained, regression test. The demo result held (16/16, 0 FP) on the unseen brand. It is still a small, hand-labelled, synthetic set. |
| P2-17 | Marking a finding official hid it from all future scans with no reason required. | FIXED: needs a note of 8+ characters. |
| P2-18 | A finding marked resolved (taken down) stayed silent if it came back. | FIXED: reopened with an event when a live scan sees it again. |

## Top blockers

1. Live sources cannot be verified from this sandbox; needs a normal network and the keys listed in `release-report.md`.
2. P1-1 to P1-5 should be fixed before any real use.
3. Open decision: single tenant or per-brand access (P2-16).

## Status after Phase 7

Open questions about Vercel (rewrite path, bundle size, Python version, Deployment Protection, cron cadence) are prepared and locally checked where possible; all remain **Untested** on Vercel. Known limits: rate limit is per process, single tenant, live sources unverified here.

## Addendum 2026-10-13: API Direct

- X, Instagram, Threads and Facebook Pages can now also be searched through API Direct (third-party provider, key `APIDIRECT_API_KEY`). Free tier is 50 requests per endpoint per month; source reports `rate_limited` when used up. Mocked only; no live request made yet.
- API Direct collects platform data as a third party, not through each platform's own API. Whether that fits Meta's and X's terms for this use is the user's call; the native, approval-gated collectors are unchanged.
