// Sign-in and accounts: the sign-in screen, Face ID / fingerprint unlock, Account and team
// (#/account), and opening the app once someone is let in.

import * as db from './db.js';
import { $, formatDate, askAction, askConfirm, showDialog, plural } from './ui.js';
import { addNewDefaults } from './issues.js';
import { account, signedInEmail, checkAccount, callApprovals, signedIn, signIn, useEmailLink, setPassword, signOut, cloudReady } from './cloud.js';
import { lockOff, lockOn, unlock, lockSupported, turnLockOn } from './lock.js';
import { screens, setCurrent, setHeader, showView, current, MORE_ICON, showToast, render } from './core.js';
import { reportBug, checkStorage } from './settings.js';
import { lockMissingPrices } from './profiles.js';

screens.account = renderAccount;

// ---------- Account and team ----------
// Signed-in person, their company and its team (#/account). The team and the admin's list
// of companies come from the server, so they need a connection; everything else is kept.

const ROLE_NAMES = { owner: 'Owner', tech: 'Tech' };

export function renderCloudCard() {
  const a = account();
  const c = a && a.company;
  $('#settings-cloud-detail').textContent = [signedInEmail(), c ? `${c.name}${a.role ? ` (${ROLE_NAMES[a.role] || a.role})` : ''}` : ''].filter(Boolean).join(' · ') || 'Sign in, company and team.';
}

$('#settings-cloud').addEventListener('click', () => (location.hash = '#/account'));

async function renderAccount() {
  setCurrent({ kind: 'account', id: '', record: null });
  setHeader({ title: 'Account and team', back: true });
  drawAccount();
  drawLock();
  showView('account');
  if (!navigator.onLine) {
    $('#team-list').replaceChildren();
    $('#team-empty').textContent = 'Connect to the internet to see your team.';
    $('#team-empty').hidden = false;
    return;
  }
  // Fresh details first, then the team.
  await checkAccount().then(drawAccount, () => {});
  if (current.kind !== 'account') return;
  await Promise.all([loadTeam(), loadCompanies()]);
}

function drawAccount() {
  const a = account() || {};
  const c = a.company;
  const owner = a.role === 'owner';
  $('#account-email').textContent = signedInEmail();
  $('#account-role').textContent = [a.name, a.role ? ROLE_NAMES[a.role] || a.role : '', a.admin ? 'Zone Sense admin' : ''].filter(Boolean).join(' · ') || 'Signed in';
  $('#account-company-name').textContent = c ? c.name : 'No company yet';
  $('#account-company-detail').textContent = c
    ? [`Plan: ${c.plan}`, c.status !== 'active' ? c.status : '', owner ? 'Tap to change' : ''].filter(Boolean).join(' · ')
    : 'Checked when you’re online.';
  $('#account-company').disabled = !owner || !c;
  $('#account-from').textContent = c ? c.name : 'your company';
  $('#account-reply').textContent = (c && c.replyTo) || 'whoever sent the proposal';
  $('#team-invite').hidden = !owner;
  $('#admin-box').hidden = !a.admin;
}

async function loadTeam() {
  const a = account() || {};
  const empty = $('#team-empty');
  if (!a.company) {
    $('#team-list').replaceChildren();
    empty.hidden = true;
    return;
  }
  try {
    const { members } = await callApprovals({ action: 'team' });
    drawTeam(members);
  } catch (x) {
    empty.textContent = x.message;
    empty.hidden = false;
  }
}

function drawTeam(members) {
  if (current.kind !== 'account') return;
  const a = account() || {};
  const me = signedInEmail().toLowerCase();
  $('#team-list').replaceChildren(...members.map((m) => {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = '<div class="row-open"><span class="row-text"><span class="row-name"></span><span class="row-detail"></span></span></div>';
    li.querySelector('.row-name').textContent = m.name ? `${m.name} (${m.email})` : m.email;
    li.querySelector('.row-detail').textContent = [
      ROLE_NAMES[m.role] || m.role,
      m.status === 'invited' ? `Invited ${formatDate(m.invitedAt.slice(0, 10))}, hasn’t signed in yet` : m.joinedAt ? `Joined ${formatDate(m.joinedAt.slice(0, 10))}` : '',
    ].filter(Boolean).join(' · ');
    if (a.role === 'owner' && m.email.toLowerCase() !== me) {
      const more = document.createElement('button');
      more.className = 'row-more';
      more.setAttribute('aria-label', `Options for ${m.email}`);
      more.innerHTML = MORE_ICON;
      more.addEventListener('click', () => memberMenu(m));
      li.append(more);
    }
    return li;
  }));
  $('#team-empty').hidden = members.length > 1 || a.role !== 'owner';
  $('#team-empty').textContent = 'Just you so far. Invite your techs so they can use the app.';
}

async function memberMenu(m) {
  const choice = await askAction(m.name || m.email, [
    ...(m.status === 'invited' ? [{ label: 'Send the invite again', value: 'resend' }] : []),
    { label: 'Remove from team', value: 'remove', danger: true },
  ]);
  try {
    if (choice === 'resend') {
      drawTeam((await callApprovals({ action: 'invite', email: m.email })).members);
      showToast(`Sent a new invite to ${m.email}.`, 'ok');
    } else if (choice === 'remove') {
      if (!(await askConfirm('Remove from team?', `${m.email} won’t be able to use Zone Sense for your company any more. Reports already on their phone stay there.`, 'Remove'))) return;
      drawTeam((await callApprovals({ action: 'remove_member', userId: m.userId })).members);
    }
  } catch (x) {
    showToast(x.message);
  }
}

// A small form dialog that stays open and shows the server's answer when something's wrong.
// send() resolves when done or throws to show its message.
async function formDialog(name, submitLabel, busyLabel, send) {
  const dialog = $(`#${name}-dialog`);
  const err = $(`#${name}-error`);
  const button = $(`#${name}-submit`);
  err.hidden = true;
  $(`#${name}-form`).onsubmit = async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = busyLabel;
    err.hidden = true;
    try {
      await send();
      dialog.close('ok');
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = submitLabel;
    }
  };
  return (await showDialog(dialog)) === 'ok';
}

$('#team-invite').addEventListener('click', async () => {
  $('#invite-email').value = '';
  let email = '';
  const ok = await formDialog('invite', 'Send invite', 'Sending…', async () => {
    email = $('#invite-email').value.trim();
    drawTeam((await callApprovals({ action: 'invite', email })).members);
  });
  if (ok) showToast(`Invite sent to ${email}.`, 'ok');
});

$('#account-company').addEventListener('click', async () => {
  const c = (account() || {}).company;
  if (!c) return;
  $('#team-company-name').value = c.name;
  $('#team-company-reply').value = c.replyTo || '';
  const ok = await formDialog('team-company', 'Save', 'Saving…', async () => {
    const name = $('#team-company-name').value.trim();
    await callApprovals({ action: 'update_company', name, replyTo: $('#team-company-reply').value.trim() });
    // Keep the name on reports in step, if it was the same as before.
    const local = await db.getSetting('companyName');
    if (!local || local === c.name) await db.setSetting('companyName', name);
    await checkAccount();
  });
  if (ok && current.kind === 'account') drawAccount();
});

$('#account-signout').addEventListener('click', async () => {
  const text = navigator.onLine
    ? 'Your reports stay on this phone. You’ll need your password to sign back in.'
    : 'You’re offline, and signing back in needs a connection. Your reports stay on this phone.';
  if (!(await askConfirm('Sign out?', text, 'Sign out'))) return;
  signOutHere();
  gateSignIn();
});

async function loadCompanies() {
  if (!(account() || {}).admin) return;
  try {
    const { companies } = await callApprovals({ action: 'companies' });
    if (current.kind !== 'account') return;
    $('#admin-list').replaceChildren(...companies.map((c) => {
      const li = document.createElement('li');
      li.className = 'row';
      li.innerHTML = '<div class="row-open"><span class="row-text"><span class="row-name"></span><span class="row-detail"></span></span></div>';
      li.querySelector('.row-name').textContent = c.name;
      li.querySelector('.row-detail').textContent = [c.owners.join(', ') || 'no owner', plural(c.members, 'person'), c.plan, c.status !== 'active' ? c.status : ''].filter(Boolean).join(' · ');
      return li;
    }));
    $('#admin-empty').hidden = companies.length > 0;
    $('#admin-empty').textContent = 'No companies yet.';
  } catch (x) {
    $('#admin-empty').textContent = x.message;
    $('#admin-empty').hidden = false;
  }
}

$('#admin-add').addEventListener('click', async () => {
  $('#admin-company-name').value = '';
  $('#admin-company-owner').value = '';
  let owner = '';
  const ok = await formDialog('admin-company', 'Add and invite', 'Adding…', async () => {
    owner = $('#admin-company-owner').value.trim();
    await callApprovals({ action: 'create_company', name: $('#admin-company-name').value.trim(), ownerEmail: owner });
  });
  if (!ok) return;
  showToast(`Company added. ${owner} got an email to set up their account.`, 'ok');
  loadCompanies();
});

// ---------- Sign-in screen ----------
// Covers the app until someone on a company's team is signed in. Once they are, the phone
// remembers it, so the app opens without a connection; the server is asked again whenever
// there is one, and the screen comes back if they were removed or signed out.

export let appStarted = false;

function gatePanel(name, error = '') {
  document.body.classList.add('gated');
  $('#gate').hidden = false;
  for (const p of ['signin', 'password', 'company', 'working', 'message', 'lock']) $(`#gate-${p}`).hidden = p !== name;
  $('#gate-error').textContent = error;
  $('#gate-error').hidden = !error;
  $('#gate-error').classList.add('warn');
  const who = name !== 'signin' && signedIn() ? signedInEmail() : '';
  $('#gate-who').textContent = who ? `Signed in as ${who}` : '';
  $('#gate-signout').hidden = !who;
  for (const d of document.querySelectorAll('dialog[open]')) if (d.id !== 'bug-dialog') d.close('cancel');
}

function gateWorking(text) {
  $('#gate-working-text').textContent = text;
  gatePanel('working');
}

export function gateSignIn(error = '', email = '') {
  if (email || !$('#gate-email').value) $('#gate-email').value = email || signedInEmail();
  $('#gate-pass').value = '';
  gatePanel('signin', error);
}

$('#gate-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#gate-signin-btn');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    await signIn($('#gate-email').value.trim(), $('#gate-pass').value);
    await offerLock();
    gateWorking('Checking your account…');
    await checkAndEnter();
  } catch (x) {
    gateSignIn(x.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$('#gate-forgot').addEventListener('click', async () => {
  const email = $('#gate-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return gateSignIn('Type your email above first, then tap “Forgot password?”.');
  try {
    await callApprovals({ action: 'reset', email }, { auth: false });
    gateSignIn(`If ${email} is on a Zone Sense team, an email with a link to choose a new password is on its way.`);
    $('#gate-error').classList.remove('warn');
  } catch (x) {
    gateSignIn(x.message);
  }
});

// The link from an invite or a "forgot password" email.
export async function gateLink(type, token, email) {
  if (!navigator.onLine) return gateSignIn('Connect to the internet, then open the link from your email again.', email);
  gateWorking(type === 'invite' ? 'Opening your invite…' : 'Opening your link…');
  try {
    // Someone else signed in on this phone is signed out first.
    if (signedIn() && signedInEmail().toLowerCase() !== email.toLowerCase()) signOutHere();
    await useEmailLink(type, token);
  } catch (x) {
    return gateSignIn(x.message, email);
  }
  $('#gate-password-text').textContent = type === 'invite'
    ? `Welcome to Zone Sense! Choose a password for ${signedInEmail()}. You'll use it to sign in on any phone.`
    : `Choose a new password for ${signedInEmail()}.`;
  $('#gate-name-box').hidden = type !== 'invite';
  $('#gate-name').required = type === 'invite';
  $('#gate-newpass').value = '';
  gatePanel('password');
}

$('#gate-show').addEventListener('change', (e) => ($('#gate-newpass').type = e.target.checked ? 'text' : 'password'));

$('#gate-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#gate-password-btn');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await setPassword($('#gate-newpass').value, $('#gate-name-box').hidden ? '' : $('#gate-name').value.trim());
    await offerLock();
    gateWorking('Checking your account…');
    await checkAndEnter();
  } catch (x) {
    if (!signedIn()) return gateSignIn(x.message);
    $('#gate-error').textContent = x.message;
    $('#gate-error').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Save and continue';
  }
});

// A Zone Sense admin who isn't on a team yet sets up their own company.
$('#gate-company').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#gate-company-btn');
  button.disabled = true;
  try {
    const name = $('#gate-company-name').value.trim();
    await callApprovals({ action: 'create_company', name, ownerEmail: signedInEmail() });
    if (!(await db.getSetting('companyName'))) await db.setSetting('companyName', name);
    gateWorking('Checking your account…');
    await checkAndEnter();
  } catch (x) {
    $('#gate-error').textContent = x.message;
    $('#gate-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('#gate-retry').addEventListener('click', async () => {
  gateWorking('Checking your account…');
  await checkAndEnter();
});

function signOutHere() {
  lockOff();
  signOut();
}

$('#gate-signout').addEventListener('click', () => {
  signOutHere();
  gateSignIn();
});

// ---------- Face ID / fingerprint ----------
// When it's on, it's asked for when the app is opened after being closed, and once a day
// while it stays open. The time of the last unlock is kept in sessionStorage, which the
// phone clears when the app is closed, so a reload (like an update) doesn't ask again.

const RELOCK_AFTER = 24 * 3600000;
const UNLOCKED = 'wetcheckUnlocked';

function markUnlocked() {
  try {
    sessionStorage.setItem(UNLOCKED, String(Date.now()));
  } catch {}
}
export function needsUnlock() {
  if (!lockOn(signedInEmail())) return false;
  let t = 0;
  try {
    t = Number(sessionStorage.getItem(UNLOCKED)) || 0;
  } catch {}
  return Date.now() - t > RELOCK_AFTER;
}

let afterUnlock = null;
export function gateLock(next) {
  afterUnlock = next;
  gatePanel('lock');
  tryUnlock();
}

async function tryUnlock() {
  try {
    await unlock();
  } catch (x) {
    // Some phones only show the prompt after a tap, so the button is there to try again.
    if (!$('#gate-lock').hidden) {
      $('#gate-error').textContent = x.message;
      $('#gate-error').hidden = false;
    }
    return;
  }
  markUnlocked();
  const next = afterUnlock;
  afterUnlock = null;
  if (next) next();
}

$('#gate-unlock').addEventListener('click', tryUnlock);
$('#gate-lock-password').addEventListener('click', () => {
  if (!navigator.onLine) {
    $('#gate-error').textContent = 'Signing in with your password needs a connection. Unlock with Face ID or fingerprint, or try again once you’re online.';
    $('#gate-error').hidden = false;
    return;
  }
  const email = signedInEmail();
  signOutHere();
  gateSignIn('', email);
});

// Locks again when the app comes back a day after the last unlock, unless something's half
// done in a dialog (a finding being typed, say).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !appStarted || document.body.classList.contains('gated')) return;
  if (!needsUnlock() || document.querySelector('dialog[open]')) return;
  gateLock(() => enter(account()));
});

// Offered once after signing in with a password, on phones that can do it.
async function offerLock() {
  const email = signedInEmail();
  if (!email || lockOn(email) || !(await lockSupported())) return;
  if (!(await askConfirm('Use Face ID or fingerprint?', 'Unlock Zone Sense with Face ID, your fingerprint or your phone’s screen lock instead of typing your password. You can change this in Settings → Account and team.', 'Turn on'))) return;
  try {
    await turnLockOn(email);
    markUnlocked();
  } catch (x) {
    showToast(x.message);
  }
}

async function drawLock() {
  const supported = await lockSupported();
  $('#lock-list').hidden = !supported;
  if (!supported) return;
  const on = lockOn(signedInEmail());
  $('#lock-detail').textContent = on ? 'On: asked for when the app opens after being closed, and once a day.' : 'Off. Turn on to unlock the app without your password.';
  $('#lock-toggle').textContent = on ? 'Turn off' : 'Turn on';
}

$('#lock-toggle').addEventListener('click', async () => {
  if (lockOn(signedInEmail())) lockOff();
  else {
    try {
      await turnLockOn(signedInEmail());
      markUnlocked();
    } catch (x) {
      showToast(x.message);
    }
  }
  drawLock();
});

$('#gate-bug').addEventListener('click', reportBug);

// Opens the app, or shows why it can't, from what's known about this person.
function enter(a) {
  if (a && a.company && a.company.status === 'active') return openApp(a);
  if (a && a.company) {
    $('#gate-message-text').textContent = `${a.company.name}’s Zone Sense account is paused. Contact Zone Sense to turn it back on.`;
    return gatePanel('message');
  }
  if (a && a.admin) {
    $('#gate-company-name').value = '';
    return gatePanel('company');
  }
  if (a) {
    $('#gate-message-text').textContent = `${signedInEmail()} isn’t on a company’s team. Ask your company’s owner to invite you.`;
    return gatePanel('message');
  }
  // Never checked (no connection): let them in and check when there is one.
  openApp(null);
}

async function checkAndEnter() {
  try {
    enter(await checkAccount());
  } catch (x) {
    if (!signedIn()) return gateSignIn(x.status === 401 ? 'Your sign-in has ended. Sign in again.' : x.message);
    // Offline, or the server's having trouble: go by what the phone already knows.
    enter(account());
  }
}

export function openApp(a) {
  // Reports show the company's name if this phone hasn't set one.
  if (a && a.company) db.getSetting('companyName').then((n) => !n && db.setSetting('companyName', a.company.name)).catch(() => {});
  const wasGated = document.body.classList.contains('gated');
  $('#gate').hidden = true;
  document.body.classList.remove('gated');
  if (!appStarted) {
    appStarted = true;
    startApp();
  } else if (wasGated) render();
}

// Checks with the server now and then while the app is open (when there's a connection).
let lastCheck = 0;
async function recheckAccount(force = false) {
  if (!cloudReady || !signedIn() || !navigator.onLine || (!force && Date.now() - lastCheck < 15 * 60000)) return;
  lastCheck = Date.now();
  try {
    enter(await checkAccount());
  } catch {
    // A failed check keeps the app open; a sign-in the server turned down shows the
    // sign-in screen through the "signedout" event instead.
  }
}

window.addEventListener('signedout', () => {
  lockOff();
  gateSignIn('Your sign-in has ended. Sign in again.');
});
window.addEventListener('online', () => recheckAccount());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && recheckAccount());

// Once someone is let in: top up the issue list, then draw the first screen.
function startApp() {
  addNewDefaults()
    .catch(() => {})
    .then(lockMissingPrices)
    .finally(() => {
      render();
      db.storePhotosAsBytes().catch(() => {});
      checkStorage();
    });
}

export function afterSignedIn() {
  const a = account();
  if (a) {
    enter(a);
    recheckAccount(true);
  } else if (!navigator.onLine) {
    openApp(null);
  } else {
    // Signed in from before accounts: find out which company now.
    lastCheck = Date.now();
    gateWorking('Checking your account…');
    checkAndEnter();
  }
}
