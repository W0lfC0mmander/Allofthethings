// Sign-in, the signed-in person's company, and calls to the "approvals" Edge Function
// (supabase/functions/approvals). The sign-in is kept in localStorage, not IndexedDB, so it
// never ends up in a backup.
//
// The app needs a sign-in, but it's used in the field without a connection, so once signed
// in it stays signed in: the session and the company are kept on the phone and only checked
// with the server when there's a connection. Only the server saying the sign-in is no good
// any more signs the phone out; a bad connection never does.

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

// Tells the app the server turned the sign-in down, so it can show the sign-in screen.
function signedOutByServer() {
  save(null);
  window.dispatchEvent(new Event('signedout'));
}

export const signedInEmail = () => (load() || {}).email || '';
export const signedIn = () => !!(load() || {}).refresh;
// What the server last said about this person: { company, role, admin }, or null if it
// hasn't been asked yet.
export const account = () => (load() || {}).account || null;

const offline = () => new Error('No connection. Try again when you’re online.');

async function authFetch(path, { method = 'POST', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${base}/auth/v1/${path}`, {
      method,
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw offline();
  }
  const data = await res.json().catch(() => ({}));
  return { res, data, msg: data.error_description || data.msg || data.message || '' };
}

function keep(data, email) {
  const prev = load() || {};
  const s = {
    email: data.user ? data.user.email : email,
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in || 3600) * 1000,
    // A different person signing in on this phone starts fresh.
    account: prev.email === (data.user ? data.user.email : email) ? prev.account : null,
  };
  save(s);
  return s;
}

export async function signIn(email, password) {
  const { res, data, msg } = await authFetch('token?grant_type=password', { body: { email, password } });
  if (!res.ok) throw new Error(/invalid login/i.test(msg) ? 'That email and password don’t match.' : msg || 'Couldn’t sign in.');
  keep(data, email);
}

// The link in an invite or "reset password" email: ?invite=<token> or ?recovery=<token>.
// Trades the token for a sign-in, ready to choose a password.
export async function useEmailLink(type, tokenHash) {
  const { res, data, msg } = await authFetch('verify', { body: { type, token_hash: tokenHash } });
  if (!res.ok || !data.access_token) {
    throw new Error(/expired|invalid/i.test(msg) || res.status === 403
      ? 'This link has expired or was already used. Ask for a new invite, or tap “Forgot password?”.'
      : msg || 'This link didn’t work.');
  }
  keep(data, data.user && data.user.email);
}

export async function setPassword(password, name) {
  const token = await accessToken();
  const { res, msg } = await authFetch('user', { method: 'PUT', token, body: { password, ...(name ? { data: { name } } : {}) } });
  if (!res.ok) throw new Error(/weak|short|characters/i.test(msg) ? `Pick a stronger password. ${msg}` : msg || 'Couldn’t save the password.');
}

export function signOut() {
  const s = load();
  save(null);
  // Ends the session on the server too, when there's a connection. Not waited for.
  if (s && s.access) fetch(`${base}/auth/v1/logout`, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.access}` } }).catch(() => {});
}

async function accessToken() {
  let s = load();
  if (!s) throw new Error('Sign in first.');
  if (Date.now() > s.expires - 60000) {
    const { res, data, msg } = await authFetch('token?grant_type=refresh_token', { body: { refresh_token: s.refresh } });
    if (!res.ok) {
      // 400 means the sign-in was ended (signed out elsewhere, removed from the team...).
      if (res.status === 400 || res.status === 401 || res.status === 403) signedOutByServer();
      throw new Error(res.status === 400 ? 'Your sign-in has ended. Sign in again.' : msg || `Couldn’t reach the server (${res.status}).`);
    }
    s = keep(data, s.email);
  }
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
    throw offline();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth) signedOutByServer();
    const err = new Error(data.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Asks the server who this is and which company they're on, and keeps the answer.
export async function checkAccount() {
  const a = await callApprovals({ action: 'me' });
  const s = load();
  if (s) save({ ...s, account: { company: a.company, role: a.role, admin: !!a.admin, name: a.user.name || '', checkedAt: Date.now() } });
  return account();
}
