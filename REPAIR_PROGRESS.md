# Repair progress

## Status

| Phase | State |
| --- | --- |
| 0 Audit | **Done**. Findings in `PRODUCT_AUDIT.md`. No application code changed. |
| 1 Auth & security | **Done** (see below) |
| 2 Core app & persistence | **Done** (see below) |
| 3 Live monitoring | **Done** (see below) |
| 4 Detection & investigation quality | **Done** (see below) |
| 5 Product completeness & UX | **Done** (see below) |
| 6 Local release gate | **Done** (see below) |
| 7 Vercel readiness | **Done as preparation only; nothing deployed** (see below) |

## Collapsed history

- Before the phased plan: ML engine, Postgres platform, dashboard and Vercel config were built and gated locally (commits `971594a`, `e648ef1`). Not pushed or deployed.

## Phase 0 (collapsed)

- Defects found: 0 P0, 5 P1, 16 P2, 6 P3 (`PRODUCT_AUDIT.md`). `npm audit`: 2 critical, dev-only (`shell-quote` via `concurrently`). `pip-audit`: clean.

## Phase 1 (collapsed)

P1-1 SSRF, P1-2 ML secret, P1-3 pool crash, P2-2 to P2-7 (accounts, revocable sessions, origins, health, login lockout, 401 handling), security log: all **Done+tested**. Self-service recovery **Unsupported**. General API limiter is still per process. 55 JS + 108 Python tests at the end of Phase 1.

## Phase 2 results

| Item | Label |
| --- | --- |
| P1-4 Asset trust: suggested / unverified / confirmed. Only confirmed accounts and apps hide results; the server ignores a client-supplied `confirmed`; confirming needs a written reason and is recorded with who and when; editing a confirmed app's publisher or id drops it back to unverified; unconfirmed matches stay listed with a note | Done+tested |
| P1-4 Domain proof: DNS TXT (`_signalguard.<domain>`) or `/.well-known/signalguard-verify.txt`; only proven, declared domains exclude results; checked through the SSRF-safe fetcher | Done+tested with fake DNS/HTTP. **Untested** against real domains (no network here) |
| P2-1 `sources: []` runs nothing (scan refused, scheduler skips, worker fails it with a reason); `null` still means all; unknown source keys rejected | Done+tested |
| P2-8 Findings pagination (50 per page) | Done+tested |
| P2-9 Per-scan observations (`finding_observations`); history in the finding drawer and evidence export; existing findings backfilled as one observation each | Done+tested |
| P2-10 Not-seen tracking: counts only complete (`ok`) scans of the finding's source; cached, partial and failed scans never count; no auto-resolve; one event per first miss; cleared on a live re-sighting | Done+tested |
| P2-11 Audit of brand create/update (field names and asset ids only), verify, delete, asset confirm/withdraw, domain proof | Done+tested |
| P2-12 Validation on save: format errors block (422), result stored and returned; if the checker is down the profile saves with a warning | Done+tested. Store lookups **Untested** live |
| Suggested profile items marked `suggested` | Done+tested |
| Migration 003: additive only; demo assets set to confirmed; rerun-safe; live assets untouched | Done+tested; applied to the dev DB (2 brands, 16 findings kept, 16 observations backfilled) |
| P2-16 Single tenant | Decided by default (no reply), documented. Per-brand access is **Unsupported** |

Tests after Phase 2: 83 JS (23 API, 20 security, 21 core, 19 dashboard), 127 Python, lint/types/build clean. Live smoke on the dev DB: create, bad package name rejected, unknown source rejected, confirm without evidence rejected, empty sources refuse a scan, domain check reports why it failed; the smoke brand was removed afterwards. Not verified on Vercel or against live providers.

## Phase 3 results

| Item | Label |
| --- | --- |
| P2-13 Worker liveness: workers, cron and API-triggered runs write `workers`; `/api/system`; queued scan with no live worker shows why and what to run | Done+tested |
| P2-14 Scheduler cadence (`SCHEDULER_CADENCE_MINUTES`, 1440 on Vercel); brand settings and overview warn when the interval is shorter | Done+tested. Real Vercel cron **Untested** |
| P2-15 Alert deliveries recorded (`alert_deliveries`), failures shown with reason, retry (analyst, once), test alert (admin); sent only through the SSRF-safe fetcher; 'alerted' event written only on success | Done+tested with a faked webhook. **Untested** against Slack/Teams |
| `npm run sources:check`: probes every keyed source for real and exits 1 on real failures | Done+tested with fakes. **Not run live: needs a normal network and keys** |
| Real-source verification, per-source pagination | **Blocked** (no network here). Not claimed |

Tests after Phase 3: 95 JS, 131 Python, lint/types clean.

## Phase 4 results

| Item | Label |
| --- | --- |
| **New P1-6: demo brand was in the training set.** Removed, retrained (precision 0.974, recall 0.977, F1 0.976 on held-out synthetic brands); demo scan still 16/16 with 0 false positives; test fails if a demo brand re-enters training | Done+tested |
| P1-5 Feedback eligibility: live findings only, reviewer and decision stored, unknown-origin rows kept but never used, needs 10 of each class, feedback not in reported metrics | Done+tested (rules). **Untested**: effect of real feedback on model quality (none exists) |
| Official needs a written reason (P2-17); resolved findings reopen when seen again (P2-18); false positives stay dismissed | Done+tested |
| Metrics honesty: `evaluationNote` in metrics.json; README states the figures are synthetic | Done |
| Real-world accuracy, false-positive rate on live data | **Unknown**: needs live scans reviewed by people. Not claimed |

Tests after Phase 4: 103 JS, 135 Python, lint/types clean.

## Phase 5 results

| Item | Label |
| --- | --- |
| P3-1 Drawer focus trap/return; WCAG 2 A/AA axe run in real Chromium over 8 views (overview, findings, drawer, scans, sources, brand, account, users): 1 contrast failure (`slate-500`), fixed, re-run clean | Done+tested (jsdom axe on 7 pages + focus test). Screen-reader behaviour **Untested** by a person |
| 390 px mobile check: sources page overflowed, fixed; all 7 views fit | Done (manual script, not an automated test) |
| P3-3 Python tests block non-local sockets | Done+tested |
| P3-4 What each scan found, "new in this scan" | Done+tested |
| P3-5 Self-hosted fonts, tighter CSP | Done (build verified) |
| P3-6 `npm audit`: 0 vulnerabilities | Done |
| Not built: bulk review actions, saved filters, in-app report export beyond CSV/JSON evidence | **Not built** |

Tests after Phase 5: 113 JS, 136 Python, lint/types clean, build clean.

## Phase 6 and 7 results

| Item | Label |
| --- | --- |
| `npm run setup:env`: fills JWT, admin password, ML/worker/cron secrets randomly, never overwrites, prints key names only | Done+tested |
| `npm run check:secrets` (also in CI), `npm audit` (0 vulnerabilities), `pip-audit` | Done+tested |
| `npm run release:gate`: secrets, audits, lint/types/all tests/build, then a production-mode stack on a `_test` DB with a real-Chromium walkthrough (sign-in, brand, scan, review, axe WCAG A/AA on 6 pages, 390 px layout, no console errors) | Done+tested. Last run: checks passed; e2e passed after pointing it at the installed Chromium (`PLAYWRIGHT_CHROMIUM`). The two parts ran as separate invocations, not one unbroken run |
| Clean-clone test: npm ci, build, setup:env, migrations 001 to 005, API and ML boot, sign-in | Done+tested |
| `.env` parsing: `KEY=   # note` is now an empty value in `setup:env` and in the ML service (it used to become the text "# note") | Done+tested |
| `vercel.json` checks, `/api/ml` mount, Python 3.12 pin (`.python-version`), bundle estimate 343 MB vs 500 MB limit | Done+tested locally. **Untested** on Vercel |
| Vercel build, cron, Neon, rewrite path to FastAPI, Deployment Protection between functions, cold start, Python version picked | **Untested** (no deploy, by instruction) |
| Live sources, webhooks to real Slack/Teams, domain proof on real domains, store lookups | **Blocked** (no network or keys here). Run `npm run sources:check` on a normal network |
| Real-world accuracy and effect of reviewer feedback | **Untested**; reported metrics are the synthetic benchmark only |

Tests at the end: 124 JS, 137 Python, lint/types/build clean.

## Hackathon plan, Phase One: API Direct (2026-10-13)

| Item | Label |
| --- | --- |
| `ml/brandml/sources/apidirect.py`: four sources (`apidirect_x`, `_instagram`, `_threads`, `_facebook`), one account search each per scan, same `platform`/IDs as native collectors so dedupe and official exclusion apply | Done+tested (mocked) |
| Error mapping per apidirect.io/docs/error-handling: 402/spending caps to `rate_limited` (no retry), 401/403 to `auth_failed`, 429 concurrency/upstream and 5xx retried up to 2 times | Done+tested (mocked) |
| `ml/tests/test_apidirect.py` (30 tests); `npm run test:ml` 154 passed, 31 skipped (DB) | Done |
| Real API Direct requests | Untested: `APIDIRECT_API_KEY` not in `.env` yet |
| Post search endpoints (scam posts) | Not built: would double quota use on a 50/month free tier |
| `npm run test:js` 78 failed: tests default to Postgres on 5432 with no password; local DB is on 5434. No JS changed | Pre-existing, Blocked on `TEST_DATABASE_URL` |
| `ruff` not installed; `mypy` stops on numpy stubs vs `python_version = 3.11` | Pre-existing |

## Hackathon plan, Phase Two and Three prep (2026-10-13)

| Item | Label |
| --- | --- |
| Displayed name OmniScout and owl mark (`src/OwlLogo.jsx`) in header, sign-in, tab title, two messages | Done+tested (35 web tests, build) |
| `vercel.json` vs Vercel docs (read 2026-10-13): Hobby 300 s max and 2 GB memory, Python bundle 500 MB, cron once a day within the hour | Matches |
| With `TEST_DATABASE_URL` on local `signalguard_test`: JS 131/131, ML 185/185 | Done |
| `release:gate` cannot pass here: `ruff` missing, `mypy` stops on numpy stubs, `python3` is 3.14 without the ML deps | Blocked (local tooling) |
| Neon project, Vercel project, deploy | Blocked on Vaarsh: accounts and approval |

## Hackathon plan, Phase Three: first deploy (2026-10-13)

| Item | Label |
| --- | --- |
| API Direct live check ("Revolut"): X 20, Instagram 50, Threads 10, Facebook 7 results; SerpApi 31 | Live-verified |
| Neon: was empty; 001 to 005 applied over the direct URL | Done |
| Vercel project `omniscout`, production https://omniscout.vercel.app (CLI deploy from working tree, nothing pushed) | Done |
| `/api/health` 200 with database ok, ml ok (first call 8.6 s cold); `/api/ml/health` 200; `/api/auth/me` 401; cron 401 without secret, 200 when Vercel triggers it; CSP, HSTS, nosniff present | Live-verified |
| Sign-in, demo scan, live scan, findings, CSV on the live URL | Not tested: needs Vaarsh to sign in |

## Roadmap

| Phase | Planned fixes |
| --- | --- |
| 1 | Done (see above). Remaining from audit: general API rate limit is per process. |
| 2 | Done (see above). Still open: no UI to see which findings a scan produced (P3-4); no per-brand access. |
| 3 | Done (see above). Live verification and pagination remain Blocked on network and keys. |
| 4 | Done (see above). |
| 5 | Done (see above). |
| 6 | Done (see below). |
| 7 | Done as preparation; real Vercel behaviour Untested. |

## Blockers and decisions needed

- No live network here, so live sources stay **Untested** until run elsewhere with keys.
- Single tenant is the assumption; say so if per-brand access is needed.
- Paid or approval-gated sources (X, Instagram, Threads, Facebook) stay off until approved.

## Next

All phases are done. Next steps are with Vaarsh: fill `.env` (`npm run setup:env -- <admin email>`), run `npm run sources:check`, decide Hobby vs Pro, then approve a first preview deploy.
