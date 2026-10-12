const BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()}` : '';
  let response;
  try {
    response = await fetch(`${BASE}${path}${qs}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the SignalGuard API. Check that the server is running.', 0);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  // A 401 anywhere except the sign-in form means the session ended; the app returns to the sign-in screen.
  if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('sg:signed-out'));
  if (!response.ok) throw new ApiError(data.error || `Request failed (HTTP ${response.status})`, response.status, data);
  return data;
}

export const downloadUrl = (path, query) => `${BASE}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
