"""SignalGuard ML service: search, retrieval, ranking and the scan worker endpoint.

    uvicorn service:app --app-dir ml --port 8000

Everything except /health is internal: when ML_SERVICE_SECRET is set, callers
must send it as `Authorization: Bearer <secret>`. The Node API is the only
intended caller; browsers never talk to this service directly.
"""
import hmac
import os
import sys
import threading
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from brandml.envfile import load_env  # noqa: E402


load_env(ROOT.parent / '.env')

from brandml import jobs  # noqa: E402
from brandml.features import BrandContext  # noqa: E402
from brandml.pipeline import MODEL_PATH, Engine  # noqa: E402
from brandml.sources import registry  # noqa: E402
from brandml.text import compact  # noqa: E402
from brandml import domain_proof  # noqa: E402
from brandml.validation import validate  # noqa: E402

if not MODEL_PATH.exists():
    import train
    train.main()

engine = Engine()
lock = threading.Lock()
app = FastAPI(title='SignalGuard ML', version='3.0', docs_url=None, redoc_url=None, openapi_url=None)


def _matches(token, *names):
    secrets = [os.getenv(n) or '' for n in names]
    return any(secret and hmac.compare_digest(token.encode(), secret.encode()) for secret in secrets)


def is_production():
    return bool(os.getenv('VERCEL') or os.getenv('NODE_ENV') == 'production' or os.getenv('ENVIRONMENT') == 'production')


def authorized(authorization):
    secret = os.getenv('ML_SERVICE_SECRET')
    if not secret:
        return not is_production()  # no secret is allowed for local development only
    return _matches(authorization.removeprefix('Bearer ').strip(), 'ML_SERVICE_SECRET')


def internal(authorization: str = Header(default='')):
    if is_production() and not os.getenv('ML_SERVICE_SECRET'):
        raise HTTPException(503, 'ML_SERVICE_SECRET must be set in production')
    if not authorized(authorization):
        raise HTTPException(401, 'Unauthorized')


def worker_auth(authorization: str = Header(default='')):
    token = authorization.removeprefix('Bearer ').strip()
    if not (os.getenv('WORKER_SECRET') or os.getenv('CRON_SECRET')):
        raise HTTPException(503, 'Set WORKER_SECRET (or CRON_SECRET) to enable the worker endpoint')
    if not token or not _matches(token, 'WORKER_SECRET', 'CRON_SECRET'):
        raise HTTPException(401, 'Unauthorized')


class Brand(BaseModel):
    model_config = {'extra': 'allow'}
    name: str = Field(min_length=1, max_length=120)


class ScanRequest(BaseModel):
    brand: Brand
    mode: str = Field(default='live', pattern='^(live|demo)$')
    sources: list[str] | None = Field(default=None, max_length=40)


class ScoreRequest(BaseModel):
    brand: Brand
    candidate: dict


class LookalikeRequest(BaseModel):
    brand: Brand
    names: list[str] = Field(default_factory=list, max_length=50)
    type: str = Field(default='social', pattern='^(social|app|domain)$')


@app.get('/health')
def health(authorization: str = Header(default='')):
    """Status only for the public. Model metrics and the source catalogue need the service secret."""
    if not authorized(authorization):
        return {'status': 'ok'}
    from brandml.sources.demo import demo_brands
    return {'status': 'ok', 'model': engine.version, 'metrics': engine.metrics, 'sources': registry.describe_all(), 'demoBrands': demo_brands(),
            'alerts': {'configured': bool(os.getenv('ALERT_WEBHOOK_URL'))}}


@app.post('/scan', dependencies=[Depends(internal)])
def scan(req: ScanRequest):
    """Synchronous scan without persistence (used for previews and tests). Persistent scans go through the queue."""
    if req.sources is not None and not req.sources:
        raise HTTPException(400, 'No sources selected')
    return engine.scan(req.brand.model_dump(), mode=req.mode, enabled=set(req.sources) if req.sources is not None else None)


@app.post('/score', dependencies=[Depends(internal)])
def score(req: ScoreRequest):
    brand = req.brand.model_dump()
    return engine.score(brand, dict(req.candidate), logo_refs=[r for r in [brand.get('logoUrl')] if r])


@app.post('/lookalike', dependencies=[Depends(internal)])
def lookalike(req: LookalikeRequest):
    brand = req.brand.model_dump()
    ctx = BrandContext(brand)
    rows = []
    for name in req.names[:50]:
        name = name[:120]
        if req.type == 'domain':
            cand = {'type': 'domain', 'name': name, 'handle': name.lower(), 'url': f'https://{name.lower()}'}
        else:
            cand = {'type': req.type, 'name': name, 'handle': '', 'description': ''}
        result = engine.score(brand, cand, ctx)
        rows.append({k: result[k] for k in ('name', 'score', 'severity', 'signals', 'reasons', 'probability')})
    return {'results': rows}


@app.post('/validate', dependencies=[Depends(internal)])
def validate_brand(payload: dict):
    return validate(payload.get('brand', payload), live=payload.get('live', True))


@app.post('/alerts/test', dependencies=[Depends(internal)])
def alerts_test():
    with jobs.connect() as conn:
        return jobs.send_test_alert(conn)


@app.post('/alerts/{delivery_id}/retry', dependencies=[Depends(internal)])
def alerts_retry(delivery_id: int):
    with jobs.connect() as conn:
        return jobs.retry_alert(conn, delivery_id)


@app.post('/verify-domain', dependencies=[Depends(internal)])
def verify_domain(payload: dict):
    return domain_proof.check(str(payload.get('domain', '')), str(payload.get('token', '')))


@app.post('/features', dependencies=[Depends(internal)])
def features(req: ScoreRequest):
    from brandml.features import extract
    return extract(BrandContext(req.brand.model_dump()), req.candidate)


@app.post('/retrain', dependencies=[Depends(internal)])
def retrain():
    if os.getenv('VERCEL'):
        raise HTTPException(409, 'Retraining needs a writable disk. Run `npm run ml:train` locally (DATABASE_URL set to include reviewer labels), commit ml/models/brandml.joblib and redeploy.')
    import train
    with lock:
        train.main()
        engine.load()
    return {'model': engine.version, 'metrics': engine.metrics}


@app.get('/suggest-profile', dependencies=[Depends(internal)])
def suggest_profile(name: str):
    """Suggest official apps and accounts from live store search. Every item is a guess (trust 'suggested') until a person confirms it."""
    name = name.strip()[:120]
    if not name:
        raise HTTPException(400, 'name is required')
    found, sources = registry.run_collectors({'name': name}, [name], mode='live', enabled={'app_store', 'google_play', 'bluesky'})
    key = compact(name)
    apps: list[dict] = []
    socials: list[dict] = []
    for cand in found:
        publisher = compact(cand.get('publisher') or '')
        if cand['type'] == 'app' and key and publisher.startswith(key) and len(apps) < 4:
            apps.append({'store': cand['platform'], 'name': cand['name'], 'appId': cand['appId'], 'publisher': cand['publisher'], 'iconUrl': cand.get('iconUrl'), 'trust': 'suggested'})
        if cand['type'] == 'social' and key and cand.get('handle', '').lower().lstrip('@').split('.')[0] == key and len(socials) < 2:
            socials.append({'platform': cand['platform'], 'handle': cand['handle'], 'trust': 'suggested'})
    return {'name': name, 'officialApps': apps, 'officialSocials': socials, 'logoUrl': apps[0]['iconUrl'] if apps else None, 'sources': sources}


@app.post('/internal/run', dependencies=[Depends(worker_auth)])
def run_worker(max_jobs: int = 5):
    """Queue due rescans and run queued scans within the platform's time limit. Called by cron or the API."""
    budget = float(os.getenv('WORKER_BUDGET_SECONDS', '240'))
    return jobs.to_json(jobs.run_pending(engine, budget_seconds=budget, max_jobs=max(1, min(max_jobs, 20)), who=('serverless', 'cron')))
