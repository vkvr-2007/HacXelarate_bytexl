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

There is no long-running worker on Vercel. Scans run when the dashboard calls `/api/scans/:id/run`, or when cron calls `/api/internal/cron`; each call runs as many queued scans as fit in `WORKER_BUDGET_SECONDS` (240 s), under the 300 s function limit. A scan that outlives its function is reclaimed after `SCAN_STALE_MINUTES` and retried up to 3 times.

## Before the first deploy

1. **Vercel plan.** Decision: Hobby (chosen by Vaarsh, no alerts). Hobby is free but for non-commercial use only and allows one cron run a day. Commercial use needs the paid Pro plan (check current pricing on vercel.com/pricing). Decide before deploying.
2. **Neon.** Create a project, copy the pooled connection string (it includes `sslmode=require`).
3. **Migrate from your machine** (migrations never run during a build, so a preview cannot change the production schema):
   `DATABASE_URL='<neon url>' npm run db:migrate`
4. **Model artifact.** `ml/models/brandml.joblib` is committed (about 430 KB) because Vercel's filesystem is read-only. Retraining on Vercel is refused with a clear message; retrain locally with `DATABASE_URL` pointing at Neon so reviewer labels are included, commit the new file and redeploy. scikit-learn is pinned to the version that trained it.
5. **Python bundle size: verify.** A local install of `ml/requirements.txt` is about 343 MB unpacked, measured with pandas included (scipy 138 MB, numpy 56 MB, scikit-learn 46 MB, pillow 20 MB); pandas (40 MB) is not a dependency and would not be bundled. Vercel allows 500 MB for Python functions, so it should fit, but the real number is only known after a preview build. If it does not fit, the fallback is to host the ML service elsewhere, which may cost money and needs your approval first.
6. **Python version: verify.** `.python-version` asks for 3.12 and CI uses 3.12; local development here used 3.13. Check the runtime Vercel picks in the first build log.

**On Hobby:** the cron runs once a day, so `SCHEDULER_CADENCE_MINUTES` stays 1440 and scans between runs happen only when someone presses Scan. Function duration limits on Hobby may be lower than the 300 s in `vercel.json`: **verify** in the first build. Alerts are off (no `ALERT_WEBHOOK_URL`).

## Environment variables (Project Settings > Environment Variables)

Set for Production (and Preview only if previews should have their own database).

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon pooled connection string |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `APP_ORIGIN` | `https://<your-project>.vercel.app` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first admin; delete `ADMIN_PASSWORD` after the first sign-in |
| `ML_SERVICE_URL` | `https://<your-project>.vercel.app/api/ml` |
| `ML_SERVICE_SECRET` | `openssl rand -hex 32` |
| `WORKER_SECRET` | `openssl rand -hex 32` |
| `CRON_SECRET` | `openssl rand -hex 32` (Vercel Cron sends it as a bearer token) |
| `NODE_ENV` | `production` |
| optional | `ALERT_WEBHOOK_URL`, `BRAVE_SEARCH_API_KEY` or `SERPAPI_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and the gated sources in `.env.example` |

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
