// Storage test: fills the phone with pretend reports and photos until a chosen amount or
// until the browser refuses, to see how much the app can hold. Writes only to its own
// database (TEST_DB), which it deletes afterwards; the app's own data is only read.

const APP_DB = 'wetcheck';
const TEST_DB = 'wetcheck-storagetest';
const DEFAULT_PHOTO = 350 * 1024; // used when there are no real photos to measure yet
const MB = 1024 * 1024;

const $ = (sel) => document.querySelector(sel);

let running = false;
let stopAsked = false;
let avgPhoto = DEFAULT_PHOTO;
let real = null;
const result = { reports: 0, photos: 0, bytes: 0, ms: 0, startUsage: 0, endUsage: 0, quota: 0, error: '', target: '' };

function fmt(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
const num = (n) => Math.round(n).toLocaleString();

function log(text) {
  const t = new Date().toLocaleTimeString();
  $('#log').textContent += `${t}  ${text}\n`;
  $('#log').scrollTop = $('#log').scrollHeight;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Write was cancelled', 'AbortError'));
  });
}

async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// ---------- The app's real data (read only) ----------

// Opens the app's database only if it already exists: an open that would create it is
// cancelled, so this page can never leave an empty database for the app to trip over.
function openAppDb() {
  return new Promise((resolve) => {
    const req = indexedDB.open(APP_DB);
    req.onupgradeneeded = () => {
      req.transaction.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// Photo sizes inside a stored record: bytes ({ $bytes, type }) or older Blobs.
function photoSizes(v, out) {
  if (!v || typeof v !== 'object') return out;
  if (v instanceof Blob) {
    if (v.type.startsWith('image/')) out.push(v.size);
  } else if (v.$bytes instanceof ArrayBuffer) {
    out.push(v.$bytes.byteLength);
  } else if (Array.isArray(v)) {
    for (const x of v) photoSizes(x, out);
  } else if (!(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
    for (const x of Object.values(v)) photoSizes(x, out);
  }
  return out;
}

// Walks findings one at a time so a big collection never sits in memory at once.
async function measureRealData() {
  const db = await openAppDb();
  if (!db) return { reports: 0, findings: 0, photos: 0, photoBytes: 0, findingPhotos: 0, findingPhotoBytes: 0 };
  const out = { reports: 0, findings: 0, photos: 0, photoBytes: 0, findingPhotos: 0, findingPhotoBytes: 0 };
  try {
    const names = [...db.objectStoreNames];
    if (names.includes('reports')) out.reports = await promisify(db.transaction('reports').objectStore('reports').count());
    for (const store of names) {
      await new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          const sizes = photoSizes(c.value, []);
          out.photos += sizes.length;
          for (const s of sizes) out.photoBytes += s;
          if (store === 'findings') {
            out.findings++;
            out.findingPhotos += sizes.length;
            for (const s of sizes) out.findingPhotoBytes += s;
          }
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }
  } finally {
    db.close();
  }
  return out;
}

// ---------- Display ----------

async function refresh() {
  const est = await estimate();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  $('#persisted').textContent = persisted == null ? 'Unknown' : persisted ? 'Yes' : 'No';
  $('#persisted').className = persisted === false ? 'warn' : '';
  if (!est) {
    $('#used').textContent = 'Not reported';
    $('#quota').textContent = 'Not reported';
    $('#room').textContent = 'Run the test to find out';
    $('#pct').textContent = 'This browser doesn’t say how much room it has, so the test is the only way to know.';
    return null;
  }
  const { usage = 0, quota = 0 } = est;
  const pct = quota ? (usage / quota) * 100 : 0;
  $('#used').textContent = fmt(usage);
  $('#quota').textContent = fmt(quota);
  $('#bar').style.width = `${Math.min(100, pct)}%`;
  $('#pct').textContent = `${pct.toFixed(1)}% of the limit used`;
  $('#pct').className = pct >= 80 ? 'warn' : 'muted';
  const free = Math.max(0, quota - usage);
  const perReport = avgPhoto * perReportPhotos();
  $('#room').textContent = `${num(free / avgPhoto)} photos (≈ ${num(free / perReport)} reports of ${perReportPhotos()})`;
  return est;
}

function perReportPhotos() {
  const n = parseInt($('#per-report').value, 10);
  return n > 0 && n <= 200 ? n : 20;
}

function showResults() {
  $('#r-reports').textContent = num(result.reports);
  $('#r-photos').textContent = num(result.photos);
  $('#r-bytes').textContent = fmt(result.bytes);
  $('#r-speed').textContent = result.ms > 1000 ? `${(result.bytes / MB / (result.ms / 1000)).toFixed(1)} MB/s` : '–';
}

// ---------- Pretend data ----------

// One pretend photo, as many bytes as an average compressed photo. Random bytes don't
// shrink when the browser compresses what it stores, just like a real JPEG.
function makePhotoTemplate(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  bytes.set([0xff, 0xd8, 0xff, 0xe0]); // JPEG start marker, for realism
  return bytes;
}

// Each photo is its own copy with a few bytes changed, so nothing can be shared between them.
function photoCopy(template, n) {
  const copy = template.slice();
  const v = new DataView(copy.buffer);
  v.setUint32(8, n);
  v.setUint32(copy.length - 8, n ^ 0x5a5a5a5a);
  return { $bytes: copy.buffer, type: 'image/jpeg' };
}

function openTestDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TEST_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('reports', { keyPath: 'id' });
      db.createObjectStore('findings', { keyPath: 'id' }).createIndex('reportId', 'reportId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Zone Sense tabs and try again.'));
  });
}

async function testDbExists() {
  if (indexedDB.databases) {
    try {
      return (await indexedDB.databases()).some((d) => d.name === TEST_DB);
    } catch {}
  }
  return true; // can't tell, so offer the cleanup anyway
}

function deleteTestDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // finishes once this page's connection closes
  });
}

const ISSUES = ['Broken head', 'Clogged nozzle', 'Leaking valve', 'Misaligned head', 'Low pressure', 'Broken lateral line'];

// One report and its findings, saved in one go like the app does.
async function writeReport(db, template, n, photosPerReport) {
  const reportId = `test-report-${n}`;
  const now = Date.now();
  const tx = db.transaction(['reports', 'findings'], 'readwrite');
  tx.objectStore('reports').put({ id: reportId, folderId: 'test', name: `Pretend wet check ${n}`, date: '2026-01-01', controllerName: 'Controller A', createdAt: now, updatedAt: now });
  for (let i = 0; i < photosPerReport; i++) {
    tx.objectStore('findings').put({
      id: `${reportId}-f${i}`,
      reportId,
      photo: photoCopy(template, n * 1000 + i),
      morePhotos: [],
      issue: ISSUES[i % ISSUES.length],
      zone: String((i % 24) + 1),
      note: 'Pretend finding written by the storage test.',
      stamp: { lat: 33.4484, lng: -112.074, accuracy: 5, at: now },
      price: null,
      createdAt: now + i,
      updatedAt: now + i,
    });
  }
  await txDone(tx);
}

const isFull = (e) => e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota|space|full/i.test(e.message || ''));

async function runTest() {
  running = true;
  stopAsked = false;
  setButtons();
  Object.assign(result, { reports: 0, photos: 0, bytes: 0, ms: 0, error: '' });
  const targetMb = parseInt($('#target').value, 10);
  result.target = targetMb ? `${targetMb} MB` : 'until full';
  const photosPerReport = perReportPhotos();
  const before = await estimate();
  result.startUsage = before ? before.usage : 0;
  result.quota = before ? before.quota : 0;
  log(`Starting: ${photosPerReport} photos per report, ${fmt(avgPhoto)} per photo, fill ${result.target}.`);

  const template = makePhotoTemplate(Math.round(avgPhoto));
  const perReport = photosPerReport * template.length;
  const limit = targetMb ? targetMb * MB : Infinity;
  const started = performance.now();
  let lastShown = 0;
  let db;
  try {
    db = await openTestDb();
    while (!stopAsked && result.bytes + perReport <= limit) {
      await writeReport(db, template, result.reports + 1, photosPerReport);
      result.reports++;
      result.photos += photosPerReport;
      result.bytes += perReport;
      result.ms = performance.now() - started;
      if (performance.now() - lastShown > 700) {
        lastShown = performance.now();
        showResults();
        await refresh();
      }
    }
    log(stopAsked ? 'Stopped.' : `Reached ${result.target} without trouble.`);
  } catch (e) {
    result.error = `${e.name || 'Error'}: ${e.message || e}`;
    log(isFull(e) ? `The phone said it's full: ${result.error}` : `Stopped by an error: ${result.error}`);
  } finally {
    if (db) db.close();
    result.ms = performance.now() - started;
    const after = await estimate();
    result.endUsage = after ? after.usage : 0;
    if (after) result.quota = after.quota;
    running = false;
    showResults();
    await refresh();
    showVerdict();
    setButtons(true);
  }
}

function showVerdict() {
  const v = $('#verdict');
  const existing = real ? real.photos : 0;
  const total = existing + result.photos;
  const totalReports = Math.round(total / perReportPhotos());
  if (result.error && isFull({ name: result.error.split(':')[0], message: result.error })) {
    v.className = 'warn';
    v.textContent = `The phone ran out of room after ${num(result.photos)} pretend photos (${fmt(result.bytes)}). With your real photos, that's about ${num(total)} photos, or about ${num(totalReports)} reports of ${perReportPhotos()} photos, before the app can't save more. Tap Delete test data now.`;
  } else if (result.error) {
    v.className = 'warn';
    v.textContent = `Something other than space stopped the test after ${fmt(result.bytes)}: ${result.error}. Tap Copy results and send them over.`;
  } else {
    v.className = 'good';
    v.textContent = `Saved ${num(result.photos)} pretend photos (${fmt(result.bytes)}, about ${num(result.reports)} reports) with no trouble. With your real photos that's ${num(total)} photos the phone held at once. Tap Delete test data when you're done.`;
  }
}

function resultsText() {
  const lines = [
    `Zone Sense storage test, ${new Date().toLocaleString()}`,
    `Device: ${navigator.userAgent}`,
    `Standalone app: ${matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'yes' : 'no'}`,
    `Protected from cleanup: ${$('#persisted').textContent}`,
    `Real data: ${$('#real').textContent}, average photo ${fmt(avgPhoto)}`,
    `Limit reported: ${fmt(result.quota)}; used before ${fmt(result.startUsage)}, after ${fmt(result.endUsage)}`,
    `Fill: ${result.target}, ${perReportPhotos()} photos per report`,
    `Written: ${num(result.reports)} reports, ${num(result.photos)} photos, ${fmt(result.bytes)} in ${(result.ms / 1000).toFixed(1)} s`,
    `Stopped by: ${result.error || (stopAsked ? 'Stop button' : 'target reached')}`,
    `Result: ${$('#verdict').textContent}`,
  ];
  return lines.join('\n');
}

function setButtons(maybeLeftover = false) {
  $('#start').disabled = running;
  $('#stop').disabled = !running;
  $('#target').disabled = running;
  $('#per-report').disabled = running;
  $('#copy').disabled = running || !result.ms;
  if (running) $('#cleanup').disabled = true;
  else if (maybeLeftover) $('#cleanup').disabled = false;
}

$('#start').addEventListener('click', () => {
  if (!running) runTest();
});
$('#stop').addEventListener('click', () => {
  stopAsked = true;
  $('#stop').disabled = true;
  log('Stopping after the current report…');
});
$('#cleanup').addEventListener('click', async () => {
  $('#cleanup').disabled = true;
  log('Deleting test data…');
  try {
    await deleteTestDb();
    log('Test data deleted.');
  } catch (e) {
    log(`Couldn’t delete test data: ${e.message || e}`);
    $('#cleanup').disabled = false;
  }
  await refresh();
});
$('#copy').addEventListener('click', async () => {
  const text = resultsText();
  try {
    await navigator.clipboard.writeText(text);
    log('Results copied. Paste them into a message.');
  } catch {
    log(`Couldn’t copy automatically. Here they are:\n${text}`);
  }
});
$('#per-report').addEventListener('change', refresh);

// Leaving mid-test keeps the pretend data; warn so it isn't forgotten.
window.addEventListener('beforeunload', (e) => {
  if (running) e.preventDefault();
});

(async () => {
  await refresh();
  try {
    real = await measureRealData();
    if (real.findingPhotos) avgPhoto = real.findingPhotoBytes / real.findingPhotos;
    $('#real').textContent = `${num(real.reports)} reports, ${num(real.photos)} photos (${fmt(real.photoBytes)})`;
    $('#avg-photo').textContent = real.findingPhotos ? fmt(avgPhoto) : `${fmt(avgPhoto)} (guess, no photos yet)`;
  } catch (e) {
    $('#real').textContent = 'Couldn’t read';
    $('#avg-photo').textContent = `${fmt(avgPhoto)} (guess)`;
    log(`Couldn’t read the app’s data: ${e.message || e}`);
  }
  await refresh();
  if (await testDbExists()) {
    $('#cleanup').disabled = false;
    if (indexedDB.databases) log('Test data from an earlier run is still here. Tap Delete test data to remove it.');
  }
})();
