// A wet check report (#/r/<id>): zones, findings and the finding form, zone status marks,
// the repair estimate, the coordinates list and PDF export.

import * as db from './db.js';
import { askAction, SECTIONS, isSection, $, zoneName, plural, askName, formatDate, showDialog, today, askConfirm, zonesLabel } from './ui.js';
import { compressPhoto } from './photo.js';
import { findingPrice, formatMoney, buildEstimate, discountLabel, toPrice, discountAmount } from './issues.js';
import { buildReportPdf, DEFAULT_ACCENT, pdfFileName } from './pdf.js';
import { cloudReady } from './cloud.js';
import { coordsText, stampDetails, mapUrl, copyText, readExif, getPosition } from './location.js';
import { screens, render, setCurrent, setHeader, crumbsFor, showView, current, deliverFile, folderHref, showToast } from './core.js';
import { reportDetail } from './folders.js';
import { workActions, sendForApproval, setWork, renderApprovalCard, refreshApproval } from './approvals.js';
import { signatureFor, defaultSignature, askSignature, checkStorage } from './settings.js';
import { refreshPrices, issueListFor, exportSettingsOf, propertyFolder, DEFAULT_DISCLAIMER, saveProfile, disclaimerFor, disclaimerOnFor } from './profiles.js';

screens.report = renderReport;

// ---------- Report screen ----------

let photoUrls = []; // object URLs for thumbnails, revoked on each render
let focusFinding = null; // a finding to scroll to when its report opens from search
export const setFocusFinding = (id) => (focusFinding = id);

export async function reportMenu(report) {
  const action = await askAction(report.name, [
    { label: 'Export PDF', value: 'pdf' },
    ...(cloudReady ? [{ label: report.approval && report.approval.status === 'sent' ? 'Send for approval again' : 'Send for approval', value: 'approval' }] : []),
    ...workActions(report),
    { label: 'Coordinates list', value: 'coords' },
    { label: report.estimate ? 'Turn off repair estimate' : 'Turn on repair estimate', value: 'estimate' },
    ...(report.estimate ? [{ label: 'Use current prices', value: 'prices' }] : []),
    { label: 'Edit report details', value: 'edit' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'estimate') {
    await db.updateReport(report.id, { estimate: !report.estimate });
    render();
  }
  if (action === 'prices') await refreshPrices(report);
  if (action === 'pdf') await exportPdf(report);
  if (action === 'approval') await sendForApproval(report);
  if (action.startsWith('work:')) await setWork(report, action.slice(5));
  if (action === 'coords') await showCoordinates(report);
  if (action === 'edit') await editReport(report);
  if (action === 'delete') await removeReport(report);
}

// The zone a report is being worked in. New findings go into it unless changed.
const zoneOf = (report) => (report.currentZone ?? '1');

// The sections this report steps through before Zone 1: a system has a pump or a backflow, so
// the controller's water source decides which one (municipal: Backflow, pump types: Pump).
// With no controller or water source known, all of them. Set when a report is opened.
let activeSections = SECTIONS;
function sectionsFor(report, path) {
  const all = path.length ? path[0].controllers || [] : [];
  const mine = report.controllerId ? all.filter((c) => c.id === report.controllerId) : all;
  const waters = mine.map((c) => c.water);
  if (!waters.length || waters.some((w) => !w)) return SECTIONS;
  const pumped = waters.some((w) => w.startsWith('pump'));
  const municipal = waters.includes('municipal');
  return SECTIONS.filter((z) => (z === 'Pump' ? pumped : z === 'Backflow' ? municipal : true));
}

// Next or previous zone: steps the number at the end ("4" -> "5", "A3" -> "A4"). The sections
// come before Zone 1: Controller -> Pump or Backflow -> Zone 1 -> Zone 2.
function stepZone(zone, delta) {
  const s = SECTIONS.indexOf(zone);
  if (s >= 0) {
    // A section this report skips (an older report, or a changed controller) steps to its neighbor.
    const next = delta > 0 ? SECTIONS.slice(s + 1).find((z) => activeSections.includes(z)) : SECTIONS.slice(0, s).reverse().find((z) => activeSections.includes(z));
    return next || (delta > 0 ? '1' : SECTIONS[0]);
  }
  const m = zone.match(/^(.*?)(\d+)$/);
  if (!m) return zone ? zone : '1';
  if (!m[1] && Number(m[2]) + delta < 1) return activeSections[activeSections.length - 1];
  return m[1] + Math.max(1, Number(m[2]) + delta);
}

const byZone = (a, b) => {
  if (!a) return 1; // findings with no zone go last
  if (!b) return -1;
  if (isSection(a) || isSection(b)) return (isSection(a) ? SECTIONS.indexOf(a) : 99) - (isSection(b) ? SECTIONS.indexOf(b) : 99);
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

// Zones opened or closed by hand in a report, until its working zone changes.
const foldState = { reportId: null, zone: null, folds: new Map() };
function zoneFolds(reportId, zone) {
  if (foldState.reportId !== reportId || foldState.zone !== zone) {
    Object.assign(foldState, { reportId, zone, folds: new Map() });
  }
  return foldState.folds;
}

function markIcon(kind) {
  const s = document.createElement('span');
  s.className = `zone-mark ${kind}`;
  s.innerHTML = kind === 'ok'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
  s.setAttribute('aria-label', kind === 'ok' ? 'No issues found' : 'Valve not opening');
  return s;
}

// [[zone, findings], ...] in zone order; findings keep the order they were added.
function groupByZone(findings) {
  const groups = new Map();
  for (const f of findings) {
    const z = f.zone || '';
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(f);
  }
  return [...groups.keys()].sort(byZone).map((z) => [z, groups.get(z)]);
}

async function renderReport(id) {
  const report = await db.getReport(id);
  if (!report) return (location.hash = '#/');
  const path = await db.getPath(report.folderId);
  setCurrent({ kind: 'report', id, record: report });
  activeSections = sectionsFor(report, path);

  setHeader({
    title: report.name,
    subtitle: reportDetail(report),
    crumbs: crumbsFor(path),
    back: true,
    more: true,
  });
  $('#send-approval').hidden = !cloudReady;
  $('#send-approval-label').textContent = report.approval && report.approval.status === 'sent' ? 'Send again' : 'Send for approval';

  const zone = zoneOf(report);
  $('#zone-value').textContent = zoneName(zone);
  $('#mark-fail').hidden = isSection(zone); // its X means a valve that won't open
  // Back stops at the controller, and at 1 for lettered zones like A1 (plain Zone 1 goes back to the pump).
  $('#zone-prev').disabled = zone === SECTIONS[0] || (!isSection(zone) && (!/\d+$/.test(zone) || /^.*\D0*1$/.test(zone)));

  const findings = await db.listFindings(id);
  for (const u of photoUrls) URL.revokeObjectURL(u);
  photoUrls = [];
  const list = report.estimate ? await issueListFor(report.folderId) : null;
  renderEstimateBar(report, findings, list);
  renderApprovalCard(report);
  refreshApproval(report);

  // Zones fold up so the list stays short: the zone being worked in is open, the rest show
  // just a heading until tapped. A zone opened or closed by hand stays that way until the
  // working zone changes.
  const folds = zoneFolds(report.id, zone);
  const focusZone = focusFinding ? (findings.find((f) => f.id === focusFinding) || {}).zone : undefined;
  if (focusZone !== undefined) folds.set(focusZone || '', true);
  const sections = groupByZone(findings).map(([z, items]) => {
    const section = document.createElement('details');
    section.className = 'zone-group' + (z === zone ? ' current' : '');
    const isDefault = z === zone;
    section.open = folds.has(z) ? folds.get(z) : isDefault;
    const h = document.createElement('summary');
    h.className = 'section-title';
    const title = document.createElement('span');
    title.className = 'zone-title';
    title.textContent = `${zoneName(z)} · ${plural(items.length, 'finding')}`;
    const marks = items.filter((f) => f.mark).map((f) => f.mark);
    const status = document.createElement('span');
    status.className = 'zone-status';
    if (marks.includes('fail')) status.append(markIcon('fail'));
    else if (marks.length === items.length) status.append(markIcon('ok')); // only checks in this zone
    const summary = document.createElement('span');
    summary.className = 'zone-summary';
    summary.textContent = items.map((f) => f.issue).join(', ');
    h.append(title, status, summary);
    const ul = document.createElement('ul');
    ul.className = 'cards';
    ul.append(...items.map((f, i) => findingCard(f, i + 1, list, report.prices)));
    section.append(h, ul);
    section.addEventListener('toggle', () => {
      if (section.open === isDefault) folds.delete(z);
      else folds.set(z, section.open);
    });
    return section;
  });
  $('#finding-groups').replaceChildren(...sections);
  $('#report-empty').hidden = findings.length > 0;
  showView('report');
  if (focusFinding) {
    const card = $('#finding-groups').querySelector(`li[data-id="${CSS.escape(focusFinding)}"]`);
    focusFinding = null;
    if (card) {
      requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 2000);
    }
  }
}

window.addEventListener('online', () => current && current.kind === 'report' && render());

async function setZone(zone) {
  const report = await db.updateReport(current.id, { currentZone: zone });
  current.record = report;
  await render();
}

$('#zone-next').addEventListener('click', () => setZone(stepZone(zoneOf(current.record), 1)));
$('#zone-prev').addEventListener('click', () => setZone(stepZone(zoneOf(current.record), -1)));
$('#zone-current').addEventListener('click', async () => {
  const z = await askName('Current zone', 'Set', zoneOf(current.record), { allowEmpty: true, placeholder: 'Zone number', numeric: true });
  if (z !== null) setZone(z);
});

function findingCard(finding, number, list = null, snapshot = null) {
  const li = document.createElement('li');
  li.dataset.id = finding.id;
  li.className = 'card';
  const btn = document.createElement('button');
  btn.className = 'card-main';
  btn.addEventListener('click', () => editFinding(finding));

  if (finding.photo) {
    const img = document.createElement('img');
    const url = URL.createObjectURL(finding.photo);
    photoUrls.push(url);
    img.src = url;
    img.alt = '';
    img.className = finding.mark ? 'card-photo mark' : 'card-photo';
    btn.append(img);
    const more = (finding.morePhotos || []).length;
    if (more) {
      const count = document.createElement('span');
      count.className = 'photo-count';
      count.textContent = `+${plural(more, 'photo')}`;
      btn.append(count);
    }
  }
  const body = document.createElement('div');
  body.className = 'card-body';
  const head = document.createElement('div');
  head.className = 'card-issue';
  head.textContent = `${number}. ${finding.issue}`;
  body.append(head);
  if (list && finding.mark !== 'ok') {
    const price = findingPrice(finding, list, snapshot);
    const p = document.createElement('div');
    p.className = 'card-price' + (price == null ? ' none' : '');
    p.textContent = price == null ? 'No price' : formatMoney(price);
    body.append(p);
  }
  if (finding.note) {
    const n = document.createElement('div');
    n.className = 'card-note';
    n.textContent = finding.note;
    body.append(n);
  }
  if (finding.disclaimer) {
    const d = document.createElement('div');
    d.className = 'card-disclaimer';
    d.textContent = finding.disclaimer;
    body.append(d);
  }
  btn.append(body);
  li.append(btn);
  if (finding.stamp) li.append(locationBox(finding.stamp));
  return li;
}

// Coordinates with Map and Copy buttons, and accuracy and time underneath.
function locationBox(stamp) {
  const box = document.createElement('div');
  box.className = 'loc-box';
  const text = document.createElement('div');
  text.className = 'loc-text';
  const coords = document.createElement('div');
  coords.className = 'loc-coords';
  coords.textContent = !stamp ? 'Added with the photo' : stamp.lat != null ? coordsText(stamp) : 'No location';
  const details = document.createElement('div');
  details.className = 'loc-details';
  details.textContent = stampDetails(stamp);
  details.hidden = !details.textContent;
  text.append(coords, details);
  box.append(text);
  if (stamp && stamp.lat != null) box.append(mapButtons(stamp));
  return box;
}

function mapButtons(stamp) {
  const wrap = document.createElement('div');
  wrap.className = 'loc-actions';
  const map = document.createElement('a');
  map.className = 'btn small outline';
  map.href = mapUrl(stamp);
  map.target = '_blank';
  map.rel = 'noopener';
  map.textContent = 'Map';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn small outline';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    const ok = await copyText(coordsText(stamp));
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  wrap.append(map, copy);
  return wrap;
}

// Every finding's coordinates in one list, for finding the repairs later.
async function showCoordinates(report) {
  const findings = await db.listFindings(report.id);
  const rows = [];
  for (const [z, items] of groupByZone(findings)) {
    items.forEach((f, i) => {
      if (f.stamp && f.stamp.lat != null) rows.push({ label: `${zoneName(z)} · ${i + 1}. ${f.issue}`, stamp: f.stamp });
    });
  }
  $('#coords-list').replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'coords-row';
    const text = document.createElement('div');
    text.className = 'loc-text';
    const label = document.createElement('div');
    label.className = 'coords-label';
    label.textContent = r.label;
    const coords = document.createElement('div');
    coords.className = 'loc-coords';
    coords.textContent = coordsText(r.stamp);
    text.append(label, coords);
    li.append(text, mapButtons(r.stamp));
    return li;
  }));
  $('#coords-empty').hidden = rows.length > 0;
  $('#coords-copy').hidden = rows.length === 0;
  const copyAll = $('#coords-copy');
  copyAll.onclick = async () => {
    const text = [`${report.name} (${formatDate(report.date)})`, ...rows.map((r) => `${r.label}: ${coordsText(r.stamp)}`)].join('\n');
    const ok = await copyText(text);
    copyAll.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copyAll.textContent = 'Copy all'), 1500);
  };
  await showDialog($('#coords-dialog'));
}

// The report's PDF: { blob, name }. Used by Export PDF and by backups.
export async function reportPdf(report, { photoMax = 0 } = {}) {
  const [path, findings, logo, companyName, accent, list] = await Promise.all([
    db.getPath(report.folderId),
    db.listFindings(report.id),
    db.getSetting('companyLogo'),
    db.getSetting('companyName'),
    db.getSetting('accentColor'),
    issueListFor(report.folderId),
  ]);
  const property = path.map((f) => f.name);
  const ex = exportSettingsOf(path.length ? path[0] : null);
  // A proposal is about the repair prices, so it prices the findings even on a report without
  // an estimate; prices turned off in the property's export settings leave all of that out.
  const priced = ex.prices && (report.estimate || ex.template === 'proposal');
  const estimate = priced ? buildEstimate(findings, list, report.prices, report.discount) : null;
  const profile = path.length ? path[0].profile : null;
  const blob = await buildReportPdf({
    template: ex.template,
    show: { photos: ex.photos, coords: ex.coords, itemized: ex.itemized, photoMax },
    estimate,
    report,
    property,
    propertyPhoto: path.length ? path[0].photo || null : null, // set on the top-level property folder
    logo,
    companyName,
    accent: accent || DEFAULT_ACCENT,
    contact: profile && profile.contact ? profile.contact : null,
    signature: await signatureFor(report),
    // The report's own controller, or all of the property's for a whole-property report.
    controllers: (() => {
      const all = path.length ? path[0].controllers || [] : [];
      return report.controllerId ? all.filter((c) => c.id === report.controllerId) : all;
    })(),
    groups: groupByZone(findings),
    zoneName,
  });
  return { blob, name: pdfFileName(property, report), estimate, itemized: ex.itemized };
}

// Before exporting, the report is signed: it starts from the default signature in Settings
// (or what was used last time for this report) and can be changed for this report only.
async function exportPdf(report) {
  report = await confirmSignature(report);
  if (!report) return;
  return deliverFile({
    working: 'Making PDF…',
    workingText: 'This takes a few seconds for reports with lots of photos.',
    ready: 'PDF ready',
    failed: 'Couldn’t make the PDF',
    canOpen: true,
    build: () => reportPdf(report),
  });
}

// Resolves with the report as signed, or null if cancelled. Without a default signature or
// one saved on the report, it's returned unchanged.
export async function confirmSignature(report, submitLabel = 'Export PDF') {
  const def = await defaultSignature();
  const saved = report.signature;
  if (!def.on && !saved) return report;
  const start = saved
    ? { on: !saved.off, image: report.signatureImage || null, name: saved.name || '', role: saved.role || '', date: saved.date || today() }
    : { on: true, image: def.image, name: def.name, role: def.role, date: today() };
  const r = await askSignature({ mode: 'report', ...start, defaults: def, submitLabel });
  if (!r) return null;
  report = await db.updateReport(report.id, {
    signature: { off: !r.on, name: r.name, role: r.role, date: r.date },
    signatureImage: r.on ? r.image : null,
  });
  if (current.kind === 'report' && current.id === report.id) current.record = report;
  return report;
}

export async function askReportDetails(title, submitLabel, initial, folderId, { isNew = false } = {}) {
  const property = await propertyFolder(folderId);
  const controllers = (property && property.controllers) || [];
  const select = $('#report-controller');
  const opt = (value, text, extra = {}) => Object.assign(document.createElement('option'), { value, textContent: text, ...extra });
  const known = controllers.some((c) => c.id === initial.controllerId);
  select.replaceChildren(
    ...(isNew ? [opt('', 'Choose a controller', { disabled: true })] : []),
    ...controllers.map((c) => opt(c.id, c.zones ? `${c.name} (${plural(c.zones, 'zone')})` : c.name)),
    // A report whose controller was later deleted keeps its name.
    ...(initial.controllerId && !known ? [opt(initial.controllerId, `${initial.controllerName || 'Controller'} (deleted)`)] : []),
    opt('none', 'Whole property, no single controller')
  );
  select.value = initial.controllerId || (isNew ? (controllers.length === 1 ? controllers[0].id : '') : 'none');
  select.required = isNew && controllers.length > 0;
  $('#report-controller-box').hidden = !controllers.length && !initial.controllerId;
  $('#report-controller-hint').hidden = controllers.length > 0 || !!initial.controllerId;
  // Subdivisions are no longer asked for; older reports that have one can still change it.
  $('#report-subdivision-box').hidden = !initial.subdivision;
  $('#report-subdivision').value = initial.subdivision || '';

  $('#report-dialog-title').textContent = title;
  $('#report-submit').textContent = submitLabel;
  $('#report-name').value = initial.name;
  $('#report-date').value = initial.date;
  $('#report-estimate').checked = !!initial.estimate;
  const result = await showDialog($('#report-dialog'));
  const name = $('#report-name').value.trim();
  const date = $('#report-date').value;
  if (result !== 'ok' || !name || !date) return null;
  const id = select.value && select.value !== 'none' ? select.value : null;
  const picked = controllers.find((c) => c.id === id);
  return {
    name,
    date,
    estimate: $('#report-estimate').checked,
    subdivision: $('#report-subdivision').value.trim(),
    controllerId: id,
    controllerName: picked ? picked.name : id === initial.controllerId ? initial.controllerName || '' : '',
  };
}

async function editReport(report) {
  const details = await askReportDetails('Edit report', 'Save', report, report.folderId);
  if (!details) return;
  await db.updateReport(report.id, details);
  render();
}

async function removeReport(report) {
  const n = (await db.listFindings(report.id)).length;
  let text = `Delete “${report.name}” from ${formatDate(report.date)}?`;
  if (n) text += ` Its ${plural(n, 'finding')} will also be deleted.`;
  text += ' This can’t be undone.';
  if (!(await askConfirm('Delete report', text))) return;
  await db.deleteReport(report.id);
  if (current.kind === 'report') location.hash = folderHref(report.folderId);
  else render();
}

// ---------- Repair estimate (report screen) ----------

function renderEstimateBar(report, findings, list) {
  const bar = $('#estimate-bar');
  bar.hidden = !list;
  if (!list) return;
  const est = buildEstimate(findings, list, report.prices, report.discount);
  $('#estimate-total').textContent = formatMoney(est.total);
  const detail = $('#estimate-detail');
  detail.classList.toggle('warn', est.unpriced > 0);
  if (!findings.length) detail.textContent = 'Findings are priced from your price list as you add them.';
  else if (est.unpriced) detail.textContent = `${plural(est.unpriced, 'finding')} without a price, not included. Tap to see the estimate.`;
  else detail.textContent = `${plural(findings.length, 'finding')} priced${est.discount ? `, ${formatMoney(est.discount)} off` : ''}. Tap to see the estimate.`;
}

async function showEstimate(report) {
  const [findings, list] = await Promise.all([db.listFindings(report.id), issueListFor(report.folderId)]);
  const est = buildEstimate(findings, list, report.prices, report.discount);
  $('#estimate-lines').replaceChildren(...est.lines.map((l) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'line-text';
    text.textContent = l.issue;
    const detail = document.createElement('span');
    detail.className = 'line-detail';
    const zones = l.zones.length ? ` · ${zonesLabel(l.zones)}` : '';
    detail.textContent = `${l.qty} × ${l.unit == null ? 'no price' : formatMoney(l.unit)}${zones}`;
    text.append(detail);
    const amount = document.createElement('span');
    amount.className = 'line-amount' + (l.amount == null ? ' none' : '');
    amount.textContent = l.amount == null ? 'No price' : formatMoney(l.amount);
    li.append(text, amount);
    return li;
  }));
  $('#estimate-sum').textContent = formatMoney(est.total);
  $('#estimate-subtotal-row').hidden = !report.discount;
  $('#estimate-subtotal').textContent = formatMoney(est.subtotal);
  const disc = $('#estimate-discount');
  disc.classList.toggle('has', !!report.discount);
  $('#estimate-discount-label').textContent = report.discount ? discountLabel(report.discount) : '+ Add a discount';
  $('#estimate-discount-amount').textContent = report.discount ? `−${formatMoney(est.discount)}` : '';
  disc.onclick = async () => {
    $('#estimate-dialog').close('cancel');
    if (await editDiscount(report, est.subtotal)) {
      render();
      showEstimate(await db.getReport(report.id));
    }
  };
  const warn = $('#estimate-unpriced');
  warn.hidden = !est.unpriced;
  warn.textContent = `${plural(est.unpriced, 'finding')} without a price ${est.unpriced === 1 ? 'isn’t' : 'aren’t'} included. Set prices in Settings or the property profile, or type a price on the finding.`;
  $('#estimate-refresh').onclick = async () => {
    $('#estimate-dialog').close('cancel');
    await refreshPrices(report);
  };
  await showDialog($('#estimate-dialog'));
}

$('#estimate-bar').addEventListener('click', () => showEstimate(current.record));

// A dollar or percentage discount off this report's estimate. Resolves true if it changed.
async function editDiscount(report, subtotal) {
  const d = report.discount || { type: 'amount', value: null, label: '' };
  const radios = [...document.querySelectorAll('input[name="discount-type"]')];
  const value = $('#discount-value');
  const preview = $('#discount-preview');
  radios.forEach((r) => (r.checked = r.value === d.type));
  value.value = d.value == null ? '' : String(d.value);
  $('#discount-label').value = d.label || '';
  $('#discount-remove').hidden = !report.discount;
  $('#discount-remove').onclick = () => $('#discount-dialog').close('remove');
  const type = () => (radios.find((r) => r.checked) || radios[0]).value;
  const parse = () => {
    const n = toPrice(value.value.replace('%', ''));
    return n && n > 0 ? n : null;
  };
  const update = () => {
    const pct = type() === 'percent';
    $('#discount-value-label').textContent = pct ? 'Percentage (%)' : 'Amount ($)';
    value.placeholder = pct ? 'e.g. 10' : 'e.g. 50';
    const n = parse();
    const bad = value.value.trim() && (!n || (pct && n > 100));
    value.setCustomValidity(bad ? (pct ? 'Enter a percentage from 0 to 100.' : 'Enter a dollar amount.') : '');
    if (!n || bad) return (preview.textContent = '');
    const off = discountAmount(subtotal, { type: type(), value: n });
    preview.textContent = `${formatMoney(off)} off ${formatMoney(subtotal)}, new total ${formatMoney(subtotal - off)}.`
      + (!pct && n > subtotal ? ' (Capped at the current subtotal.)' : '');
  };
  radios.forEach((r) => (r.onchange = update));
  value.oninput = update;
  update();
  const answer = await showDialog($('#discount-dialog'));
  value.oninput = null;
  if (answer === 'remove') {
    await db.updateReport(report.id, { discount: null });
    return true;
  }
  if (answer !== 'ok' || !parse()) return false;
  await db.updateReport(report.id, { discount: { type: type(), value: parse(), label: $('#discount-label').value.trim() } });
  return true;
}

// ---------- Finding form ----------

const form = {
  dialog: $('#finding-dialog'),
  title: $('#finding-title'),
  preview: $('#photo-preview'),
  img: $('#photo-img'),
  location: $('#finding-location'),
  locStatus: $('#location-status'),
  error: $('#photo-error'),
  issue: $('#finding-issue'),
  zone: $('#finding-zone'),
  note: $('#finding-note'),
  disclaimerCheck: $('#finding-disclaimer'),
  disclaimerText: $('#disclaimer-text'),
  priceBox: $('#price-box'),
  price: $('#finding-price'),
  priceHint: $('#price-hint'),
  list: null, // issue list, for prices
  disclaimer: '', // wording that goes on this finding if the box is checked
  del: $('#finding-delete'),
  photo: null, // compressed Blob
  more: [], // extra photos (compressed Blobs), shown after the main one
  moreUrls: [],
  photoStamp: null, // { takenAt, lat, lon, accuracy } (older findings may also have a city, no longer shown)
  busy: false,
  locating: null, // promise while waiting on GPS for the current photo
  pendingPosition: null, // GPS request started when the camera opens
  pick: 0, // bumps on every photo pick so a slow lookup can't overwrite a newer photo
};

function setPhoto(blob, stamp = null) {
  form.photo = blob;
  if (form.img.src) URL.revokeObjectURL(form.img.src);
  form.img.removeAttribute('src');
  if (blob) form.img.src = URL.createObjectURL(blob);
  form.preview.hidden = !blob;
  $('#more-photo-buttons').hidden = !blob || form.more.length >= MAX_MORE_PHOTOS;
  setStamp(stamp);
}

const MAX_MORE_PHOTOS = 6; // findings saved with more (the limit was 8) keep them all

function renderMorePhotos() {
  for (const u of form.moreUrls) URL.revokeObjectURL(u);
  form.moreUrls = [];
  const list = $('#more-photo-list');
  list.replaceChildren(...form.more.map((blob, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    const url = URL.createObjectURL(blob);
    form.moreUrls.push(url);
    img.src = url;
    img.alt = `Photo ${i + 2}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'thumb-remove';
    del.setAttribute('aria-label', `Remove photo ${i + 2}`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      form.more.splice(i, 1);
      renderMorePhotos();
    });
    li.append(img, del);
    return li;
  }));
  list.hidden = form.more.length === 0;
  $('#more-photo-buttons').hidden = !form.photo || form.more.length >= MAX_MORE_PHOTOS;
}

async function onMorePhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const room = Math.max(0, MAX_MORE_PHOTOS - form.more.length);
  showPhotoError(files.length > room ? `Up to ${MAX_MORE_PHOTOS + 1} photos per finding. Only the first ${room} were added.` : '');
  form.busy = true;
  try {
    for (const file of files.slice(0, room)) {
      try {
        form.more.push(await compressPhoto(file));
      } catch {
        showPhotoError('A photo couldn’t be read and was skipped.');
      }
      renderMorePhotos();
    }
  } finally {
    form.busy = false;
  }
}
$('#more-camera').addEventListener('change', onMorePhotos);
$('#more-library').addEventListener('change', onMorePhotos);

function setStamp(stamp) {
  form.photoStamp = stamp;
  form.location.replaceChildren(locationBox(stamp));
}

function showLocStatus(msg) {
  form.locStatus.textContent = msg;
  form.locStatus.hidden = !msg;
}

function showPhotoError(msg) {
  form.error.textContent = msg;
  form.error.hidden = !msg;
}

async function onPhotoPicked(e, fromCamera) {
  const file = e.target.files[0];
  e.target.value = ''; // lets the same photo be picked again
  if (!file) return;
  const pick = ++form.pick;
  showPhotoError('');
  showLocStatus('');
  form.busy = true;
  let exif;
  try {
    [exif] = await Promise.all([readExif(file), compressPhoto(file).then((b) => (form.photo = b))]);
  } catch {
    form.busy = false;
    showPhotoError('That photo couldn’t be read. Try another one.');
    return;
  }
  form.busy = false;
  if (pick !== form.pick) return;

  // Camera: now, and the phone's GPS unless the camera already tagged the photo.
  // Library: whatever the photo itself recorded, since it may be from another day or place.
  const stamp = { takenAt: exif.takenAt || (fromCamera ? Date.now() : file.lastModified || null) };
  if (exif.lat != null) Object.assign(stamp, { lat: exif.lat, lon: exif.lon });
  setPhoto(form.photo, stamp);

  if (stamp.lat == null && fromCamera) {
    showLocStatus('Getting location…');
    form.locating = (form.pendingPosition || getPosition()).then((pos) => {
      if (pick !== form.pick) return;
      form.locating = null;
      if (pos) {
        setStamp({ ...form.photoStamp, ...pos });
        showLocStatus('');
      } else {
        showLocStatus('Location unavailable. Allow location for this site in your phone’s settings to add it.');
      }
    });
    await form.locating;
  } else if (stamp.lat == null) {
    showLocStatus('This photo has no location saved in it.');
  }
  form.pendingPosition = null;
}

// Start GPS as the camera opens, so it's ready by the time the photo is taken.
$('#photo-camera').addEventListener('click', () => {
  form.pendingPosition = getPosition();
});
$('#photo-camera').addEventListener('change', (e) => onPhotoPicked(e, true));
$('#photo-library').addEventListener('change', (e) => onPhotoPicked(e, false));

$('#finding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (form.busy) return;
  if (!form.photo) {
    showPhotoError('Add a photo first.');
    return;
  }
  if (form.locating) {
    $('#finding-save').disabled = true;
    await form.locating;
    $('#finding-save').disabled = false;
  }
  form.dialog.close('ok');
});

form.del.addEventListener('click', () => form.dialog.close('delete'));

// ---------- Troubleshooting disclaimer ----------

function setDisclaimer(text, checked = form.disclaimerCheck.checked) {
  form.disclaimer = text;
  form.disclaimerText.textContent = text;
  form.disclaimerCheck.checked = checked;
  $('#disclaimer-box').classList.toggle('on', checked);
}

form.disclaimerCheck.addEventListener('change', () => setDisclaimer(form.disclaimer));

$('#disclaimer-edit').addEventListener('click', async () => {
  const input = $('#disclaimer-input');
  input.value = form.disclaimer;
  $('#disclaimer-reset').onclick = () => (input.value = DEFAULT_DISCLAIMER);
  if ((await showDialog($('#disclaimer-dialog'))) !== 'ok') return;
  const text = input.value.trim();
  if (!text) return;
  // A property with its own disclaimer keeps edits there; otherwise it's the main one.
  if (form.property && form.property.profile && form.property.profile.disclaimer) await saveProfile(form.property.id, { disclaimer: text });
  else await db.setSetting('disclaimer', text);
  setDisclaimer(text, true); // editing it implies wanting it on this finding
});

// Each section gets its own short list: the Controller section only the controller issues,
// Pump and Backflow only theirs, and zones everything else. "Other" shows everywhere.
const SECTION_GROUPS = { Controller: 'Controller and sensors', Pump: 'Pump', Backflow: 'Backflow' };
function groupsForZone(list, zone) {
  const sectionGroups = Object.values(SECTION_GROUPS);
  return list.groups.filter((g) => g.name === 'Other' || (SECTION_GROUPS[zone] ? g.name === SECTION_GROUPS[zone] : !sectionGroups.includes(g.name)));
}

async function fillIssues(selected) {
  const list = (form.list = await issueListFor(current.record.folderId));
  const placeholder = new Option('Choose an issue', '');
  placeholder.disabled = true;
  const options = [placeholder];
  const zone = form.zone.value.trim();
  const groups = groupsForZone(list, zone);
  // Keep an issue that has since been turned off, removed, or is from another section's list,
  // so editing doesn't lose it.
  const shown = (i) => !i.off || i.name === selected;
  const listed = groups.some((g) => g.issues.some((i) => i.name === selected && shown(i)));
  if (selected && !listed) options.push(new Option(selected, selected));
  for (const g of groups) {
    const items = g.issues.filter(shown).map((i) => new Option(i.name, i.name));
    if (!items.length) continue;
    if (!g.name) {
      options.push(...items);
      continue;
    }
    const og = document.createElement('optgroup');
    og.label = g.name;
    og.append(...items);
    options.push(og);
  }
  form.issue.replaceChildren(...options);
  form.issue.value = selected || '';
}

// The price field shows on reports with an estimate. Blank means "use the price list".
function updatePriceHint() {
  const listPrice = form.issue.value ? findingPrice({ issue: form.issue.value }, form.list, current.record.prices) : null;
  form.price.placeholder = listPrice != null ? formatMoney(listPrice) : 'No price';
  if (!form.issue.value) form.priceHint.textContent = 'Choose an issue to fill in its price.';
  else if (listPrice != null) form.priceHint.textContent = `This report’s price: ${formatMoney(listPrice)}. Type a different price for just this finding.`;
  else form.priceHint.textContent = 'This issue has no price yet. Type one here, or set it in Settings or the property profile.';
}
form.issue.addEventListener('change', updatePriceHint);
// Typing Controller or Pump (or a zone) in the Zone box switches to that section's issues.
form.zone.addEventListener('change', async () => {
  await fillIssues(form.issue.value);
  updatePriceHint();
});

async function openFindingForm(finding, preset = null) {
  form.title.textContent = finding ? 'Edit finding' : 'New finding';
  form.del.hidden = !finding;
  showPhotoError('');
  showLocStatus('');
  form.pick++;
  form.locating = null;
  form.more = finding && finding.morePhotos ? [...finding.morePhotos] : [];
  renderMorePhotos();
  setPhoto(finding ? finding.photo : null, finding ? finding.stamp || null : null);
  form.zone.value = finding ? finding.zone : zoneOf(current.record);
  await fillIssues(finding ? finding.issue : preset ? preset.issue : '');
  form.note.value = finding ? finding.note : '';
  form.priceBox.hidden = !current.record.estimate;
  form.priceHint.hidden = form.priceBox.hidden;
  form.price.value = finding && finding.price != null ? finding.price.toFixed(2) : '';
  updatePriceHint();
  form.property = await propertyFolder(current.record.folderId);
  const saved = await disclaimerFor(form.property);
  setDisclaimer(finding && finding.disclaimer ? finding.disclaimer : saved, !!(finding && finding.disclaimer));
  // Hidden when turned off, unless this finding already has one (so it can still be removed).
  $('#disclaimer-box').hidden = !(await disclaimerOnFor(form.property)) && !(finding && finding.disclaimer);
  form.dialog.scrollTop = 0;
  $('#finding-more').open = false;
  const shown = showDialog(form.dialog);
  // A photo taken before the issue was chosen goes into the form as if picked there.
  if (preset && preset.file) onPhotoPicked({ target: { files: [preset.file], value: '' } }, true);
  const result = await shown;
  const fields = {
    photo: form.photo,
    morePhotos: form.more.slice(),
    stamp: form.photoStamp,
    issue: form.issue.value,
    zone: form.zone.value.trim(),
    note: form.note.value.trim(),
    disclaimer: form.disclaimerCheck.checked ? form.disclaimer : '',
    // Kept as is when the price field is hidden. A price equal to the list price isn't stored,
    // so the finding follows later price list changes.
    price: form.priceBox.hidden ? (finding && finding.price != null ? finding.price : null) : toPrice(form.price.value),
  };
  if (fields.price != null && fields.price === findingPrice({ issue: fields.issue }, form.list, current.record.prices)) fields.price = null;
  setPhoto(null);
  form.more = [];
  renderMorePhotos();
  return { result, fields };
}

// New finding: either order works. Photo first takes the picture and then asks what's wrong;
// issue first picks the issue and then opens the form to add the photo.
async function addFinding(preset = null) {
  const { result, fields } = await openFindingForm(null, preset);
  if (result !== 'ok') return;
  const saved = await db.saveFinding(current.id, fields);
  checkStorage();
  // Keep the new finding's zone open even if it isn't the zone being worked in.
  if (saved.zone !== zoneOf(current.record)) zoneFolds(current.id, zoneOf(current.record)).set(saved.zone || '', true);
  await render();
  // Show the finding just added.
  const card = document.querySelector(`[data-id="${saved.id}"]`);
  if (card) card.scrollIntoView({ block: 'center' });
}

// ---------- Issue picker sheet ----------
// Step 1 shows the groups, with the four most used at the bottom in big buttons within thumb
// reach and the rest above them. Step 2 shows the group's issues. Resolves with the issue name,
// or null if cancelled.

const COMMON_GROUPS = ['Broken heads', 'Broken Risers & Nozzles', 'Leaks & Breaks', 'Head and nozzle adjustments'];
const SHORT_GROUPS = { 'Head and nozzle adjustments': 'Head & nozzle adjustments' };

async function pickIssue() {
  const sheet = $('#issue-sheet');
  const body = $('#sheet-body');
  const list = await issueListFor(current.record.folderId);
  const zone = zoneOf(current.record);
  const groups = groupsForZone(list, zone)
    .map((g) => ({ ...g, issues: g.issues.filter((i) => !i.off) }))
    .filter((g) => g.issues.length);
  const button = (text, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sheet-btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  // A group with a single issue (Other, Backflow) goes straight to the finding.
  const choose = (g) => (g.issues.length === 1 ? sheet.close(`issue:${g.issues[0].name}`) : showIssues(g));
  const showGroups = () => {
    $('#sheet-title').textContent = `What's wrong? ${zone ? zoneName(zone) : ''}`.trim();
    $('#sheet-back').hidden = true;
    // Sections show just their own group and Other, all in the big buttons.
    const common = isSection(zone) ? groups : COMMON_GROUPS.map((n) => groups.find((g) => g.name === n)).filter(Boolean);
    const rest = groups.filter((g) => !common.includes(g));
    const grid = (items, cls) => {
      const el = document.createElement('div');
      el.className = 'sheet-grid';
      el.append(...items.map((g) => button(SHORT_GROUPS[g.name] || g.name || 'Issues', cls, () => choose(g))));
      return el;
    };
    body.replaceChildren(...[rest.length && grid(rest, 'rare'), common.length && grid(common, 'common')].filter(Boolean));
  };
  const showIssues = (group) => {
    $('#sheet-title').textContent = group.name || 'Issues';
    $('#sheet-back').hidden = false;
    body.replaceChildren(...group.issues.map((i) => button(i.name, 'issue', () => sheet.close(`issue:${i.name}`))));
  };
  $('#sheet-back').onclick = showGroups;
  showGroups();
  const result = await showDialog(sheet);
  return result.startsWith('issue:') ? result.slice(6) : null;
}

async function addByIssue() {
  const issue = await pickIssue();
  if (issue) await addFinding({ issue });
}

async function addByPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const issue = await pickIssue();
  if (issue) await addFinding({ issue, file });
}

async function editFinding(finding) {
  const { result, fields } = await openFindingForm(finding);
  if (result === 'ok') {
    // A zone status mark stays one until its image is replaced with a photo.
    if (finding.mark && fields.photo === finding.photo) fields.mark = finding.mark;
    await db.saveFinding(finding.reportId, fields, finding.id);
    render();
  }
  if (result === 'delete') {
    if (!(await askConfirm('Delete finding', `Delete the “${finding.issue}” finding? This can’t be undone.`))) return;
    await db.deleteFinding(finding.id);
    render();
  }
}

// ---------- Zone status marks ----------
// One tap adds a finding for the current zone with a drawn image in place of a photo:
// a green check for "No issues found", or a red X that sets the issue to "Valve not opening"
// (priced from the list like any finding). finding.mark is 'ok' or 'fail'. Both open for
// editing like any other finding. A zone holds one mark: tapping the other one swaps it,
// and tapping the same one again doesn't add a second.

const MARKS = {
  ok: { color: '#1f9d55', issue: 'No issues found', toast: 'no issues found' },
  fail: { color: '#d32f2f', issue: 'Valve not opening', toast: 'valve not opening' },
};
const markImages = {};

function markImage(kind) {
  if (markImages[kind]) return markImages[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const ctx = c.getContext('2d');
  const { color } = MARKS[kind];
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 20; // frame
  const r = 36, m = 16, w = 600 - m * 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(m, m, w, w, r) : ctx.rect(m, m, w, w);
  ctx.stroke();
  ctx.lineWidth = 68;
  ctx.beginPath();
  if (kind === 'ok') {
    ctx.moveTo(156, 312);
    ctx.lineTo(256, 412);
    ctx.lineTo(448, 204);
  } else {
    ctx.moveTo(184, 184);
    ctx.lineTo(416, 416);
    ctx.moveTo(416, 184);
    ctx.lineTo(184, 416);
  }
  ctx.stroke();
  markImages[kind] = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return markImages[kind];
}

let marking = false;
async function addMark(kind) {
  if (marking || current.kind !== 'report') return;
  marking = true;
  $('#mark-ok').disabled = $('#mark-fail').disabled = true;
  try {
    const report = current.record;
    const zone = zoneOf(report);
    const marked = `${zone ? zoneName(zone) : 'Zone'} marked: ${MARKS[kind].toast}.`;
    const existing = (await db.listFindings(report.id)).filter((f) => f.mark && (f.zone || '') === (zone || ''));
    const same = existing.find((f) => f.mark === kind);
    if (same) {
      // Already marked this way: keep that one, and clear any extra marks saved before this fix.
      for (const f of existing) if (f !== same) await db.deleteFinding(f.id);
      if (kind === 'ok') {
        const next = stepZone(zone, 1);
        current.record = await db.updateReport(report.id, { currentZone: next });
        await render();
        showToast(`${marked} Now in ${zoneName(next)}.`, 'ok');
      } else {
        await render();
        showToast(`${zone ? zoneName(zone) : 'This zone'} is already marked: ${MARKS[kind].toast}.`, 'ok');
      }
      return;
    }
    const pos = await getPosition(6000); // the spot is handy for a valve that won't open
    const fields = {
      photo: await markImage(kind),
      morePhotos: [],
      stamp: { takenAt: Date.now(), ...(pos || {}) },
      issue: MARKS[kind].issue,
      zone,
      note: '',
      disclaimer: '',
      price: null,
      mark: kind,
    };
    const saved = await db.saveFinding(report.id, fields);
    for (const f of existing) await db.deleteFinding(f.id); // the other mark it replaces
    if (kind === 'ok') {
      // Nothing to log in a zone that passed, so go straight on to the next one.
      const next = stepZone(zone, 1);
      current.record = await db.updateReport(report.id, { currentZone: next });
      await render();
      showToast(`${marked} Now in ${zoneName(next)}.`, 'ok');
      return;
    }
    await render();
    const card = document.querySelector(`[data-id="${saved.id}"]`);
    if (card) card.scrollIntoView({ block: 'center' });
    showToast(`${marked} Tap it to edit.`, 'ok');
  } finally {
    marking = false;
    $('#mark-ok').disabled = $('#mark-fail').disabled = false;
  }
}

$('#mark-ok').addEventListener('click', () => addMark('ok'));
$('#mark-fail').addEventListener('click', () => addMark('fail'));

$('#export-pdf').addEventListener('click', () => exportPdf(current.record));
$('#send-approval').addEventListener('click', () => sendForApproval(current.record));
$('#show-coords').addEventListener('click', () => showCoordinates(current.record));
$('#header-more').addEventListener('click', () => current.kind === 'report' && reportMenu(current.record));

// Start GPS as the camera opens, so it's ready by the time the photo is taken.
$('#add-finding').addEventListener('click', () => {
  form.pendingPosition = getPosition();
  $('#dock-camera').click();
});
$('#dock-camera').addEventListener('change', addByPhoto);
$('#pick-issue').addEventListener('click', addByIssue);
