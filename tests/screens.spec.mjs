// Opens every screen of the app in a test browser and fails if any of them shows an error.
// It runs signed in with no connection to the server (the way a phone works in the field),
// on sample data written straight into the app's database.
import { test, expect } from '@playwright/test';

const ACCOUNT = {
  email: 'tech@example.com',
  access: 'test',
  refresh: 'test',
  expires: Date.now() + 365 * 24 * 3600000,
  account: { company: { id: 'c1', name: 'Test Irrigation', status: 'active' }, role: 'owner', admin: false, name: 'Test Tech', checkedAt: Date.now() },
};

let errors;

test.beforeEach(async ({ page, context }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(`console: ${m.text()}`));
  // No connection to Supabase or anything else outside the app.
  await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort('internetdisconnected'));
  await context.addInitScript((a) => localStorage.setItem('wetcheckCloud', JSON.stringify(a)), ACCOUNT);
});

test.afterEach(() => {
  expect(errors, 'errors on the page').toEqual([]);
});

// A property with a controller, a report with a few findings, and a subfolder.
async function seed(page) {
  await page.goto('./');
  await expect(page.locator('#folder-view')).toBeVisible();
  return page.evaluate(async () => {
    const db = await import('./js/db.js');
    const property = await db.createFolder('Oak Park HOA', db.ROOT);
    await db.updateFolder(property.id, {
      controllers: [{ id: 'ctl1', name: 'Front entrance', zones: 12, waterSource: 'municipal' }],
      profile: { contact: { name: 'Pat Manager', phone: '555-0100' } },
    });
    await db.createFolder('Phase 2', property.id);
    const report = await db.createReport(property.id, 'Wet check', '2026-10-21', { estimate: true, currentZone: '1', controllerId: 'ctl1', controllerName: 'Front entrance' });
    const stamp = { lat: 28.5383, lon: -81.3792, accuracy: 5, time: Date.now() };
    await db.saveFinding(report.id, { photo: null, issue: 'Broken 4" pop-up', zone: '1', note: 'By the mailbox', stamp });
    await db.saveFinding(report.id, { photo: null, issue: 'Clogged nozzle', zone: '2', note: '' });
    await db.saveFinding(report.id, { photo: null, issue: 'Leaking valve', zone: 'Controller', note: '' });
    return { propertyId: property.id, reportId: report.id };
  });
}

// Goes to a screen and checks that its view is the one showing.
async function open(page, hash, view, title) {
  await page.goto(`./${hash}`);
  await expect(page.locator(`#${view}`)).toBeVisible();
  if (title) await expect(page.locator('#title')).toHaveText(title);
  await expect(page.locator('#gate')).toBeHidden();
}

test('every screen opens', async ({ page }) => {
  const loaded = new Set();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1' && u.pathname !== '/') loaded.add(u.pathname.slice(1));
  });
  const { propertyId, reportId } = await seed(page);
  await open(page, '#/', 'folder-view', 'Properties');
  await expect(page.locator('#folder-list')).toContainText('Oak Park HOA');
  await open(page, `#/f/${propertyId}`, 'folder-view', 'Oak Park HOA');
  await expect(page.locator('#report-groups')).toContainText('Front entrance');
  await open(page, `#/r/${reportId}`, 'report-view', 'Wet check');
  await expect(page.locator('#finding-groups')).toContainText('Broken 4" pop-up');
  await open(page, `#/p/${propertyId}`, 'profile-view');
  await expect(page.locator('#profile-view')).toContainText('Front entrance');
  await open(page, '#/settings', 'settings-view', 'Settings');
  await open(page, '#/issues', 'issues-view');
  await open(page, '#/approvals', 'approvals-view');
  await open(page, '#/account', 'account-view');
  await open(page, '#/search', 'search-view', 'Search');
  await page.fill('#search-input', 'nozzle');
  await expect(page.locator('#search-results')).toContainText('Clogged nozzle');

  // Everything the app loaded must be in sw.js's list, or it won't open offline.
  const sw = await (await page.request.get('./sw.js')).text();
  const cached = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
  const missing = [...loaded].filter((p) => !cached.includes(p));
  expect(missing, 'files missing from FILES in sw.js').toEqual([]);
});

test('folders: add one, then go back', async ({ page }) => {
  await seed(page);
  await page.click('#fab');
  await page.fill('#name-dialog input', 'Maple Court');
  await page.locator('#name-dialog button[value="ok"], #name-dialog button[type="submit"]').first().click();
  await expect(page.locator('#folder-list')).toContainText('Maple Court');
  await page.locator('#folder-list a', { hasText: 'Maple Court' }).click();
  await expect(page.locator('#title')).toHaveText('Maple Court');
  await page.click('#back');
  await expect(page.locator('#title')).toHaveText('Properties');
});

test('report: zones, finding form and PDF export', async ({ page }) => {
  const { reportId } = await seed(page);
  await open(page, `#/r/${reportId}`, 'report-view', 'Wet check');
  await page.click('#zone-next');
  await expect(page.locator('#zone-value')).toHaveText('Zone 2');
  await page.click('#pick-issue');
  await expect(page.locator('#issue-sheet')).toBeVisible();
  await page.locator('#issue-sheet .sheet-btn', { hasText: 'Broken heads' }).click();
  await page.locator('#issue-sheet .sheet-btn.issue').first().click();
  await expect(page.locator('#finding-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#finding-dialog')).toBeHidden();
  await page.click('#export-pdf');
  await expect(page.locator('#pdf-title')).toHaveText('PDF ready', { timeout: 30000 });
});

test('new finding: photo first, then group and issue, then save', async ({ page }) => {
  const { reportId } = await seed(page);
  await open(page, `#/r/${reportId}`, 'report-view', 'Wet check');
  const before = await page.locator('#finding-groups .card').count();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/dock.png` });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#dock-camera', { name: 'a.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#issue-sheet')).toBeVisible();
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/sheet-groups.png` : undefined });
  await page.locator('#issue-sheet .sheet-btn', { hasText: 'Valve issues' }).click();
  await page.locator('#issue-sheet .sheet-btn.issue').first().click();
  await expect(page.locator('#photo-preview')).toBeVisible();
  await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/form.png` : undefined });
  await page.click('#finding-save');
  await expect(page.locator('#finding-dialog')).toBeHidden();
  await expect(page.locator('#finding-groups .card')).toHaveCount(before + 1);
});

test('the customer approval page and storage test page open', async ({ page }) => {
  await page.goto('./approve.html');
  await expect(page.locator('#failed-text')).toContainText('missing part of its address');
  await page.goto('./storage-test.html');
  await expect(page.locator('body')).toBeVisible();
});
