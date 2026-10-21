// Starts the app: loads every screen, wires the back button and the service worker, then
// shows the sign-in screen or opens the app.

import * as db from './db.js';
import { $ } from './ui.js';
import { cloudReady, signedIn } from './cloud.js';
import { current, folderHref, render } from './core.js';
import './folders.js';
import './reports.js';
import './approvals.js';
import './settings.js';
import './profiles.js';
import { appStarted, gateLink, openApp, gateSignIn, needsUnlock, gateLock, afterSignedIn } from './accounts.js';

// ---------- No zooming ----------
// The app is laid out for a phone screen, so pinch and double-tap zoom are turned off.
// Android follows the viewport meta; iPhone ignores it, so stop its gesture events here.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) e.preventDefault();
  },
  { passive: false }
);
// Double-tap zoom is off through touch-action in styles.css, so quick repeat taps still work.

// ---------- Wiring ----------

// Screens visited in this session, so the on-screen back arrow can step back through
// history (like the phone's back button) instead of stacking up new entries.
const visited = [location.hash || '#/'];
window.addEventListener('hashchange', () => {
  const h = location.hash || '#/';
  if (visited[visited.length - 2] === h) visited.pop();
  else visited.push(h);
});

$('#back').addEventListener('click', () => {
  // Issues and prices opens from Settings or from a report's estimate, so go back to whichever.
  if (current.kind === 'issues' && visited.length > 1) return history.back();
  // Anything opened from search goes back to the results.
  if (current.kind !== 'search' && (visited[visited.length - 2] || '').startsWith('#/search')) return history.back();
  // Search opens from any folder, so go back to where it was opened.
  if (current.kind === 'search') return visited.length > 1 ? history.back() : (location.hash = folderHref(current.id || db.ROOT));
  const parent = current.kind === 'profile'
    ? folderHref(current.id)
    : current.kind === 'issues'
    ? '#/settings'
    : current.kind === 'settings'
    ? '#/'
    : current.kind === 'account'
    ? '#/settings'
    : current.kind === 'report'
    ? folderHref(current.record.folderId)
    : folderHref(current.record ? current.record.parentId : db.ROOT);
  if (visited[visited.length - 2] === parent) history.back();
  else location.hash = parent;
});
window.addEventListener('hashchange', () => appStarted && render());

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

if ('serviceWorker' in navigator) {
  // When an update takes over, reload once so the page and its scripts are the same version.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js');
}
// Sign-in first. An invite or password link in the address opens its screen; otherwise
// someone already signed in goes straight in, even offline.
(function boot() {
  const params = new URLSearchParams(location.search);
  const type = ['invite', 'recovery'].find((t) => params.has(t));
  if (type) {
    history.replaceState(null, '', location.pathname + location.hash);
    return gateLink(type, params.get(type), params.get('email') || '');
  }
  if (!cloudReady) return openApp(null);
  if (!signedIn()) return gateSignIn();
  if (needsUnlock()) return gateLock(afterSignedIn);
  afterSignedIn();
})();
