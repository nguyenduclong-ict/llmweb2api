const BASE_URL = '';

function getHeaders(): Record<string, string> {
  const password = localStorage.getItem('dashboard_password') || '';
  return {
    'Content-Type': 'application/json',
    'X-Dashboard-Password': password,
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: getHeaders() });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_password');
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_password');
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_password');
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (res.status === 401) {
    localStorage.removeItem('dashboard_password');
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

export class AuthError extends Error {
  constructor() {
    super('Unauthorized');
  }
}
