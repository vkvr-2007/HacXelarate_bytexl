// Client for the Python ML service (ml/service.py). There is no fallback scorer:
// if the service is down, callers get a 503 and the UI says so.
export class MlUnavailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    /** @type {number} */
    this.status = 503;
  }
}

export function createMlClient(config) {
  /** @param {string} path @param {{ method?: string, body?: unknown, timeoutMs?: number, secret?: string }} [options] */
  async function call(path, { method = 'GET', body = undefined, timeoutMs = 60000, secret = config.mlSecret } = {}) {
    let response;
    try {
      response = await fetch(`${config.mlUrl}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MlUnavailableError(`The detection service is unreachable (${error.cause?.code || error.name}).`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : `Detection service returned HTTP ${response.status}`), { status: response.status >= 500 ? 502 : response.status });
    }
    return data;
  }

  return {
    health: () => call('/health', { timeoutMs: 4000 }),
    validate: (brand, live) => call('/validate', { method: 'POST', body: { brand, live }, timeoutMs: 30000 }),
    lookalike: (brand, names, type) => call('/lookalike', { method: 'POST', body: { brand, names, type }, timeoutMs: 20000 }),
    features: (brand, candidate) => call('/features', { method: 'POST', body: { brand, candidate }, timeoutMs: 10000 }),
    retrain: () => call('/retrain', { method: 'POST', timeoutMs: 280000 }),
    verifyDomain: (domain, token) => call('/verify-domain', { method: 'POST', body: { domain, token }, timeoutMs: 20000 }),
    testAlert: () => call('/alerts/test', { method: 'POST', timeoutMs: 20000 }),
    retryAlert: (id) => call(`/alerts/${Number(id)}/retry`, { method: 'POST', timeoutMs: 30000 }),
    suggestProfile: (name) => call(`/suggest-profile?name=${encodeURIComponent(name)}`, { timeoutMs: 40000 }),
    runWorker: (maxJobs = 3) => call(`/internal/run?max_jobs=${maxJobs}`, { method: 'POST', timeoutMs: 295000, secret: config.workerSecret || config.cronSecret }),
  };
}
