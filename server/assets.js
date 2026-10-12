// Official-asset trust. Every declared asset is suggested (guessed by the system), unverified (typed in by a person,
// nothing checked) or confirmed (a person recorded how they confirmed it). Only confirmed assets, and domains with
// proof of control, are hidden from scan results. Demo-brand assets are synthetic and always count as confirmed.
export const socialKey = (a) => `${String(a.platform).toLowerCase()}:${String(a.handle).trim().replace(/^@/, '').toLowerCase()}`;
export const appKey = (a) => `${a.store}:${String(a.appId).trim().toLowerCase()}`;
const fold = (value) => String(value || '').trim().toLowerCase();

/** Merge the submitted list with what is stored: stored trust survives edits, new assets start untrusted. */
/** @param {any[]} stored @param {any[]} submitted @param {(item: any) => string} keyOf @param {{ scopeOf?: (item: any) => string }} [options] */
export function resolveTrust(stored, submitted, keyOf, { scopeOf = (_item) => '' } = {}) {
  const byKey = new Map((stored || []).map((item) => [keyOf(item), item]));
  return submitted.map(({ trust: asked, ...item }) => {
    const prior = byKey.get(keyOf(item));
    if (prior && (prior.trust || 'unverified') !== 'suggested' && fold(scopeOf(prior)) === fold(scopeOf(item))) {
      return { ...item, trust: prior.trust || 'unverified', ...(prior.trust === 'confirmed' ? { confirmedBy: prior.confirmedBy, confirmedAt: prior.confirmedAt, evidence: prior.evidence } : {}) };
    }
    return { ...item, trust: asked === 'suggested' ? 'suggested' : 'unverified' };
  });
}

export const withDefaultTrust = (items) => (items || []).map((item) => ({ ...item, trust: item.trust || 'unverified' }));

/** Declared domains with their proof state. */
export function domainStates(row, proofs = []) {
  const declared = [...new Set([row.domain, ...(row.domains || [])].filter(Boolean))];
  return declared.map((domain) => {
    const proof = proofs.find((p) => p.domain === domain);
    const demo = row.mode === 'demo';
    return {
      domain, primary: domain === row.domain, trust: demo || proof?.verified_at ? 'confirmed' : 'unverified',
      method: demo ? 'demo' : proof?.method || null, verifiedAt: proof?.verified_at || null, challengeStarted: Boolean(proof),
    };
  });
}

const setOf = (list) => new Set(list);
const added = (before, after) => [...after].filter((x) => !before.has(x));

/** What a profile edit changed, for the audit log. Asset ids only, no free text. */
export function diffBrand(row, input) {
  const changed = [];
  for (const [col, key] of [['name', 'name'], ['domain', 'domain'], ['description', 'description'], ['logo_url', 'logoUrl'], ['scan_interval_minutes', 'scanIntervalMinutes']]) {
    if ((row[col] ?? null) !== (input[key] ?? null)) changed.push(key);
  }
  for (const [col, key] of [['aliases', 'aliases'], ['keywords', 'keywords'], ['domains', 'domains'], ['sources', 'sources']]) {
    if (JSON.stringify(row[col] ?? null) !== JSON.stringify(input[key] ?? null)) changed.push(key);
  }
  const assets = {};
  for (const { col, key, keyOf } of [{ col: 'official_socials', key: 'officialSocials', keyOf: socialKey }, { col: 'official_apps', key: 'officialApps', keyOf: appKey }]) {
    const before = setOf((row[col] || []).map(keyOf));
    const after = setOf(input[key].map(keyOf));
    const add = added(before, after);
    const remove = added(after, before);
    if (add.length || remove.length) { assets[key] = { added: add, removed: remove }; changed.push(key); }
  }
  return { changed, assets };
}
