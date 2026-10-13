# Vercel deployment checklist

Prepared, not deployed. Nothing here has been run against Vercel or Neon yet; the items marked **verify** are the ones that can only be confirmed on a first preview deployment.

## Shape

| Part | Where it runs | Why |
| --- | --- | --- |
| Dashboard | Vercel static output (`dist/`) | plain Vite build |
| API | Vercel Node function `api/index.js` | Express app, 300 s max duration |
| ML service and worker | Vercel Python function `api/ml.py`, mounted at `/api/ml` | same code as local; runs queued scans inside a request |
| Database | Neon Postgres (free plan: 1 GB per project, no card) | managed Postgres with TLS |
| Rescans | Vercel Cron, once a day on Hobby | `vercel.json` `crons` |
| More frequent rescans (optional) | GitHub Actions `rescan.yml`, every 6 hours | free; calls the cron endpoint |

There is no long-running worker on Vercel. Scans run when the dashboard calls `/api/scans/:id/run` (one scan per call), or when cron calls `/api/internal/cron` (up to `CRON_MAX_JOBS` scans per call). Each call works inside `WORKER_BUDGET_SECONDS` (240 s), under the 300 s function limit, and only **starts** another scan while at least `WORKER_MIN_REMAINING_SECONDS` (90 s) of that budget is left, so with the defaults no scan is started after 150 s into the call. A scan that is not started stays `queued` for the next call. A scan that still outlives its function is reclaimed after `SCAN_STALE_MINUTES` (10) and retried up to `SCAN_MAX_ATTEMPTS` (3) times, then marked failed.

## Scheduling and scan frequency

- **`CRON_MAX_JOBS`** (default **3**, read in `server/app.js`; the ML service clamps it to 1–20) is the most scans one call to `/api/internal/cron` will run. The time budget above can stop a call earlier.
- Every cron call first queues a scan for each brand whose scan interval has passed, then runs queued scans. So scheduled scans happen **at most as often as something calls the cron endpoint**, whatever interval a brand asks for.
- **Vercel Hobby cron runs once a day** (`vercel.json`: `0 6 * * *`). Per Vercel's cron documentation as cited in `PREDEPLOY_AUDIT.md` (read 2026-10-12, not re-checked here), a Hobby cron can fire anywhere within that hour. With the defaults that is at most **3 scheduled scans a day across all brands**; brands beyond that wait for a later day or for someone to press Scan.
- **More scans per day for free:** enable `.github/workflows/rescan.yml` (every 6 hours, 4 extra calls a day) by adding the repository secrets `SIGNALGUARD_URL` and `CRON_SECRET`. That makes up to 5 calls a day, so up to 5 × `CRON_MAX_JOBS` scans (15 with the default). GitHub may delay scheduled workflows. When you rely on it, set `SCHEDULER_CADENCE_MINUTES=360` so the dashboard's "worker active" check matches the real cadence.
- **Raising `CRON_MAX_JOBS`** only helps while scans are short. A call never starts a scan after `WORKER_BUDGET_SECONDS − WORKER_MIN_REMAINING_SECONDS` (150 s with the defaults), so a call fits roughly 150 s of scan starts. Real scan duration on Vercel is **unmeasured**.
- Keep `WORKER_BUDGET_SECONDS` plus a scan's worst-case length under the function limit (300 s). If scans are killed at 300 s, raise `WORKER_MIN_REMAINING_SECONDS` rather than the budget.

## Before the first deploy

1. **Vercel plan.** Decision: Hobby (chosen by Vaarsh, no alerts). Hobby is free but for non-commercial use only and allows one cron run a day. Commercial use needs the paid Pro plan (check current pricing on vercel.com/pricing). Decide before deploying.
2. **Neon.** Create a project. In the Neon console's connection details, copy **two** connection strings (both include `sslmode=require`):
   - the **direct** string (host without `-pooler`), used only for migrations, `pg_dump` and admin work from your machine;
   - the **pooled** string (host contains `-pooler`), used as `DATABASE_URL` on Vercel.

   Neon's pooled endpoint is PgBouncer in transaction mode. Neon's connection-pooling docs list schema migrations as a direct-connection task, and session-level `SET` is not supported through the pooler.
3. **Migrate from your machine with the direct URL** (migrations never run during a build, so a preview cannot change the production schema). Take a backup first:
   `pg_dump '<direct neon url>' > before-migrate.sql` (skip on the very first, empty database)
   `DATABASE_URL='<direct neon url>' npm run db:migrate` (PowerShell: `$env:DATABASE_URL='<direct neon url>'; npm run db:migrate`)
   Migrations keep the connect timeout but run with no statement limit.
4. **Model artifact.** `ml/models/brandml.joblib` is committed (about 430 KB) because Vercel's filesystem is read-only. Retraining on Vercel is refused with a clear message; retrain locally with `DATABASE_URL` pointing at Neon so reviewer labels are included, commit the new file and redeploy. scikit-learn is pinned to the version that trained it.
5. **Python bundle size: measured.** The first real build (2026-10-13) made `api/ml.py` **533 MB**, over Vercel's 500 MB Python limit. It deploys with the project env var `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, which turns on Vercel's large-functions beta (up to 5 GB, no extra plan needed; build log: "enabling large functions (beta)"). The dependency list is in the root `requirements.txt` because Vercel's Python bundler cannot follow a `-r` include; `ml/requirements.txt` includes it.
6. **Python version: verify.** `.python-version` asks for 3.12 and CI uses 3.12; local development here used 3.13. Check the runtime Vercel picks in the first build log.

**On Hobby:** the cron runs once a day, so `SCHEDULER_CADENCE_MINUTES` stays 1440 (360 if you enable `rescan.yml`) and scans between runs happen only when someone presses Scan. See *Scheduling and scan frequency* above for the capacity this gives. Function duration limits on Hobby may be lower than the 300 s in `vercel.json`: **verify** in the first build. Alerts are off (no `ALERT_WEBHOOK_URL`).

## Database timeouts and the Neon pooler

Both database clients set explicit limits that also work through a transaction-mode pooler:

| Setting | Default | Node API (`server/db.js`) | Python worker (`ml/brandml/jobs.py`) |
| --- | --- | --- | --- |
| `DATABASE_CONNECT_TIMEOUT_MS` | 8000 | pool `connectionTimeoutMillis` | libpq `connect_timeout` (rounded up to whole seconds, minimum 2) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30000 (0 = off) | `SET LOCAL statement_timeout` in every `transaction()`, plus a client-side `query_timeout` of the limit + 5 s on every query | `set_config('statement_timeout', …, true)` at the start of every transaction |

- Neither sends `statement_timeout` as a connection startup parameter, and neither uses session `SET`, because the pooler may refuse or leak them. A transaction-local setting ends at `COMMIT`/`ROLLBACK`.
- A statement that hits the server limit is cancelled (`57014 query_canceled`) and its transaction rolled back. In the worker, a failed scan is requeued and retried as before, then marked failed after `SCAN_MAX_ATTEMPTS`.
- Node queries outside an explicit transaction have only the client-side limit. The client gives up and the pool discards that connection, but the server may finish the statement. If you want a server-side backstop for those too, run `ALTER ROLE <app role> SET statement_timeout = '35s'` on the direct connection. This is optional and not done by any script.
- **Prepared statements:** psycopg prepares a statement on the server after it repeats 5 times on one connection (a scan's findings upsert does). Neon's docs say its PgBouncer supports protocol-level prepared statements (PgBouncer 1.22+, `max_prepared_statements=1000`), so they are left on. **Verify** on the first preview: a live scan must persist through the pooled URL. Only if it fails with a prepared-statement error, pass `prepare_threshold=None` in `jobs.connect`.
- Neon's free plan suspends idle computes. The first connection after a pause wakes it, and how long that takes on your project is unmeasured. Raise `DATABASE_CONNECT_TIMEOUT_MS` if the first request after idle fails with a connect timeout.

## Environment variables (Project Settings > Environment Variables)

Set for Production (and Preview only if previews should have their own database).

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** connection string (`-pooler` host). Never the direct one here; that is for migrations only |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `APP_ORIGIN` | `https://<your-project>.vercel.app` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin; delete `ADMIN_PASSWORD` after the first sign-in |
| `ML_SERVICE_URL` | `https://<your-project>.vercel.app/api/ml` |
| `ML_SERVICE_SECRET` | `openssl rand -hex 32` |
| `WORKER_SECRET` | `openssl rand -hex 32` |
| `CRON_SECRET` | `openssl rand -hex 32` (Vercel Cron sends it as a bearer token) |
| `NODE_ENV` | `production` |
| optional | `ALERT_WEBHOOK_URL`, `BRAVE_SEARCH_API_KEY` or `SERPAPI_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `APIDIRECT_API_KEY`, and the gated sources in `.env.example` |
| optional tuning | `CRON_MAX_JOBS` (3), `WORKER_BUDGET_SECONDS` (240), `WORKER_MIN_REMAINING_SECONDS` (90), `SCHEDULER_CADENCE_MINUTES` (1440 on Vercel), `DATABASE_CONNECT_TIMEOUT_MS` (8000), `DATABASE_STATEMENT_TIMEOUT_MS` (30000) |

**YouTube quota.** The collector makes one `search.list` call per query, up to `MAX_QUERIES_PER_SOURCE` (4) per scan. `PREDEPLOY_AUDIT.md` reports that Google's quota page (read 2026-10-12, not re-checked here) gives `search.list` a default of 100 calls a day. The older wording, 10,000 units a day at 100 units per search, also gives 100 searches. Either way that is about **25 YouTube scans a day** per Google Cloud project. Past it the source reports an error for the rest of the day. The in-app description in `ml/brandml/sources/social.py` still uses the older units wording.

**API Direct quota.** `APIDIRECT_API_KEY` turns on four sources (`apidirect_x`, `apidirect_instagram`, `apidirect_threads`, `apidirect_facebook`), each calling one account-search endpoint once per scan. API Direct's pricing page (read 2026-10-13) gives 50 free requests per endpoint per month with no card, then $0.006 to $0.008 per request once a payment method is added. That is about **50 scans a month** with all four on. When the free tier is used up the source reports `rate_limited` until the 1st of the month. Scheduled rescans of several brands use it up faster, so turn these sources off for brands that do not need them.

Mark every secret as Sensitive. Never put them in `vercel.json`, the repository or build logs.

## Checked locally before any deploy

- `vercel.json` is tested (`tests/scripts.test.js`): both functions exist, the ML rewrite comes before the API catch-all, `/api` never falls through to the SPA, the CSP has no third-party hosts, and the model file is in `includeFiles`. Done+tested.
- The Python entry `api/ml.py` mounts the ML app at `/api/ml`: `/api/ml/health` answers 200 and `/api/ml/scan` without the secret answers 401 (checked with an in-process client). Done+tested locally. Whether Vercel passes the original path through the rewrite is **Untested**.
- Production build, secret scan, `npm audit`, and a production-mode stack with a browser walkthrough run in `npm run release:gate`. Done+tested locally. None of it ran on Vercel.

## Things to verify on the first preview

- [ ] Build succeeds and both functions are created (`api/index.js`, `api/ml.py`).
- [ ] `GET /api/health` returns `database: ok`, `ml: ok`.
- [ ] The `/api/ml/(.*)` rewrite reaches FastAPI with the original path (the app is mounted at `/api/ml`).
- [ ] Deployment Protection: API-to-ML calls go over public HTTPS. With protection on, either deploy to production only or add a protection bypass for the ML path.
- [ ] Sign in, add the demo brand, run a scan; findings appear and the evaluation shows 16 of 16.
- [ ] Create a live brand and scan it; each source shows a real status (no sandbox proxy there, so App Store, Google Play, Bluesky, Mastodon, DNS and crt.sh should answer).
- [ ] Cold start time of the Python function, and whether the first scan fits in 300 s.
- [ ] `GET /api/internal/cron` without the secret returns 401; Vercel's cron run shows 200 in the logs.
- [ ] Response headers include the CSP, HSTS and `nosniff` from `vercel.json`.

## Not suitable for serverless

- Long scans with every paid source on and large domain permutation lists. Keep `DOMAIN_MAX_PERMUTATIONS`, `MAX_PAGE_CHECKS` and `MAX_QUERIES_PER_SOURCE` at their defaults, or move the worker to an always-on host (needs approval; likely paid).
- Retraining (read-only filesystem). Done locally, as above.
- Google Play scraping from Vercel IP ranges may be throttled more often than from a home connection. The source reports `unavailable` when it happens.
