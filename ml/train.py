"""Train the retriever and the impersonation ranker.

    python ml/train.py

Writes ml/models/brandml.joblib and ml/models/metrics.json. Analyst feedback
(the ml_feedback table, written when an analyst confirms or dismisses a live
finding) is folded into training only when enough decisions of both kinds
exist. Demo decisions are never used.
"""
import json
import os
import random
import sys
from collections import defaultdict
from datetime import datetime, UTC
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import GroupShuffleSplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from brandml import synth  # noqa: E402
from brandml.features import FEATURE_NAMES  # noqa: E402
from brandml.retriever import Retriever, retrieval_text  # noqa: E402

MODEL_PATH = ROOT / 'models' / 'brandml.joblib'
METRICS_PATH = ROOT / 'models' / 'metrics.json'
THRESHOLD = 0.5


MIN_FEEDBACK_PER_CLASS = int(os.getenv('MIN_FEEDBACK_PER_CLASS', '10'))
FEEDBACK_WEIGHT = 3.0


def load_feedback():
    """Eligible reviewer decisions from ml_feedback: live findings only, with a known origin.

    Demo decisions and rows of unknown origin are never used. Feedback is also ignored until at least
    MIN_FEEDBACK_PER_CLASS rows exist for both classes, because a handful of clicks can swing a model
    in the wrong direction. Returns (X, y, report) where report says what was used or why not."""
    X: list[list[float]] = []
    y: list[int] = []
    skipped: dict[str, int] = {}
    report: dict = {'eligible': 0, 'skipped': skipped, 'used': False}
    if not os.getenv('DATABASE_URL'):
        report['reason'] = 'DATABASE_URL is not set'
        return X, y, report
    import psycopg
    with psycopg.connect(os.environ['DATABASE_URL']) as conn:
        rows = conn.execute('SELECT features, label, mode FROM ml_feedback').fetchall()
    for features, label, mode in rows:
        if mode != 'live':
            key = 'demo' if mode == 'demo' else 'unknown origin'
            skipped[key] = skipped.get(key, 0) + 1
            continue
        try:
            X.append([float(features[name]) for name in FEATURE_NAMES])
            y.append(int(label))
        except (KeyError, TypeError, ValueError):
            skipped['malformed'] = skipped.get('malformed', 0) + 1
    report['eligible'] = len(y)
    positives = sum(y)
    if min(positives, len(y) - positives) < MIN_FEEDBACK_PER_CLASS:
        report['reason'] = f'needs at least {MIN_FEEDBACK_PER_CLASS} confirmed and {MIN_FEEDBACK_PER_CLASS} dismissed live decisions (has {positives} and {len(y) - positives})'
        return [], [], report
    report['used'] = True
    return X, y, report


def retriever_corpus():
    rng = random.Random(3)
    texts = []
    for brand in synth.BRANDS:
        texts.append(retrieval_text(brand))
        for _ in range(6):
            name, _ = synth.positive_name(rng, brand, rng.choice(list(synth.SECTORS)))
            texts.append(retrieval_text(name, synth.make_handle(rng, name)))
    texts += [retrieval_text(n) for n in synth.UNRELATED_NAMES]
    return texts


def make_model():
    return GradientBoostingClassifier(n_estimators=250, max_depth=3, learning_rate=0.08, subsample=0.9, random_state=11)


def main():
    X, y, groups, techniques = synth.generate()
    X, y = np.array(X), np.array(y)
    techniques = np.array(techniques)

    split = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=5)
    train_idx, test_idx = next(split.split(X, y, groups))
    model = make_model().fit(X[train_idx], y[train_idx])
    proba = model.predict_proba(X[test_idx])[:, 1]
    pred = (proba >= THRESHOLD).astype(int)

    by_technique: defaultdict[str, list[int]] = defaultdict(lambda: [0, 0])
    for technique, truth, guess in zip(techniques[test_idx], y[test_idx], pred, strict=False):
        by_technique[technique][0] += int(guess == truth)
        by_technique[technique][1] += 1

    metrics: dict = {
        'trainedAt': datetime.now(UTC).isoformat(timespec='seconds'),
        'evaluation': 'Held-out brands (20% of brands never seen in training)',
        'trainRows': int(len(train_idx)),
        'testRows': int(len(test_idx)),
        'precision': round(float(precision_score(y[test_idx], pred)), 4),
        'recall': round(float(recall_score(y[test_idx], pred)), 4),
        'f1': round(float(f1_score(y[test_idx], pred)), 4),
        'rocAuc': round(float(roc_auc_score(y[test_idx], proba)), 4),
        'accuracyByTechnique': {k: round(v[0] / v[1], 3) for k, v in sorted(by_technique.items())},
    }

    fb_X, fb_y, fb_report = load_feedback()
    full_X, full_y = X, y
    weights = np.ones(len(y))
    if fb_X:
        full_X = np.vstack([X, np.array(fb_X)])
        full_y = np.concatenate([y, np.array(fb_y)])
        weights = np.concatenate([weights, np.full(len(fb_y), FEEDBACK_WEIGHT)])
    final = make_model().fit(full_X, full_y, sample_weight=weights)
    metrics['feedbackRows'] = len(fb_y)
    metrics['feedback'] = fb_report
    metrics['evaluationNote'] = 'Precision, recall and F1 are measured on synthetic data from held-out brands before any reviewer feedback is added. They are not accuracy on real impersonation, and the demo brand is never trained on.'
    metrics['featureImportance'] = {
        name: round(float(score), 4)
        for name, score in sorted(zip(FEATURE_NAMES, final.feature_importances_, strict=False), key=lambda p: -p[1])[:10]
    }

    retriever = Retriever().fit(retriever_corpus())
    version = 'brandml-gbm-' + metrics['trainedAt'][:10].replace('-', '')
    metrics['version'] = version

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({'model': final, 'features': FEATURE_NAMES, 'vectorizer': retriever.vectorizer,
                 'threshold': THRESHOLD, 'version': version, 'metrics': metrics}, MODEL_PATH)
    METRICS_PATH.write_text(json.dumps(metrics, indent=2), encoding='utf-8')
    print(json.dumps({k: metrics[k] for k in ('version', 'precision', 'recall', 'f1', 'rocAuc', 'trainRows', 'testRows', 'feedbackRows')}, indent=2))
    print('accuracy by technique:', json.dumps(metrics['accuracyByTechnique']))


if __name__ == '__main__':
    main()
