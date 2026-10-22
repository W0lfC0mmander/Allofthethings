// Settings (#/settings): company logo and color, technician signature, backup and restore,
// storage, issues and prices (#/issues), and Report a bug.

import * as db from './db.js';
import { $, showDialog, today, plural, askConfirm, askAction, askName } from './ui.js';
import { compressLogo, compressPhoto } from './photo.js';
import { loadIssueList, saveIssueList, formatMoney, toPrice, findIssue, resetIssueList } from './issues.js';
import { DEFAULT_ACCENT } from './pdf.js';
import { createBackup, readBackup, restoreBackup } from './backup.js';
import { drawSignature } from './signature.js';
import { signedInEmail, account, cloudReady, callApprovals } from './cloud.js';
import { formatTime } from './location.js';
import { screens, setCurrent, setHeader, APP_VERSION, showView, render, recentErrors, showToast, deliverFile, MORE_ICON } from './core.js';
import { reportPdf } from './reports.js';
import { renderDisclaimerCard, lockMissingPrices } from './profiles.js';
import { renderCloudCard } from './accounts.js';

screens.settings = renderSettings;
screens.issues = renderIssues;

// ---------- Settings screen ----------

let companyLogoUrl = null;

async function renderSettings() {
  setCurrent({ kind: 'settings', id: '', record: null });
  setHeader({ title: 'Settings', back: true });
  await Promise.all([renderCompanyCard(), renderIssuesCard(), renderDisclaimerCard(), renderSignatureCard(), renderCloudCard(), renderBackupCard(false), renderStorageCard()]);
  $('#settings-version').textContent = `App version ${APP_VERSION}`;
  showView('settings');
}

$('#settings-btn').addEventListener('click', () => (location.hash = '#/settings'));

async function renderCompanyCard() {
  const card = $('#company-card');
  card.hidden = false;
  const [logo, name] = await Promise.all([db.getSetting('companyLogo'), db.getSetting('companyName')]);
  if (companyLogoUrl) URL.revokeObjectURL(companyLogoUrl);
  companyLogoUrl = logo ? URL.createObjectURL(logo) : null;
  const img = $('#company-card-img');
  img.hidden = !logo;
  if (logo) img.src = companyLogoUrl;
  else img.removeAttribute('src');
  $('#company-logo-box').classList.toggle('empty', !logo);
  $('#company-card-name').textContent = name || (logo ? 'Company logo' : 'Add your company logo');
}

async function editCompany() {
  let logo = await db.getSetting('companyLogo');
  $('#company-name').value = (await db.getSetting('companyName')) || '';
  const img = $('#logo-img');
  let url = null;
  const show = () => {
    if (url) URL.revokeObjectURL(url);
    url = logo ? URL.createObjectURL(logo) : null;
    img.hidden = !logo;
    if (logo) img.src = url;
    $('#logo-empty').hidden = !!logo;
    $('#logo-remove').hidden = !logo;
  };
  show();
  $('#logo-error').hidden = true;
  $('#logo-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      logo = await compressLogo(file);
      $('#logo-error').hidden = true;
      show();
    } catch {
      $('#logo-error').textContent = 'That image couldn’t be read. Try another one.';
      $('#logo-error').hidden = false;
    }
  };
  $('#logo-remove').onclick = () => {
    logo = null;
    show();
  };
  let accent = (await db.getSetting('accentColor')) || DEFAULT_ACCENT;
  renderSwatches(accent, (c) => (accent = c));
  const result = await showDialog($('#company-dialog'));
  if (url) URL.revokeObjectURL(url);
  if (result !== 'ok') return;
  await db.setSetting('companyLogo', logo);
  await db.setSetting('companyName', $('#company-name').value.trim());
  await db.setSetting('accentColor', accent);
  render();
}

$('#company-card').addEventListener('click', editCompany);

const ACCENT_PRESETS = [
  ['Blue', DEFAULT_ACCENT],
  ['Navy', '#1b2a4a'],
  ['Teal', '#0e7490'],
  ['Green', '#2e7d32'],
  ['Red', '#b3261e'],
  ['Orange', '#d9730d'],
  ['Charcoal', '#3c4043'],
];

// Preset color dots plus a "Custom" picker for any brand color.
function renderSwatches(selected, onPick) {
  const box = $('#accent-swatches');
  const make = (name, hex) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = hex;
    b.title = name;
    b.setAttribute('aria-label', name);
    b.dataset.hex = hex;
    b.addEventListener('click', () => pick(hex));
    return b;
  };
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Custom color';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = selected;
  input.addEventListener('input', () => pick(input.value));
  custom.append(input);
  const pick = (hex) => {
    selected = hex.toLowerCase();
    onPick(selected);
    for (const el of box.querySelectorAll('.swatch')) {
      el.classList.toggle('on', el.dataset.hex === selected || (el === custom && !ACCENT_PRESETS.some(([, h]) => h === selected)));
    }
    custom.style.background = ACCENT_PRESETS.some(([, h]) => h === selected) ? '' : selected;
  };
  box.replaceChildren(...ACCENT_PRESETS.map(([n, h]) => make(n, h)), custom);
  pick(selected);
}

// ---------- Report a bug ----------
// Emailed to the Zone Sense team through the approvals function (no sign-in needed), with
// the app version, device and recent errors. Without a connection it opens a mail draft.

const BUG_EMAIL = 'djimenez@zonesenseirrigation.com';

async function bugInfo() {
  const info = {
    'App version': APP_VERSION,
    Screen: location.hash || '#/',
    Device: navigator.userAgent,
    'Screen size': `${screen.width}×${screen.height} (window ${innerWidth}×${innerHeight}, ×${devicePixelRatio})`,
    Installed: matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'yes' : 'no',
    Language: navigator.language,
    'Signed in as': signedInEmail() || 'not signed in',
    Company: ((account() || {}).company || {}).name || 'unknown',
    Time: new Date().toString(),
  };
  try {
    const { usage, quota } = await navigator.storage.estimate();
    info.Storage = `${(usage / 1048576).toFixed(1)} MB used of ${(quota / 1048576).toFixed(0)} MB`;
  } catch {}
  if (recentErrors.length) info['Recent errors'] = recentErrors.join('\n');
  return info;
}

function bugMailto(text, info) {
  const lines = Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = `${text}\n\n----\n${lines}`.slice(0, 1800);
  return `mailto:${BUG_EMAIL}?subject=${encodeURIComponent('Zone Sense bug report')}&body=${encodeURIComponent(body)}`;
}

$('#settings-bug').addEventListener('click', reportBug);

export async function reportBug() {
  const dialog = $('#bug-dialog');
  const err = $('#bug-error');
  const img = $('#bug-shot-img');
  let shot = null;
  const showShot = () => {
    if (img.src) URL.revokeObjectURL(img.src);
    img.hidden = !shot;
    img.src = shot ? URL.createObjectURL(shot) : '';
    $('#bug-shot-label').textContent = shot ? 'Change' : 'Add screenshot';
    $('#bug-shot-remove').hidden = !shot;
  };
  err.hidden = true;
  $('#bug-text').value = '';
  if (!$('#bug-email').value) $('#bug-email').value = signedInEmail();
  showShot();
  $('#bug-shot-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      shot = await compressPhoto(file);
      showShot();
    } catch {
      showToast('That picture couldn’t be read. Try another one.');
    }
  };
  $('#bug-shot-remove').onclick = () => {
    shot = null;
    showShot();
  };
  $('#bug-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#bug-text').value.trim();
    if (!text) return;
    const info = await bugInfo();
    const button = $('#bug-submit');
    button.disabled = true;
    button.textContent = 'Sending…';
    err.hidden = true;
    try {
      if (!cloudReady || !navigator.onLine) throw new Error('offline');
      const form = new FormData();
      form.append('action', 'bug');
      form.append('meta', JSON.stringify({ description: text, email: $('#bug-email').value.trim(), info }));
      if (shot) form.append('screenshot', shot, 'screenshot.jpg');
      await callApprovals(form, { auth: false });
      dialog.close('ok');
      showToast('Thanks! Your bug report was sent.', 'ok');
    } catch (x) {
      if (x.message === 'offline' || /No connection/.test(x.message)) {
        // Mail drafts can't carry the screenshot, so say so.
        dialog.close('ok');
        location.href = bugMailto(text, info);
        showToast(shot ? 'You’re offline, so a mail draft opened. Attach the screenshot to it before sending.' : 'You’re offline, so a mail draft opened. Send it when you’re back online.', 'ok');
      } else {
        err.textContent = `${x.message} You can also email ${BUG_EMAIL}.`;
        err.hidden = false;
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Send';
    }
  };
  await showDialog(dialog);
  shot = null;
  showShot();
}

// Asks who to send to, confirms the technician signature, then sends the report's PDF.
// ---------- Signature ----------
// Settings hold the default: 'signatureImage' (PNG Blob), 'signatureName', 'signatureRole',
// 'signatureEnabled'. A report keeps what it was signed with: report.signature
// { off, name, role, date } and report.signatureImage (kept top-level so db.put copies the Blob).

export async function defaultSignature() {
  const [image, name, role, on] = await Promise.all(['signatureImage', 'signatureName', 'signatureRole', 'signatureEnabled'].map((k) => db.getSetting(k)));
  return { on: !!on, image: image instanceof Blob ? image : null, name: name || '', role: role || '' };
}

export async function signatureFor(report) {
  if (report.signature) {
    const s = report.signature;
    return s.off || (!report.signatureImage && !s.name) ? null : { image: report.signatureImage || null, name: s.name, role: s.role, date: s.date || report.date };
  }
  const def = await defaultSignature();
  return def.on && (def.image || def.name) ? { image: def.image, name: def.name, role: def.role, date: report.date } : null;
}

let signatureUrl = null;
function showSignatureImage(img, empty, blob) {
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  delete img.dataset.url;
  img.hidden = !blob;
  if (blob) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  } else img.removeAttribute('src');
  if (empty) empty.hidden = !!blob;
}

// mode 'settings' edits the default; mode 'report' signs one report before export.
// Resolves with { on, image, name, role, date } or null if cancelled.
export async function askSignature({ mode, on, image, name, role, date = today(), defaults = null, submitLabel = 'Export PDF' }) {
  const forReport = mode === 'report';
  $('#signature-title').textContent = forReport ? 'Sign this report' : 'Technician signature';
  $('#signature-hint').textContent = forReport
    ? 'Changes here apply to this report only. Your default signature is set in Settings.'
    : 'Your default signature. Before each export you can sign again or change it for that report.';
  $('#signature-enabled-label').textContent = forReport ? 'Include a signature on this report' : 'Sign reports when exporting';
  $('#signature-submit').textContent = forReport ? submitLabel : 'Save';
  $('#signature-date-box').hidden = !forReport;
  const hasDefault = !!(defaults && (defaults.image || defaults.name));
  $('#signature-default').hidden = !forReport || !hasDefault;

  const box = $('#signature-enabled');
  const show = () => {
    showSignatureImage($('#signature-img'), $('#signature-empty'), image);
    $('#signature-clear').disabled = !image;
    $('#signature-sign').textContent = image ? 'Re-sign' : 'Sign';
  };
  const showFields = () => ($('#signature-fields').hidden = !box.checked);
  box.checked = on;
  box.onchange = showFields;
  $('#signature-name').value = name;
  $('#signature-role').value = role;
  $('#signature-date').value = date;
  const sign = async () => {
    const drawn = await drawSignature({ name: $('#signature-name').value.trim() });
    if (drawn === undefined) return;
    image = drawn;
    show();
  };
  $('#signature-preview').onclick = sign;
  $('#signature-sign').onclick = sign;
  $('#signature-clear').onclick = () => {
    image = null;
    show();
  };
  $('#signature-default').onclick = () => {
    image = defaults.image;
    $('#signature-name').value = defaults.name;
    $('#signature-role').value = defaults.role;
    box.checked = true;
    showFields();
    show();
  };
  show();
  showFields();
  const result = await showDialog($('#signature-dialog'));
  showSignatureImage($('#signature-img'), null, null);
  if (result !== 'ok') return null;
  return {
    on: box.checked,
    image,
    name: $('#signature-name').value.trim(),
    role: $('#signature-role').value.trim(),
    date: $('#signature-date').value || today(),
  };
}

async function renderSignatureCard() {
  const def = await defaultSignature();
  const set = def.image || def.name;
  $('#settings-signature-name').textContent = `Technician signature: ${def.on ? 'on' : 'off'}`;
  $('#settings-signature-detail').textContent = !set
    ? 'Set up the signature for your exported reports.'
    : [def.name, def.role].filter(Boolean).join(', ') || 'Signature saved';
  if (signatureUrl) URL.revokeObjectURL(signatureUrl);
  signatureUrl = def.image ? URL.createObjectURL(def.image) : null;
  const img = $('#settings-signature-img');
  img.hidden = !def.image;
  if (def.image) img.src = signatureUrl;
  else img.removeAttribute('src');
}

$('#settings-signature').addEventListener('click', async () => {
  const def = await defaultSignature();
  const first = !def.image && !def.name;
  const r = await askSignature({ mode: 'settings', on: first ? true : def.on, image: def.image, name: def.name, role: def.role });
  if (!r) return;
  await Promise.all([
    db.setSetting('signatureEnabled', r.on),
    db.setSetting('signatureImage', r.image),
    db.setSetting('signatureName', r.name),
    db.setSetting('signatureRole', r.role),
  ]);
  renderSignatureCard();
  showToast('Signature saved.', 'ok');
});

// ---------- Backup and restore ----------

const countsText = (c) => [plural(c.folders, 'folder'), plural(c.reports, 'report'), plural(c.findings, 'finding')].join(', ');

// The home screen keeps a backup reminder card; Settings has the same entry.
export async function renderBackupCard(show) {
  $('#backup-card').hidden = !show;
  const last = await db.getSetting('lastBackupAt');
  for (const detail of [$('#backup-card-detail'), $('#settings-backup-detail')]) {
    detail.textContent = last ? `Last backup: ${formatTime(last)}` : 'Last backup: never. Tap to back up.';
    // Nudge when it's been more than a week.
    detail.classList.toggle('warn', !last || Date.now() - last > 7 * 24 * 3600 * 1000);
  }
}

export function backUp(folder = null) {
  return deliverFile({
    working: 'Making backup…',
    workingText: 'Packing up your reports, PDFs and photos.',
    ready: 'Backup ready',
    failed: 'Couldn’t make the backup',
    build: async () => {
      const { blob, name, counts, pdfsFailed } = await createBackup(APP_VERSION, folder ? folder.id : null, {
        makePdf: reportPdf,
        issueList: await loadIssueList(),
        progress: (text) => ($('#pdf-text').textContent = `Packing up your reports, PDFs and photos. ${text}`),
      });
      const missing = pdfsFailed ? ` ${plural(pdfsFailed, 'PDF')} couldn’t be made and ${pdfsFailed === 1 ? 'was' : 'were'} left out.` : '';
      return { blob, name, detail: `Includes ${countsText(counts)}.${missing} Save it somewhere safe, like Files, iCloud Drive or Google Drive. Open it there to see it as a folder.` };
    },
  }).then(() => render());
}

// ---------- Storage ----------
// Warns before the phone runs out of room for photos: at 80% of what the browser allows,
// or when less than about 300 MB (some 500 photos) is left.

const DEFAULT_PHOTO = 600 * 1024; // a typical compressed finding photo, until there are real ones to measure
const LOW_FREE = 300 * 1024 * 1024;
const storageLow = (s) => s && (s.usage / s.quota >= 0.8 || s.free < LOW_FREE);

function sizeText(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Room left, counted in photos the size of the ones already saved on this phone.
async function storageText(s) {
  const photos = Math.floor(s.free / ((await db.averagePhotoBytes()) || DEFAULT_PHOTO));
  return `Using ${sizeText(s.usage)} of ${sizeText(s.quota)}. Room for about ${photos.toLocaleString()} more photos.`;
}

async function renderStorageCard() {
  const s = await db.storageStatus();
  const detail = $('#settings-storage-detail');
  detail.textContent = s ? await storageText(s) : 'This phone doesn’t say how much room is left. Tap to test it.';
  detail.classList.toggle('warn', storageLow(s));
}

$('#settings-storage').addEventListener('click', () => (location.href = './storage-test.html'));

// Checked when the app opens and after photos are saved; shown at most every 10 minutes.
let storageWarnedAt = 0;
export async function checkStorage() {
  if (Date.now() - storageWarnedAt < 10 * 60 * 1000) return;
  const s = await db.storageStatus();
  if (!storageLow(s)) return;
  storageWarnedAt = Date.now();
  showToast(`Phone storage is getting full. ${await storageText(s)} Make a backup and delete old reports to free up space.`);
}

async function openBackupDialog() {
  const last = await db.getSetting('lastBackupAt');
  $('#backup-last').textContent = last ? `Last full backup: ${formatTime(last)}` : 'No full backup made on this device yet.';
  showDialog($('#backup-dialog'));
}
$('#backup-card').addEventListener('click', openBackupDialog);
$('#settings-backup-card').addEventListener('click', openBackupDialog);

$('#backup-all').addEventListener('click', () => {
  $('#backup-dialog').close('cancel');
  backUp();
});

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#backup-dialog').close('cancel');
  let backup;
  try {
    backup = await readBackup(file);
  } catch (err) {
    await askConfirm('Can’t restore', err.message, 'OK');
    return;
  }
  const what = backup.kind === 'property' ? `the property “${backup.name}”` : 'a full backup';
  const when = backup.exportedAt ? ` from ${formatTime(backup.exportedAt)}` : '';
  const actions = [{ label: 'Add to this device', value: 'merge' }];
  if (backup.kind !== 'property') actions.push({ label: 'Replace everything on this device', value: 'replace', danger: true });
  const choice = await askAction(`This file has ${what}${when}: ${countsText(backup.counts)}.`, actions);
  if (!choice) return;
  if (choice === 'replace') {
    const ok = await askConfirm(
      'Replace everything?',
      'Everything on this device will be deleted and replaced with the backup. Anything not in the backup will be lost. This can’t be undone.',
      'Replace'
    );
    if (!ok) return;
  }
  await restoreBackup(backup, { replace: choice === 'replace' });
  await lockMissingPrices();
  location.hash = '#/';
  await render();
  showToast(`Restored ${countsText(backup.counts)}.`, 'ok');
});

// Report name, date, estimate, and which of the property's controllers it covers. A new
// report asks for a controller when the property has any; "Whole property" covers them all.
// ---------- Issues and prices ----------

async function renderIssuesCard() {
  $('#issues-card').hidden = false;
  const list = await loadIssueList();
  const all = list.groups.flatMap((g) => g.issues);
  const on = all.filter((i) => !i.off).length;
  const priced = all.filter((i) => i.price != null).length;
  $('#issues-card-detail').textContent = `${plural(on, 'issue')} in use, ${priced} priced. Tap to edit.`;
}

$('#issues-card').addEventListener('click', () => (location.hash = '#/issues'));

let issueList = null; // what the issues screen is showing

async function renderIssues() {
  setCurrent({ kind: 'issues', id: '', record: null });
  setHeader({ title: 'Issues and prices', back: true });
  issueList = await loadIssueList();
  $('#issue-groups').replaceChildren(...issueList.groups.map((g) => {
    const section = document.createElement('section');
    const head = document.createElement('div');
    head.className = 'group-head';
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = g.name || 'Issues';
    const more = document.createElement('button');
    more.className = 'row-more';
    more.setAttribute('aria-label', `Options for ${g.name || 'this group'}`);
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', () => groupMenu(g));
    head.append(h, more);

    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.issues.map((issue) => issueRow(g, issue)));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small outline add-issue';
    add.textContent = '+ Add issue';
    add.addEventListener('click', () => addIssue(g));
    section.append(head, ul, add);
    return section;
  }));
  showView('issues');
}

function issueRow(group, issue) {
  const li = document.createElement('li');
  li.className = 'issue-row' + (issue.off ? ' off' : '');
  const toggle = document.createElement('label');
  toggle.className = 'issue-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !issue.off;
  box.setAttribute('aria-label', `Use ${issue.name}`);
  box.addEventListener('change', async () => {
    issue.off = !box.checked;
    li.classList.toggle('off', issue.off);
    await saveIssueList(issueList);
  });
  toggle.append(box);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'issue-main';
  const name = document.createElement('span');
  name.className = 'issue-name';
  name.textContent = issue.name;
  const price = document.createElement('span');
  price.className = 'issue-price' + (issue.price == null ? ' none' : '');
  price.textContent = issue.price == null ? 'No price' : formatMoney(issue.price);
  main.append(name, price);
  main.addEventListener('click', () => editIssue(group, issue));
  li.append(toggle, main);
  return li;
}

// Name and price dialog. Resolves with { name, price }, 'delete', or null.
// Resolves with { name, price }, 'delete', 'reset', or null.
// opts: list (for duplicate names), nameLocked, canDelete, canReset, mainHint, renameHint.
export async function askIssue(title, issue, opts = {}) {
  const { list = issueList, nameLocked = false, canDelete = !!issue, canReset = false, mainHint = '', renameHint = !!issue } = opts;
  $('#issue-dialog-title').textContent = title;
  $('#issue-name').value = issue ? issue.name : '';
  $('#issue-name').readOnly = nameLocked;
  $('#issue-price').value = issue && issue.price != null ? issue.price.toFixed(2) : '';
  $('#issue-delete').hidden = !canDelete;
  $('#issue-reset').hidden = !canReset;
  $('#issue-rename-hint').hidden = !renameHint;
  $('#issue-main-hint').hidden = !mainHint;
  $('#issue-main-hint').textContent = mainHint;
  const err = $('#issue-error');
  err.hidden = true;
  $('#issue-delete').onclick = () => $('#issue-dialog').close('delete');
  $('#issue-reset').onclick = () => $('#issue-dialog').close('reset');
  for (;;) {
    const result = await showDialog($('#issue-dialog'));
    if (result === 'delete' || result === 'reset') return result;
    if (result !== 'ok') return null;
    const name = $('#issue-name').value.trim();
    const rawPrice = $('#issue-price').value.trim();
    const price = toPrice(rawPrice);
    const taken = findIssue(list, name);
    let problem = '';
    if (!name) problem = 'Give the issue a name.';
    else if (taken && taken !== issue) problem = 'That issue is already on the list.';
    else if (rawPrice && price == null) problem = 'Enter the price as a number, like 45 or 45.50.';
    if (!problem) return { name, price };
    err.textContent = problem;
    err.hidden = false;
  }
}

async function editIssue(group, issue) {
  const r = await askIssue('Edit issue', issue);
  if (!r) return;
  if (r === 'delete') {
    const ok = await askConfirm('Delete issue', `Remove “${issue.name}” from the list? Findings already saved with it keep it. To just hide it, turn it off instead.`);
    if (!ok) return;
    group.issues.splice(group.issues.indexOf(issue), 1);
  } else {
    const from = issue.name;
    Object.assign(issue, r);
    if (from !== r.name) await db.renameIssue(from, r.name);
  }
  await saveIssueList(issueList);
  render();
}

async function addIssue(group) {
  const r = await askIssue(`Add to ${group.name || 'the list'}`, null);
  if (!r || r === 'delete') return;
  group.issues.push({ ...r, off: false });
  await saveIssueList(issueList);
  render();
}

async function groupMenu(group) {
  const action = await askAction(group.name || 'Issues', [
    { label: 'Rename group', value: 'rename' },
    { label: 'Delete group', value: 'delete', danger: true },
  ]);
  if (action === 'rename') {
    const name = await askName('Rename group', 'Save', group.name, { placeholder: 'Group name' });
    if (!name) return;
    group.name = name;
  } else if (action === 'delete') {
    const n = group.issues.length;
    const text = `Delete “${group.name || 'this group'}”${n ? ` and its ${plural(n, 'issue')}` : ''}? Findings already saved keep their issue.`;
    if (!(await askConfirm('Delete group', text))) return;
    issueList.groups.splice(issueList.groups.indexOf(group), 1);
  } else return;
  await saveIssueList(issueList);
  render();
}

$('#add-group').addEventListener('click', async () => {
  const name = await askName('New group', 'Create', '', { placeholder: 'Group name, like Lighting' });
  if (!name) return;
  issueList.groups.push({ name, issues: [] });
  await saveIssueList(issueList);
  await render();
  $('main').scrollTo(0, $('main').scrollHeight);
});

$('#reset-issues').addEventListener('click', async () => {
  const ok = await askConfirm(
    'Reset issue list',
    'Go back to the starting issue list? Your added issues, name changes, on/off choices and all prices will be removed. Findings already saved keep their issue.',
    'Reset'
  );
  if (!ok) return;
  await resetIssueList();
  render();
});
