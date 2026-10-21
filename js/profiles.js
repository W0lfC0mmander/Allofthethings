// Property profiles (#/p/<id>): contact, controllers, troubleshooting disclaimer, the
// property's own issues and prices, and its PDF export settings.

import * as db from './db.js';
import { $, showDialog, askConfirm, plural, WATER_SOURCES } from './ui.js';
import { compressPhoto } from './photo.js';
import { loadIssueList, effectiveList, priceSnapshot, formatMoney, findIssue } from './issues.js';
import { mapUrl, getPosition } from './location.js';
import { screens, render, profileHref, current, setCurrent, setHeader, showView, row, CONTROLLER_ICON } from './core.js';
import { askIssue } from './settings.js';

screens.profile = renderProfile;

export const DEFAULT_DISCLAIMER = '*Troubleshooting required. Additional proposals may be required to complete this repair.';
const DISCLAIMER_HINT = document.querySelector('#disclaimer-dialog .hint').textContent;
// ---------- Property profiles ----------

// The top-level property a folder belongs to (where its profile lives).
export async function propertyFolder(folderId) {
  const path = await db.getPath(folderId);
  return path[0] || null;
}

// The issue list for a folder: the main list with its property's changes applied.
export async function issueListFor(folderId) {
  const [list, property] = await Promise.all([loadIssueList(), propertyFolder(folderId)]);
  return effectiveList(list, property && property.profile);
}

export async function disclaimerFor(property) {
  if (property && property.profile && property.profile.disclaimer) return property.profile.disclaimer;
  return mainDisclaimer();
}

const mainDisclaimer = async () => (await db.getSetting('disclaimer')) || DEFAULT_DISCLAIMER;
// The disclaimer checkbox on findings can be turned off in Settings, and per property.
const mainDisclaimerOn = async () => (await db.getSetting('disclaimerEnabled')) !== false;
export async function disclaimerOnFor(property) {
  const own = property && property.profile ? property.profile.disclaimerOn : null;
  return own != null ? own : mainDisclaimerOn();
}

// The disclaimer dialog with its on/off switch. Resolves with { on, text } or null.
async function askDisclaimer({ title, hint, on, onLabel, text, resetTo }) {
  const input = $('#disclaimer-input');
  const box = $('#disclaimer-enabled');
  $('#disclaimer-dialog h2').textContent = title;
  $('#disclaimer-dialog .hint').textContent = hint;
  $('#disclaimer-enabled-box').hidden = false;
  $('#disclaimer-enabled-label').textContent = onLabel;
  box.checked = on;
  input.value = text;
  $('#disclaimer-reset').onclick = () => (input.value = resetTo);
  const result = await showDialog($('#disclaimer-dialog'));
  $('#disclaimer-dialog h2').textContent = 'Troubleshooting disclaimer';
  $('#disclaimer-dialog .hint').textContent = DISCLAIMER_HINT;
  $('#disclaimer-enabled-box').hidden = true;
  if (result !== 'ok') return null;
  return { on: box.checked, text: input.value.trim() };
}

export async function renderDisclaimerCard() {
  const [on, text] = await Promise.all([mainDisclaimerOn(), mainDisclaimer()]);
  $('#settings-disclaimer-name').textContent = `Troubleshooting disclaimer: ${on ? 'on' : 'off'}`;
  $('#settings-disclaimer-detail').textContent = on ? text : 'Not offered on findings. Tap to turn it on or edit it.';
}

$('#settings-disclaimer').addEventListener('click', async () => {
  const r = await askDisclaimer({
    title: 'Troubleshooting disclaimer',
    hint: 'When on, each finding has a checkbox to add this disclaimer. Properties can change it in their profile. Findings that already have a disclaimer keep it.',
    on: await mainDisclaimerOn(),
    onLabel: 'Offer the disclaimer on findings',
    text: await mainDisclaimer(),
    resetTo: DEFAULT_DISCLAIMER,
  });
  if (!r) return;
  await db.setSetting('disclaimerEnabled', r.on);
  if (r.text) await db.setSetting('disclaimer', r.text);
  render();
});

// Merges changes into a property's profile; drops it entirely once nothing is left in it.
export async function saveProfile(folderId, changes) {
  const folder = await db.getFolder(folderId);
  const profile = { issues: {}, added: [], disclaimer: null, disclaimerOn: null, contact: null, ...(folder.profile || {}), ...changes };
  const empty = !Object.keys(profile.issues).length && !profile.added.length && !profile.disclaimer && profile.disclaimerOn == null && !profile.contact;
  return db.updateFolder(folderId, { profile: empty ? null : profile });
}

// Reports keep the prices from the day they were made; this brings one up to today's.
export async function refreshPrices(report) {
  const ok = await askConfirm(
    'Use current prices',
    `Update “${report.name}” to today’s prices for this property? Prices typed on individual findings stay as they are.`,
    'Update'
  );
  if (!ok) return;
  await db.updateReport(report.id, { prices: priceSnapshot(await issueListFor(report.folderId)) });
  render();
}

// Reports made before prices were locked in (or restored from an older backup) get
// today's prices once, so later price changes don't move them.
export async function lockMissingPrices() {
  const reports = (await db.listAllReports()).filter((r) => !r.prices);
  for (const r of reports) await db.updateReport(r.id, { prices: priceSnapshot(await issueListFor(r.folderId)) });
}

export function renderProfileCard(property) {
  const card = $('#profile-card');
  card.hidden = !property;
  if (!property) return;
  const p = property.profile || {};
  const parts = [];
  if (p.contact && p.contact.name) parts.push(`Contact: ${p.contact.name}`);
  if (property.controllers && property.controllers.length) parts.push(plural(property.controllers.length, 'controller'));
  if (property.exportSettings && property.exportSettings.template !== 'full') parts.push(`${TEMPLATE_NAMES[property.exportSettings.template]} PDF`);
  const custom = Object.keys(p.issues || {}).length + (p.added || []).length;
  if (custom) parts.push(`${plural(custom, 'custom issue')}`);
  if (p.disclaimerOn === false) parts.push('disclaimer off');
  else if (p.disclaimer || p.disclaimerOn === true) parts.push('own disclaimer');
  $('#profile-card-detail').textContent = parts.length ? parts.join(' · ') : 'Contact, controllers, disclaimer, and issues and prices for this property.';
}

$('#profile-card').addEventListener('click', () => (location.hash = profileHref(current.id)));

let profileList = null; // effective list on the profile screen

async function renderProfile(id) {
  const folder = await db.getFolder(id);
  if (!folder) return (location.hash = '#/');
  setCurrent({ kind: 'profile', id, record: folder });
  setHeader({ title: 'Property profile', subtitle: folder.name, back: true });
  const p = folder.profile || {};

  const c = p.contact;
  $('#profile-contact-name').textContent = c && c.name ? c.name : c ? 'Property contact' : 'Add a property contact';
  $('#profile-contact-detail').textContent = c
    ? [c.phone, c.email, c.address].filter(Boolean).join(' · ') || 'Tap to edit.'
    : 'Shown on the cover of this property’s reports.';

  renderControllers(folder.controllers || []);
  const ex = exportSettingsOf(folder);
  $('#profile-export-name').textContent = TEMPLATE_NAMES[ex.template];
  const left = [!ex.photos && 'photos', !ex.prices ? 'prices' : !ex.itemized && 'individual prices', !ex.coords && 'locations'].filter(Boolean);
  $('#profile-export-detail').textContent = left.length ? `Leaves out ${left.join(' and ').replace(' and ', left.length > 2 ? ', ' : ' and ')}.` : 'Photos, prices and locations included.';

  const [mainText, mainOn] = await Promise.all([mainDisclaimer(), mainDisclaimerOn()]);
  const on = p.disclaimerOn != null ? p.disclaimerOn : mainOn;
  $('#profile-disclaimer-name').textContent = !on
    ? `Off for this property${p.disclaimerOn == null ? ' (off in Settings)' : ''}`
    : p.disclaimer ? 'Custom disclaimer for this property' : 'Using the main disclaimer';
  $('#profile-disclaimer-text').textContent = on ? p.disclaimer || mainText : 'Findings here won’t offer the disclaimer. Tap to change.';

  profileList = effectiveList(await loadIssueList(), p);
  $('#profile-issue-groups').replaceChildren(...profileList.groups.map((g) => {
    const section = document.createElement('section');
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = g.name || 'Issues';
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.issues.map((issue) => profileIssueRow(g, issue)));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small outline add-issue';
    add.textContent = '+ Add issue for this property';
    add.addEventListener('click', () => addProfileIssue(g));
    section.append(h, ul, add);
    return section;
  }));
  showView('profile');
}

function profileIssueRow(group, issue) {
  const li = document.createElement('li');
  li.className = 'issue-row' + (issue.off ? ' off' : '');
  const toggle = document.createElement('label');
  toggle.className = 'issue-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !issue.off;
  box.setAttribute('aria-label', `Use ${issue.name} at this property`);
  box.addEventListener('change', () => setProfileIssue(issue, { off: !box.checked }));
  toggle.append(box);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'issue-main';
  const name = document.createElement('span');
  name.className = 'issue-name';
  name.textContent = issue.name;
  main.append(name);
  if (issue.custom || issue.own) {
    const tag = document.createElement('span');
    tag.className = 'issue-tag' + (issue.own ? ' own' : '');
    tag.textContent = issue.own ? 'This property' : 'Custom';
    main.append(tag);
  }
  const price = document.createElement('span');
  price.className = 'issue-price' + (issue.price == null ? ' none' : '');
  price.textContent = issue.price == null ? 'No price' : formatMoney(issue.price);
  main.append(price);
  main.addEventListener('click', () => editProfileIssue(group, issue));
  li.append(toggle, main);
  return li;
}

// Records a change to one issue for this property. A main-list issue whose values end up
// matching the main list again stops being custom.
async function setProfileIssue(issue, changes) {
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  if (issue.own) {
    const added = (p.added || []).map((a) => (a.name === issue.name ? { ...a, ...changes } : a));
    await saveProfile(current.id, { added });
  } else {
    const issues = { ...(p.issues || {}) };
    const o = { ...(issues[issue.name] || {}), ...changes };
    const main = findIssue(await loadIssueList(), issue.name);
    if ('price' in o && main && o.price === main.price) delete o.price;
    if ('off' in o && main && o.off === !!main.off) delete o.off;
    if (Object.keys(o).length) issues[issue.name] = o;
    else delete issues[issue.name];
    await saveProfile(current.id, { issues });
  }
  render();
}

async function editProfileIssue(group, issue) {
  const mainHint = issue.own
    ? 'Only used at this property.'
    : `Main list price: ${issue.custom ? (issue.mainPrice == null ? 'no price' : formatMoney(issue.mainPrice)) : issue.price == null ? 'no price' : formatMoney(issue.price)}. To rename this issue, use Settings.`;
  const r = await askIssue(issue.name, issue, {
    list: profileList,
    nameLocked: !issue.own,
    canDelete: !!issue.own,
    canReset: !!issue.custom,
    mainHint,
    renameHint: false,
  });
  if (!r) return;
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  if (r === 'reset') {
    const issues = { ...(p.issues || {}) };
    delete issues[issue.name];
    await saveProfile(current.id, { issues });
    return render();
  }
  if (r === 'delete') {
    if (!(await askConfirm('Delete issue', `Remove “${issue.name}” from this property? Findings already saved with it keep it.`))) return;
    await saveProfile(current.id, { added: (p.added || []).filter((a) => a.name !== issue.name) });
    return render();
  }
  if (issue.own) {
    const added = (p.added || []).map((a) => (a.name === issue.name ? { ...a, name: r.name, price: r.price } : a));
    await saveProfile(current.id, { added });
    return render();
  }
  await setProfileIssue(issue, { price: r.price });
}

async function addProfileIssue(group) {
  const r = await askIssue(`Add to ${group.name || 'the list'} for this property`, null, { list: profileList, canDelete: false, renameHint: false, mainHint: 'Only used at this property.' });
  if (!r || typeof r === 'string') return;
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  await saveProfile(current.id, { added: [...(p.added || []), { group: group.name, name: r.name, price: r.price, off: false }] });
  render();
}

$('#profile-contact').addEventListener('click', async () => {
  const c = (current.record.profile && current.record.profile.contact) || {};
  $('#contact-name').value = c.name || '';
  $('#contact-phone').value = c.phone || '';
  $('#contact-email').value = c.email || '';
  $('#contact-address').value = c.address || '';
  if ((await showDialog($('#contact-dialog'))) !== 'ok') return;
  const contact = {
    name: $('#contact-name').value.trim(),
    phone: $('#contact-phone').value.trim(),
    email: $('#contact-email').value.trim(),
    address: $('#contact-address').value.trim(),
  };
  await saveProfile(current.id, { contact: Object.values(contact).some(Boolean) ? contact : null });
  render();
});

$('#profile-disclaimer').addEventListener('click', async () => {
  const p = current.record.profile || {};
  const [main, mainOn] = await Promise.all([mainDisclaimer(), mainDisclaimerOn()]);
  const r = await askDisclaimer({
    title: 'Disclaimer for this property',
    hint: 'Used on this property’s findings instead of the main disclaimer. Reset goes back to the main wording.',
    on: p.disclaimerOn != null ? p.disclaimerOn : mainOn,
    onLabel: 'Offer the disclaimer at this property',
    text: p.disclaimer || main,
    resetTo: main,
  });
  if (!r) return;
  // Only what differs from Settings is kept, so the rest keeps following it.
  await saveProfile(current.id, {
    disclaimer: r.text && r.text !== main ? r.text : null,
    disclaimerOn: r.on === mainOn ? null : r.on,
  });
  render();
});

// ---------- Controllers ----------
// Kept on the property folder as folder.controllers (not in the profile, so resetting the
// profile's settings leaves them alone): [{ id, name, photo (Blob), location {lat, lon, accuracy?}, make,
// model, zones, water (a WATER_SOURCES key), rainSensor 'yes'|'no', masterValve 'yes'|'no', pocLocation
// {lat, lon} (point of connection), poc (pump or backflow info) }].

const WATER_LABELS = { ...WATER_SOURCES, municipal: 'Municipal water' };

function controllerDetail(c) {
  const makeModel = [c.make, c.model].filter(Boolean).join(' ');
  return [
    makeModel,
    c.zones ? plural(c.zones, 'zone') : '',
    WATER_LABELS[c.water] || '',
    c.rainSensor === 'yes' ? 'Rain sensor' : c.rainSensor === 'no' ? 'No rain sensor' : '',
    c.masterValve === 'yes' ? 'Master valve' : c.masterValve === 'no' ? 'No master valve' : '',
  ].filter(Boolean).join(' · ');
}

let controllerUrls = [];

function renderControllers(list) {
  controllerUrls.forEach((u) => URL.revokeObjectURL(u));
  controllerUrls = [];
  $('#controller-empty').hidden = list.length > 0;
  $('#controller-list').replaceChildren(...list.map((c) => {
    const li = row({ icon: CONTROLLER_ICON, name: c.name, detail: controllerDetail(c) || 'Tap to add details.', href: '#' });
    if (c.photo instanceof Blob) {
      const img = document.createElement('img');
      img.className = 'ico thumb';
      img.alt = '';
      img.src = URL.createObjectURL(c.photo);
      controllerUrls.push(img.src);
      li.querySelector('.row-open svg').replaceWith(img);
    }
    li.querySelector('.row-open').addEventListener('click', (e) => {
      e.preventDefault();
      editController(c);
    });
    return li;
  }));
}

// "33.45, -112.07" (or with a space and no comma) -> { lat, lon }; null if it isn't a spot.
function parseCoords(text) {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const coordsField = (loc) => (loc ? `${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}` : '');

// A "Latitude, longitude" box with a Use my location button and a map link under it.
// Returns { value(), done() }; value() is { lat, lon, accuracy? } or null.
function locationField(inputId, buttonId, statusId, initial) {
  const input = $(`#${inputId}`);
  const button = $(`#${buttonId}`);
  const status = $(`#${statusId}`);
  let loc = initial || null;
  const show = (note = '') => {
    status.replaceChildren();
    if (note) status.textContent = note;
    if (loc) {
      const a = document.createElement('a');
      a.href = mapUrl(loc);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open in maps';
      status.append(note ? ' ' : '', a);
    }
  };
  input.value = coordsField(loc);
  input.setCustomValidity('');
  show();
  input.oninput = () => {
    const text = input.value.trim();
    loc = text ? parseCoords(text) : null;
    input.setCustomValidity(text && !loc ? 'Enter latitude, longitude, e.g. 33.4484, -112.0740' : '');
    show();
  };
  button.onclick = async () => {
    button.disabled = true;
    const before = loc;
    loc = null;
    show('Finding your location…');
    const pos = await getPosition();
    button.disabled = false;
    if (!pos) {
      loc = before;
      return show('Couldn’t get your location. Check that location is allowed for this app, or type the coordinates.');
    }
    loc = pos;
    input.value = coordsField(pos);
    input.setCustomValidity('');
    show(pos.accuracy ? `Within about ${pos.accuracy} m.` : '');
  };
  return { value: () => loc, done: () => (input.oninput = button.onclick = null) };
}

async function editController(existing) {
  const c = existing || {};
  $('#controller-title').textContent = existing ? 'Edit controller' : 'Add controller';
  $('#controller-name').value = c.name || '';
  $('#controller-make').value = c.make || '';
  $('#controller-model').value = c.model || '';
  $('#controller-zones').value = c.zones || '';
  // Controllers saved before the pump type was asked keep plain "Pump" until one is picked.
  const oldPump = $('#controller-water option[value="pump"]');
  oldPump.hidden = oldPump.disabled = c.water !== 'pump';
  $('#controller-water').value = c.water || '';
  $('#controller-rain').value = c.rainSensor || '';
  $('#controller-master').value = c.masterValve || '';
  $('#controller-poc').value = c.poc || '';
  $('#controller-delete').hidden = !existing;
  $('#controller-delete').onclick = () => $('#controller-dialog').close('delete');

  let photo = c.photo instanceof Blob ? c.photo : null;
  let photoUrl = null;
  const showPhoto = () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = photo ? URL.createObjectURL(photo) : null;
    const img = $('#controller-photo-img');
    img.hidden = !photo;
    if (photo) img.src = photoUrl;
    else img.removeAttribute('src');
    $('#controller-photo-remove').hidden = !photo;
  };
  const onPhoto = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      photo = await compressPhoto(file);
    } catch {
      return;
    }
    showPhoto();
  };
  $('#controller-camera').onchange = onPhoto;
  $('#controller-library').onchange = onPhoto;
  $('#controller-photo-remove').onclick = () => {
    photo = null;
    showPhoto();
  };
  showPhoto();

  const spot = locationField('controller-location', 'controller-here', 'controller-loc-status', c.location);
  const pocSpot = locationField('controller-poc-location', 'controller-poc-here', 'controller-poc-status', c.pocLocation);

  const answer = await showDialog($('#controller-dialog'));
  spot.done();
  pocSpot.done();
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  $('#controller-photo-img').removeAttribute('src');
  if (answer !== 'ok' && answer !== 'delete') return;
  const folder = await db.getFolder(current.id);
  const list = folder.controllers || [];
  if (answer === 'delete') {
    if (!(await askConfirm('Delete controller', `Remove “${c.name}” from this property? Reports already started from it keep its name.`))) return;
    await db.updateFolder(current.id, { controllers: list.filter((x) => x.id !== c.id) });
    return render();
  }
  const zones = parseInt($('#controller-zones').value, 10);
  const saved = {
    id: c.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
    name: $('#controller-name').value.trim(),
    photo,
    location: spot.value(),
    make: $('#controller-make').value.trim(),
    model: $('#controller-model').value.trim(),
    zones: zones > 0 ? zones : null,
    water: $('#controller-water').value,
    rainSensor: $('#controller-rain').value,
    masterValve: $('#controller-master').value,
    pocLocation: pocSpot.value(),
    poc: $('#controller-poc').value.trim(), // pump or backflow info
  };
  const next = existing ? list.map((x) => (x.id === c.id ? saved : x)) : [...list, saved];
  await db.updateFolder(current.id, { controllers: next });
  if (existing && saved.name !== c.name) {
    // Reports started from this controller show its new name.
    for (const r of await db.listAllReports()) if (r.controllerId === c.id) await db.updateReport(r.id, { controllerName: saved.name });
  }
  render();
}

$('#add-controller').addEventListener('click', () => editController(null));

// ---------- Export settings (per property) ----------
// folder.exportSettings on the top-level property: { template: 'full'|'compact'|'proposal',
// photos, prices, coords }. Kept out of the profile, so resetting the profile leaves it.

const TEMPLATE_NAMES = { full: 'Full report', compact: 'Compact', proposal: 'Estimate / proposal' };

export function exportSettingsOf(property) {
  return { template: 'full', photos: true, prices: true, itemized: true, coords: true, ...((property && property.exportSettings) || {}) };
}

$('#export-prices').addEventListener('change', () => {
  $('#export-itemized').disabled = !$('#export-prices').checked;
});

$('#profile-export').addEventListener('click', async () => {
  const ex = exportSettingsOf(current.record);
  for (const r of document.querySelectorAll('input[name="export-template"]')) r.checked = r.value === ex.template;
  $('#export-photos').checked = ex.photos;
  $('#export-prices').checked = ex.prices;
  $('#export-itemized').checked = ex.itemized;
  $('#export-itemized').disabled = !ex.prices;
  $('#export-coords').checked = ex.coords;
  if ((await showDialog($('#export-dialog'))) !== 'ok') return;
  const template = (document.querySelector('input[name="export-template"]:checked') || {}).value || 'full';
  await db.updateFolder(current.id, {
    exportSettings: { template, photos: $('#export-photos').checked, prices: $('#export-prices').checked, itemized: $('#export-itemized').checked, coords: $('#export-coords').checked },
  });
  render();
});

$('#reset-profile').addEventListener('click', async () => {
  const ok = await askConfirm(
    'Reset property',
    `Remove the contact, disclaimer and all custom issues and prices for “${current.record.name}”? It will use the main settings again. Controllers, export settings and existing reports’ prices stay.`,
    'Reset'
  );
  if (!ok) return;
  await db.updateFolder(current.id, { profile: null });
  render();
});
