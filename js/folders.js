// The home screen and folders (#/, #/f/<id>): property folders, their reports grouped by
// controller, the property photo, folder and report rows, and search (#/search).

import * as db from './db.js';
import { $, plural, formatDate, zoneName, askConfirm, askAction, askName, today, SECTIONS } from './ui.js';
import { compressPhoto } from './photo.js';
import { priceSnapshot } from './issues.js';
import { screens, setCurrent, setHeader, crumbsFor, APP_VERSION, showView, current, row, FOLDER_ICON, folderHref, REPORT_ICON, reportHref, render, profileHref } from './core.js';
import { setFocusFinding, reportMenu, askReportDetails } from './reports.js';
import { renderApprovalsCard } from './approvals.js';
import { renderBackupCard, backUp } from './settings.js';
import { renderProfileCard, issueListFor } from './profiles.js';

screens.folder = renderFolder;
screens.search = renderSearch;

// ---------- Folder screen ----------

async function renderFolder(id) {
  const path = id === db.ROOT ? [] : await db.getPath(id);
  if (id !== db.ROOT && path.length === 0) return (location.hash = '#/'); // folder no longer exists
  const here = path[path.length - 1] || null;
  setCurrent({ kind: 'folder', id, record: here });

  setHeader({
    title: here ? here.name : 'Properties',
    crumbs: path.length >= 2 ? crumbsFor(path.slice(0, -1)) : [],
    back: !!here,
    settings: !here,
    search: true,
  });
  $('#fab-label').textContent = 'New';

  const [folders, reports] = await Promise.all([db.listChildren(id), here ? db.listReports(id) : []]);
  $('#folder-list').replaceChildren(...folders.map(folderRow));
  renderReportGroups(id, reports);
  $('#folder-empty').hidden = folders.length + reports.length > 0;
  $('#folder-empty').innerHTML = here
    ? 'Nothing here yet. Tap <strong>New</strong> to add a wet check report or a folder.'
    : 'No properties yet. Tap <strong>New</strong> to add a folder for one.';
  await renderBackupCard(!here);
  await renderApprovalsCard(!here);
  renderPropertyPhoto(path.length === 1 ? here : null);
  renderProfileCard(path.length === 1 ? here : null);
  $('#app-version').hidden = !!here;
  $('#app-version').textContent = `App version ${APP_VERSION}`;
  showView('folder');
}

// Reports without a subdivision come first under "Wet check reports"; each subdivision gets
// its own section after them (A to Z), which can be folded away. Subdivision names match
// regardless of capitals and spaces.
const subKey = (name) => (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
// Reports are grouped by their controller; older reports by the subdivision typed on them.
const groupOf = (r) => r.controllerName || r.subdivision || '';

function subdivisionGroups(reports) {
  const groups = new Map();
  for (const r of reports) {
    const key = subKey(groupOf(r));
    if (!key) continue;
    const name = groupOf(r).trim().replace(/\s+/g, ' ');
    if (!groups.has(key)) groups.set(key, { key, name, reports: [] });
    const g = groups.get(key);
    if (g.name === g.name.toLowerCase() && name !== name.toLowerCase()) g.name = name; // show a capitalized spelling if any
    g.reports.push(r);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

const FOLDED_KEY = 'foldedSubdivisions';
function foldedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function setFolded(id, folded) {
  const set = foldedSet();
  if (folded) set.add(id);
  else set.delete(id);
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...set]));
  } catch {}
}

function renderReportGroups(folderId, reports) {
  const out = [];
  const loose = reports.filter((r) => !subKey(groupOf(r)));
  const groups = subdivisionGroups(reports);
  if (loose.length) {
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = 'Wet check reports';
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...loose.map((r) => reportRow(r)));
    out.push(h, ul);
  }
  const folded = foldedSet();
  for (const g of groups) {
    const foldId = `${folderId}|${g.key}`;
    const box = document.createElement('details');
    box.className = 'subdivision-group';
    box.open = !folded.has(foldId);
    const summary = document.createElement('summary');
    summary.className = 'section-title';
    const name = document.createElement('span');
    name.className = 'subdivision-name';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'subdivision-count';
    count.textContent = `${g.reports.length} report${g.reports.length === 1 ? '' : 's'}`;
    summary.append(name, count);
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.reports.map((r) => reportRow(r, true)));
    box.append(summary, ul);
    box.addEventListener('toggle', () => setFolded(foldId, !box.open));
    out.push(box);
  }
  $('#report-groups').replaceChildren(...out);
}

// ---------- Search ----------
// Finds properties and folders (and a property's contact), subdivisions, reports, and findings
// (issue, zone, note). Every word typed must match somewhere in the item.

let searchQuery = '';
let searchFrom = ''; // the folder search was opened from, to switch back from Everywhere
let searchData = null;
let searchTimer = 0;
const norm = (t) => String(t || '').toLowerCase();
const words = (q) => norm(q).split(/\s+/).filter(Boolean);
const matches = (hay, ws) => ws.every((w) => hay.includes(w));

async function renderSearch(scopeId) {
  const scope = scopeId ? await db.getFolder(scopeId) : null;
  if (scopeId && !scope) return (location.hash = '#/search');
  setCurrent({ kind: 'search', id: scopeId, record: scope });
  setHeader({ title: 'Search', back: true });
  const { folders, reports, findings } = await db.dumpAll();
  searchData = { folders, reports, findings, scope };
  if (scope) searchFrom = scope.id;
  const from = searchFrom ? scope || (await db.getFolder(searchFrom)) : null;
  const here = $('#search-scope-here');
  $('#search-scope').hidden = !from;
  here.textContent = from ? `In ${from.name}` : '';
  here.classList.toggle('on', !!scope);
  $('#search-scope-all').classList.toggle('on', !scope);
  const input = $('#search-input');
  input.value = searchQuery;
  showView('search');
  runSearch();
  if (!searchQuery) input.focus();
}

$('#search-input').addEventListener('input', () => {
  searchQuery = $('#search-input').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#search-input').blur(); // hide the keyboard to see the results
});
$('#search-scope-all').addEventListener('click', () => current.id && location.replace('#/search'));
$('#search-scope-here').addEventListener('click', () => !current.id && searchFrom && location.replace(`#/search/${encodeURIComponent(searchFrom)}`));

// Wraps each typed word found in el's text in <mark>.
function markWords(el, ws) {
  if (!el || !ws.length) return;
  const text = el.textContent;
  const lower = text.toLowerCase();
  const hits = [];
  for (const w of ws) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  if (!hits.length) return;
  hits.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a < at) continue;
    if (a > at) parts.push(text.slice(at, a));
    const m = document.createElement('mark');
    m.textContent = text.slice(a, b);
    parts.push(m);
    at = b;
  }
  parts.push(text.slice(at));
  el.replaceChildren(...parts);
}

function resultRow(opts, ws) {
  const li = row(opts);
  markWords(li.querySelector('.row-name'), ws);
  markWords(li.querySelector('.row-detail'), ws);
  return li;
}

const SEARCH_LIMIT = 50;

function runSearch() {
  if (!searchData) return;
  const ws = words(searchQuery);
  const out = [];
  const empty = $('#search-empty');
  if (!ws.length) {
    $('#search-results').replaceChildren();
    empty.hidden = false;
    empty.textContent = 'Search by property, folder, controller, report name or date, issue, zone, or note.';
    return;
  }
  const { folders, reports, findings, scope } = searchData;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const names = [];
    for (let f = byId.get(id), n = 0; f && n < 50; f = byId.get(f.parentId), n++) names.unshift(f.name);
    return names;
  };
  const inScope = (folderId) => {
    if (!scope) return true;
    for (let f = byId.get(folderId), n = 0; f && n < 50; f = byId.get(f.parentId), n++) if (f.id === scope.id) return true;
    return false;
  };
  const where = (folderId) => pathOf(folderId).join(' › ');
  const section = (title, rows) => {
    if (!rows.length) return;
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = rows.length > SEARCH_LIMIT ? `${title} · first ${SEARCH_LIMIT} of ${rows.length}` : `${title} · ${rows.length}`;
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...rows.slice(0, SEARCH_LIMIT).map((make) => make()));
    out.push(h, ul);
  };

  // Folders
  const folderHits = folders
    .filter((f) => f.id !== scope?.id && inScope(f.id))
    .filter((f) => {
      const c = f.profile?.contact || {};
      return matches(norm([f.name, c.name, c.address, c.email, c.phone].join(' ')), ws);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((f) => () =>
      resultRow({ icon: FOLDER_ICON, name: f.name, detail: f.parentId === db.ROOT ? 'Property' : where(f.parentId), href: folderHref(f.id) }, ws)
    );
  section('Properties and folders', folderHits);

  // Subdivisions, one per folder they're used in
  const scoped = reports.filter((r) => inScope(r.folderId));
  const subHits = [];
  const byFolder = new Map();
  for (const r of scoped) if (subKey(groupOf(r))) (byFolder.get(r.folderId) || byFolder.set(r.folderId, []).get(r.folderId)).push(r);
  for (const [folderId, rs] of byFolder) {
    for (const g of subdivisionGroups(rs)) {
      if (!matches(g.key, ws)) continue;
      subHits.push({ g, folderId });
    }
  }
  subHits.sort((a, b) => a.g.name.localeCompare(b.g.name, undefined, { numeric: true }));
  section(
    'Controllers and subdivisions',
    subHits.map(({ g, folderId }) => () => {
      const li = resultRow({ icon: FOLDER_ICON, name: g.name, detail: `${where(folderId)} · ${plural(g.reports.length, 'report')}`, href: folderHref(folderId) }, ws);
      li.querySelector('a').addEventListener('click', () => setFolded(`${folderId}|${g.key}`, false));
      return li;
    })
  );

  // Reports
  const reportHits = scoped
    .filter((r) => matches(norm([r.name, groupOf(r), r.date, formatDate(r.date)].join(' ')), ws))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => () =>
      resultRow({ icon: REPORT_ICON, name: r.name, detail: [where(r.folderId), groupOf(r), formatDate(r.date)].filter(Boolean).join(' · '), href: reportHref(r.id) }, ws)
    );
  section('Reports', reportHits);

  // Findings
  const reportById = new Map(scoped.map((r) => [r.id, r]));
  const findingHits = findings
    .filter((f) => reportById.has(f.reportId))
    .filter((f) => matches(norm([f.issue, f.zone ? `zone ${f.zone}` : '', f.note].join(' ')), ws))
    .sort((a, b) => reportById.get(b.reportId).date.localeCompare(reportById.get(a.reportId).date) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((f) => () => {
      const r = reportById.get(f.reportId);
      const detail = [pathOf(r.folderId)[0], r.name, f.zone ? zoneName(f.zone) : '', f.note].filter(Boolean).join(' · ');
      const li = resultRow({ icon: REPORT_ICON, name: f.issue || 'Finding', detail, href: reportHref(r.id) }, ws);
      const a = li.querySelector('a');
      if (f.photo instanceof Blob) {
        const img = document.createElement('img');
        img.className = 'result-photo';
        img.alt = '';
        const url = URL.createObjectURL(f.photo);
        img.onload = img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
        a.querySelector('svg').replaceWith(img);
      }
      a.addEventListener('click', () => setFocusFinding(f.id));
      return li;
    });
  section('Findings', findingHits);

  $('#search-results').replaceChildren(...out);
  empty.hidden = out.length > 0;
  empty.textContent = scope ? `Nothing in ${scope.name} matches “${searchQuery.trim()}”. Try Everywhere.` : `Nothing matches “${searchQuery.trim()}”.`;
}

// ---------- Property photo (top-level folders) ----------

let propertyPhotoUrl = null;

function renderPropertyPhoto(folder) {
  const box = $('#property-photo');
  box.hidden = !folder;
  if (!folder) return;
  if (propertyPhotoUrl) URL.revokeObjectURL(propertyPhotoUrl);
  propertyPhotoUrl = folder.photo ? URL.createObjectURL(folder.photo) : null;
  const img = $('#property-photo-img');
  img.hidden = !folder.photo;
  if (folder.photo) img.src = propertyPhotoUrl;
  else img.removeAttribute('src');
  $('#prop-remove').hidden = !folder.photo;
}

async function onPropertyPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || current.kind !== 'folder' || !current.record) return;
  const photo = await compressPhoto(file);
  await db.updateFolder(current.record.id, { photo });
  render();
}

$('#prop-remove').addEventListener('click', async () => {
  if (!(await askConfirm('Remove property photo', 'Remove this property’s photo from its report covers?', 'Remove'))) return;
  await db.updateFolder(current.record.id, { photo: null });
  render();
});
$('#prop-camera').addEventListener('change', onPropertyPhoto);
$('#prop-library').addEventListener('change', onPropertyPhoto);

function folderRow(folder) {
  return row({
    icon: FOLDER_ICON,
    name: folder.name,
    href: folderHref(folder.id),
    menuLabel: `Options for ${folder.name}`,
    onMenu: () => folderMenu(folder),
  });
}

const APPROVAL_TAGS = { sent: 'Awaiting approval', approved: 'Approved', declined: 'Declined' };
export const WORK_TAGS = { progress: 'Work in progress', done: 'Work done' };
const approvalTag = (r) => (r.work && WORK_TAGS[r.work.status]) || (r.approval && APPROVAL_TAGS[r.approval.status]) || '';
export const reportDetail = (r) => [formatDate(r.date), groupOf(r), approvalTag(r)].filter(Boolean).join(' · ');

function reportRow(report, grouped = false) {
  return row({
    icon: REPORT_ICON,
    name: report.name,
    detail: grouped ? [formatDate(report.date), approvalTag(report)].filter(Boolean).join(' · ') : reportDetail(report),
    href: reportHref(report.id),
    menuLabel: `Options for ${report.name}`,
    onMenu: () => reportMenu(report),
  });
}

async function folderMenu(folder) {
  const top = folder.parentId === db.ROOT;
  const action = await askAction(folder.name, [
    ...(top ? [{ label: 'Property profile', value: 'profile' }] : []),
    { label: 'Rename', value: 'rename' },
    { label: 'Back up or share this property', value: 'backup' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'profile') location.hash = profileHref(folder.id);
  if (action === 'backup') await backUp(folder);
  if (action === 'rename') {
    const name = await askName('Rename folder', 'Save', folder.name);
    if (!name || name === folder.name) return;
    await db.renameFolder(folder.id, name);
    render();
  }
  if (action === 'delete') {
    const { folders, reports } = await db.countContents(folder.id);
    const inside = [folders && plural(folders, 'folder'), reports && plural(reports, 'report')].filter(Boolean);
    let text = `Delete “${folder.name}”?`;
    if (inside.length) text += ` It contains ${inside.join(' and ')}, which will also be deleted.`;
    text += ' This can’t be undone.';
    if (!(await askConfirm('Delete folder', text))) return;
    await db.deleteFolder(folder.id);
    render();
  }
}

async function newInFolder() {
  const folderId = current.id;
  // A report always belongs to a property, so the top level only holds folders.
  const action = folderId === db.ROOT
    ? 'folder'
    : await askAction('Add to this folder', [
        { label: 'New wet check report', value: 'report' },
        { label: 'New folder', value: 'folder' },
      ]);
  if (action === 'folder') {
    const name = await askName('New folder', 'Create');
    if (!name) return;
    await db.createFolder(name, folderId);
    render();
  }
  if (action === 'report') {
    const estimate = !!(await db.getSetting('estimateDefault')); // last choice made
    const details = await askReportDetails('New wet check report', 'Create', { name: 'Wet check', date: today(), estimate }, folderId, { isNew: true });
    if (!details) return;
    await db.setSetting('estimateDefault', details.estimate);
    const prices = priceSnapshot(await issueListFor(folderId)); // locked in for this report
    const { name, date, ...extra } = details;
    const report = await db.createReport(folderId, name, date, { ...extra, prices, currentZone: SECTIONS[0] }); // a wet check starts at the controller
    location.hash = reportHref(report.id);
  }
}

$('#fab').addEventListener('click', newInFolder);
$('#search-btn').addEventListener('click', () => {
  const here = current.kind === 'folder' && current.record ? current.record.id : '';
  searchQuery = '';
  searchFrom = here;
  location.hash = here ? `#/search/${encodeURIComponent(here)}` : '#/search';
});
