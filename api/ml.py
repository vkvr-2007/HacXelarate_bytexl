"""Vercel entry point for the Python ML service, served under /api/ml."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'ml'
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402

import service  # noqa: E402

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount('/api/ml', service.app)
