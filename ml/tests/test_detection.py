import pytest
from conftest import NORTHSTAR

from brandml.text import skeleton

PAYPAL = {'name': 'PayPal', 'domain': 'paypal.com', 'description': 'Send money and pay online.', 'officialApps': [{'publisher': 'PayPal, Inc.'}]}


def name_score(engine, brand, name):
    return engine.score(brand, {'type': 'social', 'name': name, 'handle': '', 'description': ''})['score']


def test_skeleton_folds_homoglyphs_and_leet():
    assert skeleton('Northstɑr') == skeleton('northstar')
    assert skeleton('N0rth-Star') == skeleton('northstar')
    assert skeleton('PаyPal') == skeleton('paypal')  # Cyrillic а


@pytest.mark.parametrize('name', ['Pay Pal', 'pay_pal', 'PayPla', 'Paypa1', 'PаyPal', 'PayPal Support', 'PayPal Official Giveaway', 'PaypalRewards'])
def test_lookalike_variants_are_flagged(engine, name):
    assert name_score(engine, PAYPAL, name) >= 55


@pytest.mark.parametrize('name', ['Paypal Fan Club', 'Payroll Plus', 'Pay Palace Hotel', 'Peppa Pig', 'Paybox', 'Morning Brew Coffee'])
def test_normal_names_are_not_flagged(engine, name):
    assert name_score(engine, PAYPAL, name) < 55


def test_official_assets_are_excluded_not_scored(engine):
    result = engine.scan(NORTHSTAR, mode='demo')
    excluded = {item['name'] for item in result['excluded']}
    assert {'Northstar: Money, made clear', 'Northstar Business'} <= excluded
    flagged = {(d['platform'], d['externalId']) for d in result['detections']}
    assert ('Instagram', '@northstar') not in flagged
    assert result['evaluation']['officialFlagged'] == 0


def test_seeded_world_precision_and_recall(engine):
    evaluation = engine.scan(NORTHSTAR, mode='demo')['evaluation']
    assert evaluation['recall'] >= 0.9
    assert evaluation['precision'] >= 0.9


def test_reviewer_allowlist_suppresses_a_finding(engine):
    brand = {**NORTHSTAR, 'allowlist': [{'externalId': 'com.northstarlite.money'}]}
    result = engine.scan(brand, mode='demo')
    assert 'com.northstarlite.money' not in {d['externalId'] for d in result['detections']}


def test_findings_carry_readable_reasons(engine):
    detection = next(d for d in engine.scan(NORTHSTAR, mode='demo')['detections'] if d['name'] == 'Northstɑr Finance')
    assert any('look-alike Unicode' in reason for reason in detection['reasons'])
    assert detection['logoSimilarity'] >= 0.8


def test_demo_findings_carry_evidence(engine):
    detection = engine.scan(NORTHSTAR, mode='demo')['detections'][0]
    evidence = detection['evidence']
    assert evidence['mode'] == 'demo' and evidence['source'] == 'demo'
    assert evidence['modelVersion'] == engine.version and evidence['scoredAt']


def test_live_scan_never_uses_demo_data(engine):
    result = engine.scan(NORTHSTAR, mode='live', enabled={'demo', 'bluesky'})
    statuses = {s['key']: s for s in result['sources']}
    assert statuses['demo']['status'] == 'disabled'
    assert statuses['bluesky']['status'] == 'unavailable'  # network is off in tests
    assert result['detections'] == [] and result['evaluation'] is None
    assert not any(d.get('demo') for d in result['detections'])


def test_demo_scan_never_calls_live_sources(engine, fake_http):
    calls = fake_http(lambda method, url, kw: (_ for _ in ()).throw(AssertionError(f'live call to {url}')))
    result = engine.scan(NORTHSTAR, mode='demo')
    assert calls == []
    live = [s for s in result['sources'] if s['mode'] == 'live']
    assert live and all(s['status'] == 'disabled' for s in live)


def test_demo_brands_are_never_part_of_training_data():
    """The demo benchmark is only meaningful if the model has not seen the demo brand."""
    from brandml import synth
    from brandml.sources.demo import demo_brands
    names = {key.lower() for key in demo_brands()}
    assert names, 'no demo brands found'
    trained_on = {b.lower() for b in synth.BRANDS} | {n.lower() for n in synth.UNRELATED_NAMES}
    assert not names & trained_on
    _, _, groups, _ = synth.generate()
    assert not names & {g.lower() for g in groups}
