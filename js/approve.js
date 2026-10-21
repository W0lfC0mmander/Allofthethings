// The customer's approval page (approve.html?a=<token>), opened from the emailed link.
// Shows the proposal, takes a typed or drawn signature and sends it to the "approvals"
// Edge Function, which makes the signed PDF.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('a') || '';
const INK = '#14213d';
let mode = 'type';

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// "2026-10-20" -> "Oct 20, 2026" without a timezone shift.
function reportDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString(undefined, { dateStyle: 'medium' }) : iso || '';
}

async function call(body) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  // A legacy anon key is a JWT, which also gets past the gateway if "Verify JWT" was left on.
  if (SUPABASE_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  let res;
  try {
    res = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/approvals`, { method: 'POST', headers, body: JSON.stringify({ token, ...body }) });
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Something went wrong. Try again.');
  return out;
}

function fail(text) {
  $('#loading').hidden = true;
  $('#proposal').hidden = true;
  $('#failed').hidden = false;
  $('#failed-text').textContent = text;
}

function show(d) {
  if (/^#[0-9a-f]{6}$/i.test(d.accent || '')) {
    document.documentElement.style.setProperty('--accent', d.accent);
    document.querySelector('meta[name="theme-color"]').content = d.accent;
  }
  $('#company').textContent = d.companyName || 'Proposal';
  document.title = `${d.companyName ? d.companyName + ': ' : ''}Review and approve`;
  if (d.logoUrl) {
    $('#logo').src = d.logoUrl;
    $('#logo').hidden = false;
  }
  $('#property').textContent = d.property || 'Proposal';
  $('#report').textContent = [d.reportName, reportDate(d.reportDate)].filter(Boolean).join(' · ');
  $('#message').hidden = !d.message;
  $('#message').textContent = d.message || '';
  $('#pdf').href = d.pdfUrl || '#';

  const e = d.estimate;
  const itemized = e && e.itemized !== false;
  if (e && e.lines && e.lines.length) {
    $('#estimate').hidden = false;
    $('#amount-head').hidden = !itemized;
    $('#lines').replaceChildren(...e.lines.map((l) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => {
        const c = document.createElement('td');
        c.textContent = text;
        if (cls) c.className = cls;
        tr.append(c);
      };
      td(l.issue);
      td(String(l.qty), 'num');
      if (itemized) td(l.amount == null ? 'Not priced' : money(l.amount), 'num');
      return tr;
    }));
    const span = itemized ? 2 : 1;
    const sum = (label, value, cls = '') => {
      const tr = document.createElement('tr');
      tr.className = cls;
      const a = document.createElement('td');
      a.colSpan = span;
      a.textContent = label;
      const b = document.createElement('td');
      b.className = 'num';
      b.textContent = value;
      tr.append(a, b);
      return tr;
    };
    const rows = [];
    if (e.discount) rows.push(sum('Subtotal', money(e.subtotal)), sum(e.discountLabel || 'Discount', `−${money(e.discount)}`));
    rows.push(sum('Total', money(e.total), 'total'));
    $('#sums').replaceChildren(...rows);
    $('#unpriced').hidden = !e.unpriced;
    $('#unpriced').textContent = e.unpriced ? `Plus ${e.unpriced === 1 ? 'one item' : `${e.unpriced} items`} not yet priced.` : '';
  }
  $('#approve-text').textContent = e && e.total
    ? `By signing, you approve the repairs in this proposal for ${money(e.total)}${e.unpriced ? ', plus any items not yet priced' : ''}.`
    : 'By signing, you approve the repairs in this proposal.';
  if (!$('#name').value && d.customerName) {
    $('#name').value = d.customerName;
    renderTyped();
  }
  $('#contact').textContent = d.contactEmail ? `Questions? Email ${d.contactEmail}` : '';

  const open = d.status === 'sent';
  $('#sign').hidden = !open;
  $('#decline').hidden = true;
  $('#answered').hidden = open;
  if (!open) {
    const ok = d.status === 'approved';
    $('#answered-mark').setAttribute('d', ok ? 'M7.5 12.5l3 3 6-6.5' : 'M8.5 8.5l7 7m0-7l-7 7');
    $('#answered-title').textContent = ok ? 'Approved, thank you' : 'Proposal declined';
    $('#answered-text').textContent = ok
      ? `Signed by ${d.signerName || 'you'} on ${longDate(d.decidedAt)}. A signed copy was emailed to ${d.customerEmail}.`
      : `You declined this proposal on ${longDate(d.decidedAt)}. ${d.companyName || 'The sender'} has been told.`;
    $('#signed-pdf').hidden = !d.signedPdfUrl;
    if (d.signedPdfUrl) $('#signed-pdf').href = d.signedPdfUrl;
  }
  $('#loading').hidden = true;
  $('#proposal').hidden = false;
}

// ---------- signature ----------

function renderTyped() {
  const name = $('#name').value.trim();
  $('#typed').textContent = name;
  $('#typed-hint').hidden = !!name;
}

function setMode(m) {
  mode = m;
  $('#tab-type').classList.toggle('on', m === 'type');
  $('#tab-draw').classList.toggle('on', m === 'draw');
  $('#box-type').hidden = m !== 'type';
  $('#box-draw').hidden = m !== 'draw';
  if (m === 'draw') sizePad();
}

const pad = $('#pad');
const ctx = pad.getContext('2d');
let drawn = false;
let last = null;

function sizePad() {
  const r = pad.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(r.width * dpr);
  pad.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = INK;
  drawn = false;
  $('#pad-hint').hidden = false;
}

const point = (e) => {
  const r = pad.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  last = point(e);
  ctx.beginPath();
  ctx.arc(last.x, last.y, 1.3, 0, Math.PI * 2);
  ctx.fill();
  drawn = true;
  $('#pad-hint').hidden = true;
});
pad.addEventListener('pointermove', (e) => {
  if (!last) return;
  e.preventDefault();
  for (const ev of (e.getCoalescedEvents && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e])) {
    const p = point(ev);
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }
});
for (const t of ['pointerup', 'pointercancel']) pad.addEventListener(t, () => (last = null));
$('#pad-clear').addEventListener('click', sizePad);
window.addEventListener('resize', () => mode === 'draw' && !drawn && sizePad());

// The signature as a PNG data URL, cropped to the ink with a clear background.
function cropped(canvas) {
  const c = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const px = c.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 6; // margin around the ink
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function typedSignature(name) {
  await document.fonts.load('80px "Great Vibes"');
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '80px "Great Vibes", cursive';
  g.font = font;
  c.width = Math.ceil(g.measureText(name).width) + 60;
  c.height = 150;
  g.font = font;
  g.fillStyle = INK;
  g.textBaseline = 'middle';
  g.fillText(name, 30, 75);
  return cropped(c);
}

// ---------- answering ----------

function busy(button, on, text) {
  button.disabled = on;
  if (text) button.textContent = text;
}

$('#name').addEventListener('input', renderTyped);
$('#tab-type').addEventListener('click', () => setMode('type'));
$('#tab-draw').addEventListener('click', () => setMode('draw'));

$('#approve').addEventListener('click', async () => {
  const err = $('#sign-error');
  err.hidden = true;
  const name = $('#name').value.trim();
  const problem = !name ? 'Type your full name.'
    : mode === 'draw' && !drawn ? 'Sign in the box, or switch to Type.'
    : !$('#agree').checked ? 'Check the box to agree to sign electronically.'
    : '';
  if (problem) {
    err.textContent = problem;
    err.hidden = false;
    return;
  }
  const button = $('#approve');
  busy(button, true, 'Signing…');
  try {
    const signature = mode === 'draw' ? cropped(pad) : await typedSignature(name);
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    show(await call({ action: 'sign', name, method: mode === 'draw' ? 'drawn' : 'typed', signature, date, agree: true }));
    scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    busy(button, false, 'Approve and sign');
  }
});

$('#decline-open').addEventListener('click', () => {
  $('#sign').hidden = true;
  $('#decline').hidden = false;
});
$('#decline-back').addEventListener('click', () => {
  $('#decline').hidden = true;
  $('#sign').hidden = false;
});
$('#decline-send').addEventListener('click', async () => {
  const err = $('#decline-error');
  err.hidden = true;
  const button = $('#decline-send');
  busy(button, true, 'Sending…');
  try {
    show(await call({ action: 'decline', name: $('#name').value.trim(), reason: $('#reason').value.trim() }));
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    busy(button, false, 'Decline');
  }
});

if (!SUPABASE_URL || !SUPABASE_KEY) fail('Online approvals aren’t set up yet.');
else if (!token) fail('The link is missing part of its address. Open it again from the email.');
else call({ action: 'view' }).then(show, (e) => fail(e.message));
