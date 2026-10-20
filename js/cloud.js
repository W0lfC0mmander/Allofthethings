// Sign-in and calls to the "approvals" Edge Function (supabase/functions/approvals).
// The sign-in is kept in localStorage, not IndexedDB, so it never ends up in a backup.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const KEY = 'wetcheckCloud';
export const cloudReady = !!(SUPABASE_URL && SUPABASE_KEY);
const base = SUPABASE_URL.replace(/\/+$/, '');

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
function save(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {}
}

export const signedInEmail = () => (load() || {}).email || '';

async function authRequest(grant, body) {
  let res;
  try {
    res = await fetch(`${base}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No connection. Try again when you’re online.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (grant === 'refresh_token') save(null);
    const msg = data.error_description || data.msg || data.message || '';
    throw new Error(/invalid login/i.test(msg) ? 'That email and password don’t match.' : msg || 'Couldn’t sign in.');
  }
  const s = {
    email: data.user ? data.user.email : body.email,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in || 3600) * 1000,
  };
  save(s);
  return s;
}

export async function signIn(email, password) {
  await authRequest('password', { email, password });
}

export function signOut() {
  save(null);
}

async function accessToken() {
  let s = load();
  if (!s) throw new Error('Sign in under Settings → Online approvals first.');
  if (Date.now() > s.expires - 60000) s = await authRequest('refresh_token', { refresh_token: s.refresh });
  return s.access;
}

// body: a FormData (send) or an object with an action. Resolves with the JSON answer.
export async function callApprovals(body, { auth = true } = {}) {
  const headers = { apikey: SUPABASE_KEY };
  if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${base}/functions/v1/approvals`, {
      method: 'POST',
      headers,
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error('No connection. Try again when you’re online.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) save(null);
    throw new Error(data.error || `Something went wrong (${res.status}).`);
  }
  return data;
}
