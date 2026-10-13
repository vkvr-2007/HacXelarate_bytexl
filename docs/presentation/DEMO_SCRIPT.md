# OmniScout demo script (about 5 minutes)

Slides: https://claude.ai/artifact/KD3GDLEAQ6uHchTjsLvjTw (private until shared from its Share menu).
App: https://omniscout.vercel.app. Sign in with the production `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

**Before judging (5 min earlier):** open https://omniscout.vercel.app/api/health once. The first call after idle takes about 9 s while the Python function starts. Sign in and keep the tab open.

| Time | Click | What the judges should see |
| --- | --- | --- |
| 0:00 | Slides 1–3 | Problem and the four steps |
| 1:00 | Slides 4–6 | Architecture, source status table, detection signals |
| 2:00 | App: **Add demo brand** (Northstar), then **Scan now** | Scan finishes; findings list with severities. Banner says the data is a demo |
| 2:45 | Open the top **Critical** finding | Risk score, plain-language reasons, source link, timestamps, model version |
| 3:15 | Set its status to **Confirmed**; open another and mark **False positive** | Status changes; finding history records it |
| 3:45 | **Sources** page | Each platform's status: answered, not configured, unsupported, with the reason |
| 4:00 | (If time) live brand "Revolut", **Scan now** | Real accounts from X, Instagram, Threads, Facebook Pages and web results. Official accounts only drop out if confirmed in the brand profile |
| 4:45 | Slide 8 (honest status), slide 9 | Close |

## Fallback plan

- **Live scan slow or a provider fails:** say so, open the Sources page to show the failure is reported, and continue with the demo brand. Each API Direct platform allows 50 free requests a month; do not run the live scan more than a few times.
- **Site cold or down:** run locally (`npm run dev`, then http://localhost:5173) if Docker/Postgres works; otherwise present the slides plus the earlier screenshots attached in the project thread (`3-finding-detail.png`, `6-scan-history-live.png`; not in this repo).
- **Sign-in fails:** check `ADMIN_PASSWORD` in Vercel env (Project Settings > Environment Variables). The first admin is created only when the database has no users.

## Honest claims (each backed by a check on 13 Oct 2026)

- Deployed on Vercel + Neon; `/api/health` returned database ok and ML ok; cron endpoint returns 401 without its secret and 200 when Vercel runs it.
- Live search for "Revolut" returned X 20, Instagram 50, Threads 10, Facebook Pages 7 (API Direct) and 31 web results (SerpApi).
- Local tests passed with mocked external services: 131 JS (API and web) and 185 Python (ML, collectors, worker). Mocks are not live verification.
- Official assets marked confirmed are excluded before scoring; unverified ones never hide a result.
- The classifier is a scikit-learn gradient-boosted model trained on synthetic data. There is no real-world accuracy number; scores are risk estimates.

## Not claimed

- Native X, Instagram/Facebook Graph and Threads APIs (need approval or payment). TikTok, LinkedIn, Telegram: unsupported.
- App Store, Google Play, Bluesky, Mastodon, DNS and crt.sh collectors are built and unit-tested but were not re-checked live on 13 Oct.
- Google sign-in: removed; email and password only.
