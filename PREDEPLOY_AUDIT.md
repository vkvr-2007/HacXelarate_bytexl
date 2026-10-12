# SignalGuard pre-deployment audit

Read-only audit of `ml-detection-engine` at `75044e3` (13 local commits, none pushed; `main` = original commit `be46a01`). No code, `.env`, database or cloud resource was touched. Local checks run during this audit: code reading, `git`, grep, and one in-process timing script (no network, no DB). Web sources were read on **2026-10-12** and are cited inline; anything not confirmed there is marked *unverified*. Related: [ML_SYSTEM.md](ML_SYSTEM.md), [ML_ROADMAP.md](ML_ROADMAP.md), `DEPLOYMENT.md`, `REPAIR_PROGRESS.md`.

Status vocabulary: **Implemented**, **Tested locally** (unit/integration/browser against fakes or a `_test` DB), **Mocked** (fixture only), **Live-verified** (answered by the real service, evidence on record), **Partial**, **Missing**, **Unknown**. *Nothing in this repo is Live-verified*: no stored output of `npm run sources:check` exists, and the test suite blocks sockets (`ml/tests/conftest.py`). You report running the dashboard locally, creating a real brand and starting a live scan; I have no record of what those sources returned, so their live status is **Unknown**.

---
## 1. Current state (what it demonstrably does)
- Local stack runs: React dashboard, Express API, FastAPI ML service, Postgres 16, a polling worker (`npm run dev`); 137 pytest + 124 vitest pass, lint/types/build clean, a real-Chromium walkthrough passes with WCAG A/AA checks (`REPAIR_PROGRESS.md`, recorded runs; I did not re-run them in this audit).
- Demo mode scans a hand-labelled fictional brand and catches 16/16 planted fakes with 0 false positives (recorded, not re-run; 32 items written by the same author as the generator, so a smoke test).
- Live mode runs up to 13 live collectors (3 more are reported as unsupported, plus the demo source) and reports a status per source; nothing is faked when a source is unconfigured or unsupported.
- The ML model is a gradient-boosted ranker over 29 features trained only on synthetic data; real-world accuracy is **Unknown** ([ML_DATA_TRAINING_EVAL.md](ML_DATA_TRAINING_EVAL.md)).
- Not started: Neon, Vercel, production env vars, any real-service validation, any production smoke test.

## 2. Problem-statement completion (Phase 1)
Judging weights from the brief: Social 30, App Store 30, Brand Profile 15, UX 15, Presentation 10, +5–10 bonus for look-alike names.

| Capability | Implementation evidence | Test evidence | Live evidence | Status | Remaining work |
|---|---|---|---|---|---|
| Brand profile | `server/routes/brands.js` (create/update, 422 validation), `ml/brandml/validation.py`, `src/pages/BrandSettings.jsx`; `68eb6c6` | `tests/api/core.test.js`, `ml/tests` | You created a real brand locally (reported) | Implemented, Tested locally | Store-lookup validation Mocked; logo is a URL only (no upload); logo matching uses that one reference |
| Official domains and assets | `server/assets.js`, `ml/brandml/domain_proof.py` (DNS TXT / `.well-known`), `pipeline.py:official_match` | `test_domain_proof.py` (fake DNS/HTTP), `test_jobs.py` | none | Implemented, Mocked | Prove one real domain end to end; allowlist matches by `externalId` only |
| Social impersonation | `sources/social.py` (Bluesky, Mastodon, YouTube, Reddit, X, Instagram, Threads, Facebook) | `test_sources.py` parsers (mocks) | none | Implemented, Mocked | Run `sources:check`; X/Instagram/Threads/Facebook gated or paid; TikTok/LinkedIn/Telegram unsupported |
| Fake apps | `sources/appstores.py` (iTunes Search, `google-play-scraper`) | parser mocks | none | Implemented, Mocked | Live check; Google Play uses an unofficial scraper |
| Look-alike domains | `sources/domains.py` (DNS permutations ≤150, crt.sh), `variants.py`, `web_risk.py` | `test_sources.py`, `test_web.py` (fake sites) | none | Implemented, Mocked | ASCII variants only (no IDN); crt.sh unverified live |
| Retrieval + ML | `retriever.py`, `pipeline.py`, `train.py` | `test_detection.py`; synthetic metrics | none | Implemented, Tested locally (synthetic) | No real labels; retrieval recall unmeasured |
| Explainable scoring | `features.py:explain`, `signals`, `web_risk.factors` | `test_detection.py::test_findings_carry_readable_reasons` | none | Implemented, Tested locally | Reasons are post-hoc rules, not model attributions |
| Evidence persistence | `jobs.py:persist` (`findings`, `finding_observations`, `evidence`), `/api/findings/:id/evidence.json` | `ml/tests/test_jobs.py` on a real Postgres `_test` DB | none | Implemented, Tested locally | No retention; size per row unmeasured on real data |
| Analyst review / FP handling | `routes/findings.js` PATCH (status, notes, `official` needs ≥8-char reason), `ml_feedback` | `tests/api/quality.test.js`, e2e | none | Implemented, Tested locally | Feedback has no effect until ≥10 per class |
| Scheduling and jobs | `jobs.py:claim/enqueue_due_scans/reap_stale`, `api/index.js`, `vercel.json` cron | `test_jobs.py` (two workers never claim the same scan; stale reclaim) | none | Implemented, Tested locally | Vercel cron path Untested; capacity limit in §4 |
| Source health | `source_health` table, `registry.run_collectors` statuses, `/api/sources`, Sources page | mock tests for cached/partial/crash | none | Implemented, Tested locally | Needs real statuses |
| Auth, roles | `server/auth.js` (JWT cookie + `sessions` row, roles viewer/analyst/admin, lockout via `login_failures`), `app.js` CSRF check | `tests/api/security.test.js` | none | Implemented, Tested locally | Rate limiter is in-memory (see §6) |
| Audit, export | `audit_log`, `/api/audit`, `findings/export.csv` (5,000 rows max, formula-injection escaped), evidence JSON | `tests/api` | none | Implemented, Tested locally | No signed/immutable evidence; no retention |
| Demo/live separation | `registry._skip_reason`, `jobs.run_job` mode check, feedback live-only | `test_detection.py` (3 tests) | n/a | Implemented, Tested locally | none |
| Dashboard UX/errors | 8 pages in `src/pages`, `src/api.js` `ApiError`, axe + 390 px checks in `scripts/e2e.mjs` | e2e (Chromium) | You opened it locally (reported) | Implemented, Tested locally | No React error boundary (grep finds none): a render error blanks the page |
| Reporting, notifications, monitoring | `ALERT_WEBHOOK_URL` (Slack/Teams style) with `alert_deliveries` + retry, `/api/system`, `workers` table | mocked webhook tests | none | Partial | No email, no PDF/report export, no metrics or error tracking, no uptime check |
| Look-alike names (bonus) | `text.py:skeleton`, `features.py` swap/spacing/leet/homoglyph | `test_detection.py` (8 variants flagged, 6 normal names not) | none | Implemented, Tested locally | Training brands used in tests (in-sample) |
| Deliverables: architecture diagram, demo/slides | README has a Mermaid diagram; screenshots exist | n/a | n/a | Partial | No slide deck or demo script in the repo (an earlier chat artifact plan exists) |

## 3. Remaining-work register (Phase 2)
Levels: **BLOCKER** stops deployment or a core workflow, **HIGH**, **MEDIUM**, **LOW**. Stages: P prototype, H hackathon, D first deployment, S small production, C commercial.

**A. Code that needs writing**
| # | Item | Level | Stage |
|---|---|---|---|
| A1 | Scheduler cap: `CRON_MAX_JOBS` defaults to 3 (`server/app.js:275`), and the loop only checks the 240 s budget *before* claiming (`jobs.py:run_pending`), so a scan started late can overrun the 300 s limit | HIGH | D |
| A2 | `jobs.py:connect` has no `connect_timeout`/statement timeout; Node pool has no `statement_timeout` (`server/db.js`) | HIGH | D |
| A3 | Manual scan blocks the browser request up to 295 s (`app.js:/api/scans/:id/run` → `ml.runWorker`, timeout 295000) | MEDIUM | D |
| A4 | Per-process rate limiting (`express-rate-limit` memory store) does nothing across serverless instances | HIGH | D–S |
| A5 | No retention/cleanup (sessions, login_failures, observations, cache, audit) | HIGH | S |
| A6 | No source budgets: YouTube search.list = 100 calls/day (see §8), Brave $5 credit, SerpApi 250/month are not tracked | MEDIUM | S |
| A7 | List endpoints return heavy JSON (`SELECT f.*` incl. `features`, `evidence`, `description`); `/api/brands` unpaginated with correlated counts | MEDIUM | S |
| A8 | Domain/CT facts for one host are not merged (first candidate wins); no IDN variants | MEDIUM | S |
| A9 | React error boundary; polling UI for scans | LOW | H |
| A10 | Structured logs (scan id, source, latency); error tracking | MEDIUM | S |
| A11 | Real labelled evaluation set and calibration ([ML_ROADMAP.md](ML_ROADMAP.md)) | HIGH (detection quality) | S–C |
| A12 | Email/PDF reporting, SSO, multi-tenant, billing, SLAs, paid data feeds | LOW now | C |

**B. Existing code that needs validation (Implemented, unverified)**: every collector against its real service; domain proof on a real domain; Slack/Teams webhook; Vercel build, rewrite path preserving `req.url`, `api/ml.py` mount, cron; Python cold start and memory; psycopg through Neon's pooler; Neon TLS; the `includeFiles` bundle; Deployment Protection interplay.

**C. External services needing credentials**: Neon (free), Vercel (free Hobby), optionally Brave or SerpApi, YouTube, Reddit, Mastodon token, GitHub Actions secrets (`SIGNALGUARD_URL`, `CRON_SECRET`).

**D. Platform approval / commercial access**: Reddit API (approval, commercial needs a contract), Instagram Graph (Meta app + professional account), Threads keyword search and Facebook Pages Search (Meta app review / feature approval), X (pay-per-use credits); Vercel Hobby is non-commercial only.

**E. Documentation/submission**: slides or demo script (Missing); `DEPLOYMENT.md` corrections (below); screenshots exist; architecture diagram exists in README; ML docs exist.

**Stage verdicts**
| Stage | Verdict |
|---|---|
| Functioning local prototype | **Yes** (reported running; tests pass) |
| Credible hackathon submission | **Yes for Demo mode**; live claims must say "sources not yet verified"; add slides/demo script |
| Reliable first cloud deployment | **Not yet**: nothing deployed; needs §9 steps and a few small fixes |
| Maintainable small-scale service | Needs A1–A7, A10, backups drill |
| Commercially credible DRP | Far: needs real evaluation, paid/commercial data access, multi-tenancy |

## 4. Scalability and architecture (Phase 3)

### 4A. Frontend and API
- Express 5 with zod validation, helmet, 200 kB JSON limit, pagination on findings (`limit`/`offset`, `findingQuery`), CSV capped at 5,000 rows, observations capped at 200, scans list ≤100. Good.
- `GET /api/brands` returns every brand, each with two correlated sub-selects and `proofsFor` (`routes/brands.js:65`); fine to ~hundreds of brands, wants pagination beyond.
- Findings list uses `SELECT f.*` (all JSONB) 50 rows at a time and runs a separate `count(*)` with the same filters; the `q` filter uses `ILIKE '%…%'` (no trigram index; scans one brand's rows only).
- Node pool: `max` 3 on Vercel, 10 locally, `idleTimeoutMillis` 10 s, connection timeout 8 s (`server/db.js`); safe against connection storms when pointed at Neon's pooled endpoint. No statement timeouts, no request cancellation to Postgres.
- Rate limits: 300 req/min global, 10 logins/15 min, 30 scan-runs/hour — **memory store, per instance** (A4). Login lockout is DB-backed (`login_failures`) so brute force is bounded. `trust proxy` defaults to `1` on Vercel (`config.js:23`), so IP-based limits see the client IP.
- Observability: `/api/health` and `/api/system`; `console` logging only; 500s log the stack (`app.js:296`), which for unique-violation errors can include key values (an email) — low risk.

### 4B. Database (Neon free = 1 GB per project; see §8)
- Schema is sound: FKs with sensible `ON DELETE`, `UNIQUE (brand_id, platform, external_id)` makes finding upserts idempotent, `UNIQUE (finding_id, scan_id)` makes observations idempotent, partial index `scans_status` serves the queue.
- Missing/likely-needed indexes (not needed until measured): `findings (brand_id, status)` for the open-finding counts, `(brand_id, last_seen_at)` for the second sort; `scans (brand_id, status)` is served by `scans_brand_queued`; `finding_events` has `(finding_id, created_at)` ✓; `alert_deliveries` has `(brand_id, created_at)` ✓; `sessions` index is partial on live sessions ✓.
- Growth: one `finding_observations` row per reported finding per scan, each copying `features`, `signals`, `reasons`, `evidence`. Measured with no network: features+signals+reasons+minimal evidence = **808 B**; real rows add `description` (≤2,000 chars) and raw platform payloads, so **3–6 KB per observation is an unmeasured assumption**. `source_cache` stores whole result lists per (source, brand). Nothing is ever deleted (grep finds no purge/retention) → A5.
- Worker claiming: `claim()` is `UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`; a scan is claimed by exactly one worker (tested: `test_two_workers_never_claim_the_same_scan`). A running scan is re-claimable only after a missing heartbeat for `SCAN_STALE_MINUTES` (10) and `attempts < 3`; `reap_stale` fails exhausted ones. `persist` is idempotent (upserts), so a duplicate run after a false stale detection wastes work but does not corrupt data. A scan killed by the 300 s function limit stays `running` until stale + the next worker call (daily on Hobby) — so a queued/running scan can sit for up to ~a day (Medium).
- Transactions: `persist` writes a whole scan in one transaction and commits at the end; long, but only locks that brand's rows.
- Neon pooler: psycopg connections are opened per operation (`jobs.py:connect`, `PgCache.get/put`, `touch_worker`), so many short connections per scan (≈1 per source that returned results for the cache write, plus 4–6 per job; unmeasured). Neon's pooled endpoint is PgBouncer in transaction mode with protocol-level prepared statements supported since PgBouncer 1.22 ([Neon docs](https://neon.com/docs/connect/connection-pooling), 2026-10-12). psycopg3 prepares after 5 repeats of a statement (`persist` repeats the same upsert per detection), so this is **Requires external verification**, not a known failure. Safe fallback if it errors: `prepare_threshold=None` (one-line change). Migrations must use the **direct** (non-pooled) URL per the same page.
- Migration/rollback: forward-only SQL (`schema_migrations`), each file in a transaction, no down scripts, no lock against two runners at once. Rollback strategy = Neon point-in-time restore (free plan: 6 hours, [Neon pricing](https://neon.com/pricing)) — a restore drill has never been done.

### 4C. ML service and workers
- Measured here (CPU, no network; Vercel numbers **unknown**): `import sklearn/numpy/scipy` 2.4 s, `Engine()` model load 0.8 s, peak RSS 165 MB, scoring 0.8 ms per candidate (500 candidates in 0.41 s), retrieval of 500 in 0.04 s. CPU is not the bottleneck; **network I/O and politeness delays are**.
- Per live scan (defaults, all free sources + keys on): up to 4 queries × (App Store, Google Play, Bluesky, Mastodon, YouTube, Reddit, web search) ≈ 30–40 API calls; DNS ≤150 lookups (+MX); crt.sh 1 call (5 s spacing); page inspection ≤25 pages (+robots.txt each); icon fetches for retrieved profiles when the brand has a logo (≤200, cached). Worst case ≈ 350–450 outbound requests (counted from code; typical count Unknown). `SOURCE_DEADLINE` = 50 s per source in parallel; page checks 6 s timeout × 25 / 6 workers.
- Lower bound by spacing alone: App Store 4 × 3 s = 12 s, crt.sh 5 s; a realistic scan is **tens of seconds to a couple of minutes (unmeasured)**.
- Vercel Hobby limits ([Vercel limits](https://vercel.com/docs/functions/limitations), 2026-10-12): 300 s max duration, 2 GB / 1 vCPU, 500 MB uncompressed for Python, 4.5 MB request/response body, 1,024 shared file descriptors. Our config asks for 300 s and 2048 MB: **at the Hobby ceiling**. Bundle estimate 343 MB (local install sizes) — **Requires external verification**.
- Budget logic: `WORKER_BUDGET_SECONDS`=240 is checked only before claiming the next scan (`run_pending`), so a scan that starts at 230 s can run past 300 s and be killed (A1). The Node caller waits up to 295 s on the Python function (`ml.js`), so a manual scan holds *two* functions open.
- Scan recovery: heartbeat thread every 30 s; an interrupted scan is retried up to 3 times; after that it fails with a message. Duplicate scan prevention for a brand: `INSERT … WHERE NOT EXISTS (queued/running)` (`routes/brands.js:232`) — race-safe enough (small window between concurrent inserts is closed by a single statement but not by a unique index; Low).

### 4D. External sources
- API keys are env-only, never logged (`test_api_request_never_logs_secrets_in_errors`), each in its own variable; one `.env` for all functions on Vercel.
- Politeness is per-process (`RateLimiter`); on serverless several instances multiply the rate. Backoff: retries 429/5xx/timeouts ≤2 with jitter, honours `Retry-After` up to 15 s, `auth_failed` not retried.
- Caching: `source_cache` fallback only when a source *fails* (≤7 days, labelled `cached`); there is no cache to *avoid* calls, so query amplification is linear in brands × queries.
- Query amplification (brands × scans/day × calls) drives §5.

## 5. Capacity and cost scenarios (Phase 4)
Assumptions (stated, not measured): one scan per brand per day; 4 queries per query-based source; scan wall-clock 30–120 s; ~50 reported findings per scan; 3–6 KB per observation.

| Dimension | 1–10 brands | 100 | 1,000 | 10,000 |
|---|---|---|---|---|
| Scan workload / day | ≈ 40–450 outbound requests per scan (counted from code, §4C) → ≤ ~4,500/day | ≤ ~45k | ≤ ~450k | ≤ ~4.5M |
| Scheduling | **Sufficient only if** more than 3 runs/day: Hobby cron = once/day (±59 min, [Vercel cron](https://vercel.com/docs/cron-jobs/usage-and-pricing)) with `CRON_MAX_JOBS`=3 → 3 scans/day. 10 brands need ≈10 scans in 240 s-bounded calls → enable `rescan.yml` (every 6 h, free) and raise `CRON_MAX_JOBS` | 100 scans × 30–120 s = 0.8–3.3 h/day of serialized scan time → needs many invocations; Pro cron (per minute) or an always-on worker | one always-on worker pool and a real queue need | not supported by this architecture |
| Database | 1 GB free ≈ plenty (10 brands × 250 KB/day ≈ 2.5 MB/day → ~400 days) | ≈ 25 MB/day → 1 GB in ~40 days → retention + paid storage | ≈ 250 MB/day | far beyond |
| ML | 165 MB RSS, 0.8 ms/candidate: no constraint | same | same; cold start matters per invocation (2.4 s + 0.8 s locally) | same |
| External APIs | App Store ≈ 20 calls/min ([Apple](https://performance-partners.apple.com/search-api)): 4 calls × 10 brands = 40 calls ≈ 2 min; YouTube search.list 100/day → 25 scans/day (fine); Brave $5 credit ≈ 1,000 searches ≈ 250 scans/month, so only ≈8 brands scanned daily | App Store 400 calls ≈ 20 min; YouTube (25 scans/day) and Brave credit exhausted → drop or pay | App Store 4,000 calls ≈ 3.3 h at the stated rate; crt.sh at 5 s spacing = 83 min of a volunteer service | App Store 40,000 calls ≈ 33 h/day, impossible on one IP; crt.sh abuse |
| Hosting | Vercel Hobby (free) works for demo/non-commercial; commercial use needs Pro ($20/seat/month per [Hobby page](https://vercel.com/docs/plans/hobby)) | Pro; function memory-hours: 0.8–3.3 h/day × 2 GB × 30 ≈ 48–200 GB-h vs 360 GB-h Hobby allowance (unmeasured; roughly doubles while the Node function waits) | external worker host | queue + worker fleet |
| Cost | Neon free: 100 CU-hours, 1 GB, 5 min autosuspend, PITR 6 h; Vercel Hobby free; sources free or use free credit | Neon Launch is usage-based ($0.106 per CU-hour, $0.35 per GB-month, [Neon](https://neon.com/pricing)) + Vercel Pro + search credits ≈ **uncertain, needs a measured month** | uncertain | uncertain |
| Trigger for the next step | any of: >3 brands needing daily scans on Hobby; DB >700 MB; a scan >200 s; source quota exhausted | observed scan backlog >1 h or >1 GB growth/month; first paying/commercial user | scans >10 concurrent or App Store/crt.sh throttled | needs a different product architecture and data partnerships |

No throughput numbers above are measurements except the local CPU figures. **Benchmark to run** (needs network, keys, a preview deployment): 10 live scans of 10 different ordinary brands, record per-source latency/count (`scans.sources`), total duration, candidates, bytes added (`pg_total_relation_size`), Neon CU-hours, Python cold start, function memory (Vercel logs).

## 6. Security and production readiness (Phase 5)
**Already in place (Tested locally):** secrets only in env, `.env` gitignored, tracked-file secret scan (`scripts/check-secrets.js`, in CI); bcrypt passwords; JWT cookie `httpOnly`, `sameSite=lax`, `secure` in production, row in `sessions` (revocable); CSRF by Origin check + JSON-only; helmet CSP with no third-party hosts (`vercel.json`); zod on every body/query; parameterized SQL (the only interpolated pieces are an allow-listed `ORDER BY` and a zod-validated integer `LIMIT/OFFSET`); SSRF guard for page fetches and webhooks (private/loopback blocked, DNS pinned, redirects capped, robots honoured: `safe_http.py`, `test_web.py`); API→ML bearer (`ML_SERVICE_SECRET`, fail-closed in production); cron bearer (`CRON_SECRET`, 503 if unset, constant-time compare); role checks per route; audit log of admin actions; CSV formula-injection escaping; `npm audit` 0 and `pip-audit` clean at last gate.

| Risk | Evidence | Class |
|---|---|---|
| Serverless rate limiting ineffective across instances | `express-rate-limit` default store | HIGH hardening (use Vercel WAF custom rules, up to 3 on Hobby per [Hobby page](https://vercel.com/docs/plans/hobby), plus DB lockout already present) |
| ML function reachable on the public production URL, protected by bearer only | `/api/ml/*` rewrite | MEDIUM hardening: 401s are cheap, but each hit can cold-start a 340 MB function |
| Deployment Protection | Under Standard Protection the **production domain is public** and generated deployment URLs are protected ([Vercel docs](https://vercel.com/docs/deployment-protection)); "All Deployments" would block API→ML calls, and `server/ml.js` has no protection-bypass header | **Requires external verification**; keep Standard Protection and set `ML_SERVICE_URL` to the **production domain**, never a `VERCEL_URL`; previews will not reach the ML function |
| TLS to Neon | `ssl: {rejectUnauthorized:true}` when URL has `sslmode=require`; psycopg honours `sslmode` | Requires external verification (first connect) |
| `ADMIN_PASSWORD` kept in env after first start | `config.js` | LOW (remove after first sign-in; documented) |
| PII in logs | stack on 500 may include a unique-key detail; no request-body logging | LOW |
| Backup/restore | Neon free PITR 6 h, no drill; no logical backups | MEDIUM: take a `pg_dump` (direct URL) before each migration |
| Supply chain | pinned Python deps, lockfile, audits at gate; `google-play-scraper` is an unofficial scraper | MEDIUM |
| Evidence integrity | rows are editable by DB admins; no hashing | LOW now, matters commercially |
| Scan abuse | analysts can start 30 scans/hour/instance; no per-brand daily cap; query amplification burns paid quotas | MEDIUM |

No deployment-blocking security defect found in the code. Deployment blockers are configuration/verification items (§7).

## 7. Neon and Vercel readiness (Phase 6)
| # | Item | Class |
|---|---|---|
| 1 | Env var names: required — `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `APP_ORIGIN`, `ML_SERVICE_URL`, `ML_SERVICE_SECRET`, `CRON_SECRET` (and/or `WORKER_SECRET`), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first start only); `NODE_ENV=production`; optional — `DATABASE_SSL`, `DATABASE_POOL_MAX`, `CRON_MAX_JOBS`, `WORKER_BUDGET_SECONDS`, `SCHEDULER_CADENCE_MINUTES`, `ALERT_WEBHOOK_URL`, `BRAVE_SEARCH_API_KEY`/`SERPAPI_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`, `MASTODON_*`, source caps (`DOMAIN_MAX_PERMUTATIONS`, `MAX_PAGE_CHECKS`, `MAX_QUERIES_PER_SOURCE`) | Verified locally (`config.js` validation refuses production without them) |
| 2 | Local vs production: locally only `DATABASE_URL`, and generated secrets (`npm run setup:env`); production adds `APP_ORIGIN`, `ML_SERVICE_URL`, Neon URL | Verified locally |
| 3 | Migration procedure: `DATABASE_URL=<direct Neon URL> npm run db:migrate` from your machine. **`DEPLOYMENT.md` currently says to copy the pooled string for step 2–3; Neon says use a direct connection for migrations** — doc fix needed | Known blocker (docs) |
| 4 | Runtime URL: Neon **pooled** (`-pooler`) host for the app; direct for migrations | Requires external verification |
| 5 | Build/functions: `vercel.json` (tested by `tests/scripts.test.js`): `api/index.js` 300 s, `api/ml.py` 300 s/2048 MB/`includeFiles`; `npm run build` → `dist/` | Verified locally (config), build on Vercel Requires external verification |
| 6 | Python function: imports `service`, mounts at `/api/ml`; local in-process check passes; `.python-version` = 3.12; bundle ≈343 MB < 500 MB | Requires external verification |
| 7 | ML routing/auth: `/api/ml/(.*)` rewrite before `/api/(.*)`; bearer secret; must preserve original path | Requires external verification |
| 8 | Cron: `0 6 * * *`, Hobby = once per day ±59 min; `CRON_SECRET` sent as bearer; `CRON_MAX_JOBS` default 3 undocumented in `.env.example` | Requires external verification; doc gap |
| 9 | Per-environment config: Production only; previews should not share the production DB | Requires external verification |
| 10 | Smoke tests (after preview): `/api/health` db+ml ok; sign in; add demo brand → 16/16; live brand scan shows real source statuses; `/api/internal/cron` 401 without secret, 200 with; headers (CSP, HSTS); `sources:check` against the deployed keys | Not yet run |
| 11 | Rollback: Vercel instant rollback to previous deployment (code); Neon PITR 6 h or pre-migration `pg_dump` (data); `git checkout <commit> -- ml/models/` (model) | Untested |
| 12 | Hobby is non-commercial ([Hobby page](https://vercel.com/docs/plans/hobby)); the hackathon use is fine | Decision recorded |

## 8. Source integration matrix (Phase 7)
"Free verified" is from official pages read on 2026-10-12 unless stated. *Repo text* = the access note in `sources/*.py`, whose official page I could not retrieve.

| Source | Implemented | Real-service test evidence | Credentials / approval | Free access verified | Remaining action |
|---|---|---|---|---|---|
| App Store (iTunes Search) | Yes | none | none | Yes, "approximately 20 calls per minute" ([Apple](https://performance-partners.apple.com/search-api)) | `sources:check` |
| Google Play | Yes (`google-play-scraper`, unofficial) | none | none | **No official API**; scraping Google pages may breach terms and may be throttled from Vercel IPs (unverified) | `sources:check`; keep optional; label as best effort |
| Bluesky | Yes | none | none | Rate limits page not retrievable (unverified) | `sources:check` |
| Mastodon | Yes | none | none; some instances require a token (repo text) | unverified | `sources:check` |
| YouTube | Yes | none | API key (Google Cloud) | Current doc: `search.list` default **100 calls/day**, cost 1 each; 10,000 units/day for other endpoints ([quota page](https://developers.google.com/youtube/v3/determine_quota_cost), updated 2026-10-08). **The code text says "each search costs 100 units", which is outdated** | Update text; budget 4 calls per scan → 25 scans/day |
| Reddit | Yes | none | Approval: new access via Reddit's request form; commercial use needs permission ([Reddit Help](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)) | Not self-serve free; rate limit figure not given | Optional for first release |
| X | Yes | none | Bearer token, pay-per-use credits | No free tier documented; credits only ([X docs](https://docs.x.com/overview.md)); per-lookup price not listed | Keep OFF until you approve spend |
| Instagram | Yes | none | Business Discovery needs an Instagram professional account and Facebook Login token; looks up an **exact username** ([Meta docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery)) | Free; no keyword search, rate limits not stated | Optional; cannot discover unknown accounts |
| Threads | Yes | none | `threads_keyword_search` permission with Meta approval (repo text; official page fetch failed) | unverified | Optional |
| Facebook Pages | Yes | none | Page Public Metadata Access approval (repo text; official page did not state it) | unverified | Optional |
| TikTok, LinkedIn, Telegram | Reported as `unsupported` | n/a | n/a | No suitable public API (repo text, not re-verified here) | Do not scrape |
| Web search | Yes | none | Brave or SerpApi key | Brave: "$5 free credits every month", $5/1,000 searches, 50 req/s ([Brave](https://api-dashboard.search.brave.com/documentation/pricing)); storage/commercial terms not stated on that page; SerpApi 250/month (repo text) | Optional but highest-value source |
| Look-alike domains (DNS) | Yes | none | none | free | ASCII variants only |
| crt.sh | Yes | none | none | free, no SLA stated, often slow | `sources:check`; be gentle |
| Demo | Yes | tests | none | n/a | none |

Groupings — **Works without credentials (expected, unverified live):** App Store, Google Play, Bluesky, Mastodon (public instances), look-alike domains, crt.sh. **Needs a key:** YouTube, Brave/SerpApi. **Needs platform approval:** Reddit, Instagram, Threads, Facebook. **Paid/metered:** X, Brave beyond credit. **Unsupported:** TikTok, LinkedIn, Telegram. **Optional for the first release:** everything except the keyless group plus one web-search key.

## 9. Ten recommended improvements (Phase 8), ranked
Nothing is implemented. "Before first deploy" = needed before the first preview/production deployment.

| # | Change | Problem and evidence | Benefit | Sev | Effort | Cost | Depends | Risk | Acceptance test | Introduce when | Before deploy? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Correct `DEPLOYMENT.md`/`.env.example`: direct URL for migrations, pooled for runtime, document `CRON_MAX_JOBS`, YouTube quota text, Hobby cron limits | doc says pooled for migrations; Neon says direct | avoids a failed first migrate | High | S | free | none | none | doc review + `db:migrate` on Neon succeeds | now | **Yes** |
| 2 | Make scheduling honest: set `CRON_MAX_JOBS`, enable `.github/workflows/rescan.yml`; guard `run_pending` so it does not start a scan when remaining budget < a configurable minimum (e.g. 90 s) | cron once/day × 3 jobs; budget checked before claim only (`jobs.py:run_pending`) | 12 scans/day capacity free; no killed scans | High | S | free | GitHub secrets | small code change | test: two scans, budget 100 s → second not started; backlog drains across calls | now | **Yes** (config yes; code recommended) |
| 3 | Timeouts and pooler safety: `connect_timeout`, `statement_timeout` on both Node and psycopg; `prepare_threshold=None` if the pooler errors | no timeouts anywhere (grep) | a stuck query cannot hold a function for 300 s | High | S | free | none | low | test: slow query aborts at limit; scan persists through the pooled URL on the preview | now | **Yes** |
| 4 | Move manual scans off the request: `POST /scans/:id/run` returns 202, UI polls `/api/scans/:id` | request holds Node+Python functions up to 295 s | better UX, half the memory-time | Med | M | free | #2 | UI change | e2e: scan completes while page stays responsive | after first preview | No |
| 5 | Persistent abuse limits: Vercel WAF custom rules (free, 3) on `/api/auth/login`, `/api/ml/*`, plus a DB-backed daily scan cap per brand | memory-store limiter | real throttling on serverless | High | S–M | free | Vercel project | low | burst test returns 429 across instances | before sharing the URL | No (WAF yes) |
| 6 | Source budgets: count calls per source per day in DB, skip with status `rate_limited`/`budget` | YouTube 100/day, Brave $5, SerpApi 250/month are untracked | no surprise spend or silent exhaustion | Med | M | free | none | low | scan with exhausted budget reports it, no call made | when a keyed source is enabled | No |
| 7 | Observability: structured logs (scan id, source, latency, counts), a `/api/system` field for last scan duration; optional free error tracker | `console` only | find slow sources, calibrate §5 | Med | S | free tier uncertain | none | low | logs show per-source latency per scan | with first benchmark | No (basic logs yes) |
| 8 | Retention job: purge expired sessions, old `login_failures`, cache; thin old `finding_observations` | nothing is deleted (grep) | bounded growth on a 1 GB plan | High | M | free | none | data loss if wrong → dry-run first | dry-run count matches; size stops growing | DB >500 MB or >20 brands | No |
| 9 | List payload and indexes: omit `features`/`evidence`/`description` from list responses; paginate `/api/brands`; add `(brand_id,status)` index only if EXPLAIN shows need | `SELECT f.*`, unpaginated brands | smaller responses | Med | S–M | free | none | API shape change | list response bytes drop; EXPLAIN on 100k seeded rows | >10k findings/brand or >50 brands | No |
| 10 | React error boundary and graceful "API unavailable" state | none in `src` | no blank page on a render error | Low | S | free | none | none | test throws in a page; fallback shown | before demo | No |

**Conditional, not recommended now:** always-on worker host (trigger: sustained backlog >1 h or scans >200 s; likely paid, needs your approval).

## 10. Final decision report
**Top blockers (must resolve before deploying):** (1) nothing is deployed or verified: Neon project, Vercel project, env vars, first preview, smoke tests; (2) `DEPLOYMENT.md` migration URL instruction conflicts with Neon's guidance; (3) the scheduler can run only 3 scans/day on Hobby unless you enable the GitHub Actions rescan and set `CRON_MAX_JOBS`; (4) no live source has ever been verified (`sources:check`); (5) timeouts missing (#3). No code defect that prevents deployment was found.

**Scalability assessment:** adequate for 1–10 brands on free tiers if scheduling is fixed; CPU is negligible (0.8 ms/candidate); bottlenecks are source politeness delays, the 300 s function limit, the once-a-day Hobby cron, free storage (1 GB) and per-source quotas. Unknown: real scan duration, Vercel cold start, real row sizes, Neon CU-hours.

**Deployment checklist:** §7. **API checklist:** §8.

**What NOT to build yet:** Kubernetes, message broker/Redis, microservices, read replicas, partitioning, a second database, a rewrite to another framework, paid sources, an LLM, multi-tenancy, billing, email/PDF reports, an always-on worker host.

**Recommended execution order**
1. Approve the small changes (#1–#3) and I make them on a branch; tests and gate re-run locally.
2. On your machine run `npm run setup:env -- admin@gmail.com`, then `npm run sources:check` (normal network); paste only the status table here, never keys.
3. Create a free Neon project; run migrations with the **direct** URL; take a `pg_dump`.
4. Create a free Vercel project, set env vars (Production only), keep Standard Protection, set `ML_SERVICE_URL` to the production domain.
5. Deploy once (you approve), run the smoke tests in §7 item 10; record function duration, cold start, memory, bundle size.
6. Add GitHub secrets, enable `rescan.yml`; watch two scheduled runs.
7. Run the 10-brand benchmark (§5); update this audit with measured numbers.
8. Then #4–#10 in order of the triggers.

**Evidence and uncertainty register (could not be proven from the repo)**
- Any live source behaviour; whether Bluesky/Mastodon/crt.sh/Google Play answer from Vercel IPs.
- Real accuracy; retrieval recall ([ML docs](ML_DATA_TRAINING_EVAL.md)).
- Vercel: build result, rewrite preserving `req.url`, Python function startup and memory, whether Protection Bypass for Automation is available on Hobby (the Hobby page lists only Exceptions and Shareable Links).
- Neon: psycopg behaviour through the pooler, max connections on free (page did not state), CU-hours consumed.
- Row sizes (3–6 KB is an assumption), scan duration (30–120 s is an assumption), per-scan request count in practice.
- Threads, Facebook Pages and Bluesky official limits (pages not retrievable); SerpApi 250/month and Reddit rate limits (repo text only).
- Your local run: what the live scan returned.
- Test counts and demo 16/16 are from recorded runs, not re-run here.

## Verdict
- **Is the architecture adequate for a first deployment?** Yes, for a demo-scale, non-commercial deployment with a handful of brands. Nothing needs re-architecture.
- **Smallest safe set before deploying:** #1, #2 (config plus the budget guard), #3, plus the §9 steps 2–5 of the execution order.
- **Can wait until after deployment:** #4–#10, a retention policy until the DB passes ~500 MB, cross-source merge, calibration and the real evaluation set.
- **Must be measured before claiming scalability:** per-source latency and success on real services, scan duration and request counts, Python cold start/memory on Vercel, DB growth per scan, Neon CU-hours, queue backlog under 10 brands.
- **Approve before any code changes:** (a) edit `DEPLOYMENT.md` and `.env.example`; (b) changes #2 and #3 as one small branch (no push until you say); (c) enabling the GitHub Actions rescan and setting `CRON_MAX_JOBS`; (d) creating free Neon and Vercel projects, and the first deploy; (e) which optional keys to obtain (Brave uses a monthly free credit; X stays off); (f) accepting Hobby's non-commercial limit.

*Sources read 2026-10-12:* [Neon pricing](https://neon.com/pricing), [Neon pooling](https://neon.com/docs/connect/connection-pooling), [Vercel function limits](https://vercel.com/docs/functions/limitations), [Vercel cron](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection), [YouTube quota](https://developers.google.com/youtube/v3/determine_quota_cost), [Brave pricing](https://api-dashboard.search.brave.com/documentation/pricing), [Apple Search API](https://performance-partners.apple.com/search-api), [Meta Business Discovery](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery), [X docs](https://docs.x.com/overview.md), [Reddit Help](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).
