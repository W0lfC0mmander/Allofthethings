// Shared by every screen: routing, the header, list rows, the error banner and the
// "file ready" dialog. Screens register themselves in `screens` so render() can draw them.

import * as db from './db.js';
import { $, showDialog } from './ui.js';

// Shown on the home screen so it's easy to tell which version a phone is running.
// Keep in step with VERSION in sw.js.
export const APP_VERSION = 67;

// ---------- Error banner ----------
// Shows problems on screen instead of failing silently.

let toastTimer = null;
export function showToast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('ok', kind === 'ok');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 8000);
}
// The last few errors go along with a bug report.
export const recentErrors = [];
function noteError(msg) {
  recentErrors.push(`${new Date().toISOString()} ${location.hash || '#/'} ${msg}`);
  if (recentErrors.length > 10) recentErrors.shift();
}
window.addEventListener('error', (e) => {
  noteError(`${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`);
  showToast(`Something went wrong: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  noteError(String((r && (r.stack || r.message)) || r).slice(0, 500));
  showToast(`Something went wrong: ${(r && r.message) || r}`);
});

export const FOLDER_ICON = '<svg class="ico folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
export const REPORT_ICON = '<svg class="ico report" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 1.5V9h4.5M8 13h8M8 16.5h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
export const CONTROLLER_ICON = '<svg class="ico report" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm3 4h8v4H8zM8 15.5h1.5M11.25 15.5h1.5M14.5 15.5H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
export const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

// ---------- Routing ----------
// #/            top-level folders
// #/f/<id>      a folder
// #/r/<id>      a report
// #/settings    settings: company, issues and prices, backup
// #/approvals   approvals and work: proposals sent, approved, in progress, done
// #/account     account and team: sign out, company, invite techs
// #/issues      the issue list and prices
// #/p/<id>      a property's profile (contact, disclaimer, its own issues and prices)
// #/search      search everything; #/search/<folder id> searches inside one folder
// Using the URL hash means the phone's back button works.

function route() {
  if (location.hash === '#/issues') return { kind: 'issues', id: '' };
  if (location.hash === '#/settings') return { kind: 'settings', id: '' };
  if (location.hash === '#/approvals') return { kind: 'approvals', id: '' };
  if (location.hash === '#/account') return { kind: 'account', id: '' };
  const s = location.hash.match(/^#\/search(?:\/(.+))?$/);
  if (s) return { kind: 'search', id: s[1] ? decodeURIComponent(s[1]) : '' };
  const p = location.hash.match(/^#\/p\/(.+)$/);
  if (p) return { kind: 'profile', id: decodeURIComponent(p[1]) };
  const m = location.hash.match(/^#\/([fr])\/(.+)$/);
  if (!m) return { kind: 'folder', id: db.ROOT };
  return { kind: m[1] === 'r' ? 'report' : 'folder', id: decodeURIComponent(m[2]) };
}

export const folderHref = (id) => (id === db.ROOT ? '#/' : `#/f/${encodeURIComponent(id)}`);
export const reportHref = (id) => `#/r/${encodeURIComponent(id)}`;
export const profileHref = (id) => `#/p/${encodeURIComponent(id)}`;

export let current = null; // what's on screen: { kind, id, record }
let lastScreen = '';
export const setCurrent = (c) => (current = c);

// Each screen's file adds its draw function here (screens.report = renderReport), so this
// file doesn't need to import the screens and they can all import it.
export const screens = {};

export async function render() {
  const r = route();
  await screens[r.kind](r.id);
  // Start at the top when moving to a different screen, but not when refreshing the same one.
  const screen = `${r.kind}:${r.id}`;
  if (screen !== lastScreen) $('main').scrollTo(0, 0);
  lastScreen = screen;
}

export function setHeader({ title, subtitle = '', crumbs = [], back = false, more = false, settings = false, search = false }) {
  $('#settings-btn').hidden = !settings;
  $('#search-btn').hidden = !search;
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#subtitle').hidden = !subtitle;
  $('#brand-title').hidden = title !== 'Properties';
  $('#back').hidden = !back;
  $('#bar-logo').hidden = back || title !== 'Properties';
  $('#header-more').hidden = !more;
  document.title = title === 'Properties' ? 'Zone Sense' : `${title} · Zone Sense`;
  const nav = $('#crumbs');
  nav.replaceChildren();
  nav.hidden = crumbs.length === 0;
  for (const c of crumbs) {
    const a = document.createElement('a');
    a.href = c.href;
    a.textContent = c.name;
    nav.append(a, document.createTextNode(' › '));
  }
}

export function crumbsFor(path) {
  return [{ name: 'Properties', href: '#/' }, ...path.map((f) => ({ name: f.name, href: folderHref(f.id) }))];
}

// A list row: icon, name and detail linking to href, with an optional button and ⋮ menu.
export function row({ icon, name, detail, href, menuLabel, onMenu, action }) {
  const li = document.createElement('li');
  li.className = 'row';
  const a = document.createElement('a');
  a.className = 'row-open';
  a.href = href;
  a.innerHTML = icon;
  const text = document.createElement('span');
  text.className = 'row-text';
  const n = document.createElement('span');
  n.className = 'row-name';
  n.textContent = name;
  text.append(n);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'row-detail';
    d.textContent = detail;
    text.append(d);
  }
  a.append(text);
  li.append(a);
  if (action) {
    const b = document.createElement('button');
    b.className = 'row-action';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    li.append(b);
  }
  if (onMenu) {
    const more = document.createElement('button');
    more.className = 'row-more';
    more.setAttribute('aria-label', menuLabel);
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', onMenu);
    li.append(more);
  }
  return li;
}

// ---------- File ready dialog ----------

let fileUrl = null;

// Shows the "file ready" dialog: build() makes the file while a working message shows,
// then phones get Share (save to Files, email, text) and others get Download.
export async function deliverFile({ working, workingText, ready, failed, canOpen = false, build }) {
  const dialog = $('#pdf-dialog');
  const share = $('#pdf-share');
  const download = $('#pdf-download');
  const open = $('#pdf-open');
  $('#pdf-title').textContent = working;
  $('#pdf-text').textContent = workingText;
  share.hidden = download.hidden = open.hidden = true;
  const closed = showDialog(dialog);

  try {
    const { blob, name, detail } = await build();
    const file = new File([blob], name, { type: blob.type });
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(blob);
    download.href = open.href = fileUrl;
    download.download = name;

    $('#pdf-title').textContent = ready;
    const size = blob.size > 1024 * 1024 ? `${(blob.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
    $('#pdf-text').textContent = `${name} (${size})${detail ? `. ${detail}` : ''}`;
    // Android's Chrome only shares some file types (PDFs and photos, not .zip backups), so
    // Download is always offered too, and a share that fails falls back to downloading.
    let canShare = false;
    try {
      canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch {
      canShare = false;
    }
    share.hidden = !canShare;
    download.hidden = false;
    download.classList.toggle('primary', !canShare);
    download.classList.toggle('outline', canShare);
    download.textContent = canShare ? 'Save' : 'Download';
    open.hidden = !canOpen;
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (!canShare && isAndroid) {
      $('#pdf-text').textContent += ' This phone can’t share this kind of file directly: tap Download, then share it from the Files app (Downloads).';
    }
    share.onclick = async () => {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (err) {
        if (err && err.name === 'AbortError') return; // share sheet dismissed
        download.click();
        $('#pdf-text').textContent = `Sharing didn’t open on this phone, so ${name} was downloaded instead. You can share it from the Files app (Downloads).`;
      }
    };
  } catch (err) {
    $('#pdf-title').textContent = failed;
    $('#pdf-text').textContent = err && err.message ? err.message : 'Something went wrong. Try again.';
  }
  await closed;
}

// ---------- Views ----------

export function showView(kind) {
  $('#folder-view').hidden = kind !== 'folder';
  $('#report-view').hidden = kind !== 'report';
  $('#issues-view').hidden = kind !== 'issues';
  $('#settings-view').hidden = kind !== 'settings';
  $('#profile-view').hidden = kind !== 'profile';
  $('#search-view').hidden = kind !== 'search';
  $('#approvals-view').hidden = kind !== 'approvals';
  $('#account-view').hidden = kind !== 'account';
  $('#fab').hidden = kind !== 'folder';
  document.body.classList.toggle('in-report', kind === 'report');
}
