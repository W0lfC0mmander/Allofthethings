// Online approvals: the one Edge Function behind "Send for approval" in the app and the
// customer's approve.html page. Every request is a POST with an "action":
//
//   From the app (signed in, Authorization: Bearer <user token>):
//     send    multipart form: meta (JSON), pdf (file), logo (optional file). Stores the PDF
//             and emails the customer a link to approve.html?a=<token>.
//     status  { ids: [...] } -> where each request stands, with a link to the signed PDF.
//     cancel  { id } -> the link stops working.
//   From the customer's page (no sign-in, the token in the link is the key):
//     view    { token } -> the proposal summary and a link to its PDF.
//     sign    { token, name, method, signature (PNG data URL), date, agree: true }
//     decline { token, name, reason }
//   From anyone using the app (no sign-in):
//     bug     multipart form: action=bug, meta (JSON: description, email, info), screenshot
//             (optional image). Emails the report to BUG_REPORT_EMAIL and nobody else, at
//             most 5 an hour from one internet address and 50 a day in all.
//     reset   { email } -> emails a "choose a new password" link if that person is on a team.
//
//   Accounts (signed in). Zone Sense is invitation only: nobody can sign up, so every
//   account is made here and belongs to one company.
//     me              -> { user, company, role, admin }. Marks an invite as accepted.
//     team            -> { members } for the signed-in person's company.
//     invite          { email } (owner) -> adds a tech and emails them a link to set a password.
//     remove_member   { userId } (owner)
//     update_company  { name, replyTo } (owner)
//     companies       (Zone Sense admin) -> every company, for running the beta.
//     create_company  { name, ownerEmail } (Zone Sense admin) -> a company and its owner's invite.
//
// Signing fills the PDF's customer approval fields (signature image, date, printed name),
// adds a signature certificate page (who, when, IP, device, fingerprint of the original),
// stores the signed copy and emails it to the customer and the technician.
//
// Secrets (Edge Functions > Secrets): RESEND_API_KEY, and optionally RESEND_FROM
// ("Company <approvals@yourdomain.com>"), APPROVE_URL, APP_URL (where invite links open),
// ADMIN_EMAILS (comma separated Zone Sense admins, who can add companies) and
// BUG_REPORT_EMAIL (where bug reports go). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.
// Turn "Verify JWT" off for this function: the customer's page has no sign-in.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFDict } from 'npm:pdf-lib@1.17.1';

const env = (k: string, d = '') => Deno.env.get(k) || d;
const BUCKET = 'approvals';
const APPROVE_URL = () => env('APPROVE_URL', 'https://app.zonesenseirrigation.com/approve.html');
const APP_URL = () => env('APP_URL', APPROVE_URL().replace(/approve\.html.*$/, ''));
const FROM = () => env('RESEND_FROM', 'Zone Sense <onboarding@resend.dev>');
const MAX_PDF = 25 * 1024 * 1024;
const MAX_ATTACHMENT = 20 * 1024 * 1024;
const BUG_REPORT_EMAIL = () => env('BUG_REPORT_EMAIL', 'djimenez@zonesenseirrigation.com');
const MAX_SCREENSHOT = 3 * 1024 * 1024; // the app shrinks screenshots well under this
// Bug reports need no sign-in, so they're capped to keep anyone from using up the email quota.
const BUG_PER_HOUR = 5; // from one internet address
const BUG_PER_DAY = 50; // from everyone together
// An unanswered approval link stops working this long after it was sent; the app can send a new one.
const LINK_DAYS = 30;
const expired = (row: Record<string, any>) => row.status === 'sent' && Date.now() - Date.parse(row.sent_at) > LINK_DAYS * 24 * 3600 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class Fail extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
let client: any = null;
// deno-lint-ignore no-explicit-any
const sb = (): any => (client ||= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } }));

// ---------- helpers ----------

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(bytes: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: number) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const utc = (d: string | Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '');
const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);

async function user(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new Fail(401, 'Sign in first.');
  const { data, error } = await sb().auth.getUser(jwt);
  if (error || !data.user) throw new Fail(401, 'Your sign-in has expired. Sign in again.');
  return data.user;
}

const isAdmin = (u: { email?: string }) =>
  env('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).includes((u.email || '').toLowerCase());

// The signed-in person and their company. Everything a company does goes through here, so
// one company never sees another's people or proposals.
async function member(req: Request, { owner = false } = {}) {
  const u = await user(req);
  const { data: m } = await sb().from('members').select('*').eq('user_id', u.id).maybeSingle();
  if (!m) throw new Fail(403, 'Your account isn’t part of a company yet.');
  const { data: company } = await sb().from('companies').select('*').eq('id', m.company_id).maybeSingle();
  if (!company) throw new Fail(403, 'Your account isn’t part of a company yet.');
  if (company.status !== 'active') throw new Fail(403, 'Your company’s Zone Sense account is paused. Contact Zone Sense.');
  if (owner && m.role !== 'owner') throw new Fail(403, 'Only the company’s owner can do that.');
  return { u, m, company };
}

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function link(path: string | null, seconds = 3600, download?: string) {
  if (!path) return null;
  const { data } = await sb().storage.from(BUCKET).createSignedUrl(path, seconds, download ? { download } : undefined);
  return data ? data.signedUrl : null;
}

async function upload(path: string, bytes: Uint8Array | Blob, type: string) {
  const { error } = await sb().storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
  if (error) throw new Fail(500, `Couldn’t store the file: ${error.message}`);
}

async function download(path: string) {
  const { data, error } = await sb().storage.from(BUCKET).download(path);
  if (error || !data) throw new Fail(500, 'Couldn’t read the proposal file.');
  return new Uint8Array(await data.arrayBuffer());
}

// Every company sends from the one Zone Sense address, under its own name ("Acme Irrigation
// via Zone Sense"), with replies going to the person who sent the proposal.
function sender(company?: string) {
  const from = FROM();
  const name = (company || '').replace(/["<>\r\n]/g, '').trim().slice(0, 80);
  if (!name) return from;
  const addr = (from.match(/<([^>]+)>/) || [, from.trim()])[1];
  return `"${name} via Zone Sense" <${addr}>`;
}

async function email(msg: { to: string[]; subject: string; html: string; fromName?: string; replyTo?: string; attachments?: { filename: string; content: string }[] }) {
  const key = env('RESEND_API_KEY');
  if (!key) throw new Fail(500, 'Email isn’t set up yet: add RESEND_API_KEY to the function’s secrets.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: sender(msg.fromName), to: msg.to, subject: msg.subject, html: msg.html, reply_to: msg.replyTo, attachments: msg.attachments }),
  });
  if (!res.ok) {
    const t = await res.text();
    let m = t;
    try {
      m = JSON.parse(t).message || t;
    } catch { /* plain text */ }
    throw new Fail(502, `The email couldn’t be sent: ${m}`);
  }
}

function base64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function emailShell(accent: string, company: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f3f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${esc(accent)};color:#fff;padding:18px 24px;font-size:18px;font-weight:600">${esc(company)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">${body}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (accent: string, href: string, text: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:${esc(accent)};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(text)}</a></p>`;

// What the customer's page shows. Never includes the owner's id or file paths.
async function publicView(row: Record<string, any>) {
  return {
    status: row.status,
    companyName: row.company_name,
    accent: row.accent,
    logoUrl: await link(row.logo_path),
    property: row.property,
    reportName: row.report_name,
    reportDate: row.report_date,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    message: row.message,
    estimate: row.estimate,
    pdfUrl: await link(row.pdf_path),
    signedPdfUrl: row.status === 'approved' ? await link(row.signed_pdf_path, 3600, signedName(row)) : null,
    decidedAt: row.decided_at,
    signerName: row.signer_name,
    contactEmail: row.reply_to || row.owner_email,
  };
}

const signedName = (row: Record<string, any>) => (row.pdf_name || 'Proposal.pdf').replace(/\.pdf$/i, '') + ' - signed.pdf';

async function byToken(token: unknown) {
  if (typeof token !== 'string' || token.length < 20) throw new Fail(404, 'This approval link isn’t valid.');
  const { data } = await sb().from('approvals').select('*').eq('token', token).maybeSingle();
  if (!data) throw new Fail(404, 'This approval link isn’t valid.');
  if (data.status === 'cancelled') throw new Fail(410, 'This proposal was withdrawn. Contact the sender for a new link.');
  if (expired(data)) {
    await sb().from('approvals').update({ status: 'cancelled' }).eq('id', data.id).eq('status', 'sent');
    throw new Fail(410, `This link expired ${LINK_DAYS} days after it was sent. Contact ${data.reply_to || data.owner_email} for a new one.`);
  }
  return data;
}

// ---------- the signed PDF ----------

const FIELD_SIG = 'Customer signature';
const FIELD_DATE = 'Date';
const FIELD_NAME = 'Printed name';

export async function stampPdf(original: Uint8Array, s: {
  signature: Uint8Array; name: string; date: string; signedAt: Date; email: string; ip: string; agent: string;
  sentAt: string; viewedAt: string | null; sentTo: string; property: string; title: string; total: string; sha: string; id: string; company: string;
}) {
  const doc = await PDFDocument.load(original);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.08, 0.13, 0.24);
  const muted = rgb(0.42, 0.45, 0.5);
  const pages = doc.getPages();

  // Where each approval field sits: its page and rectangle. The fields are removed after,
  // so the signed copy can't be typed over.
  const form = doc.getForm();
  const spot = (name: string) => {
    let field;
    try {
      field = form.getField(name);
    } catch {
      return null;
    }
    const w = field.acroField.getWidgets()[0];
    if (!w) return null;
    const ref = doc.context.getObjectRef(w.dict);
    let page = pages.find((p) => {
      const annots = p.node.lookup(PDFName.of('Annots'));
      return annots instanceof PDFArray && annots.asArray().some((a) => a === ref);
    });
    if (!page) page = pages[pages.length - 1];
    return { field, page, rect: w.getRectangle() };
  };
  const sig = spot(FIELD_SIG);
  const date = spot(FIELD_DATE);
  const printed = spot(FIELD_NAME);

  const img = await doc.embedPng(s.signature);
  if (sig) {
    // Fit the signature on the line, allowing it to rise a little above the field.
    const { page, rect } = sig;
    const maxH = rect.height + 20;
    const scale = Math.min(maxH / img.height, rect.width / img.width);
    page.drawImage(img, { x: rect.x + 2, y: rect.y + 2, width: img.width * scale, height: img.height * scale });
  }
  if (date) date.page.drawText(s.date, { x: date.rect.x + 2, y: date.rect.y + 5, size: 11, font: helv, color: ink });
  if (printed) {
    const { page, rect } = printed;
    page.drawText(s.name, { x: rect.x + 2, y: rect.y + 5, size: 11, font: helv, color: ink });
    // Replace the "Tap a line to fill it in" hint under the name line.
    const hintY = rect.y - 33;
    page.drawRectangle({ x: rect.x - 2, y: hintY - 4, width: page.getWidth() - 2 * rect.x + 4, height: 14, color: rgb(1, 1, 1) });
    page.drawText(`Signed electronically on ${utc(s.signedAt)}. See the signature certificate at the end.`, {
      x: rect.x, y: hintY, size: 8, font: helv, color: muted,
    });
  }
  // pdf-lib's removeField needs appearance streams, which jsPDF doesn't write: unlink the
  // widgets from their pages and the fields from the form by hand.
  const drop = (arr: unknown, ref: unknown) => {
    if (!(arr instanceof PDFArray)) return;
    const i = arr.asArray().findIndex((a) => a === ref);
    if (i >= 0) arr.remove(i);
  };
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
  for (const f of [sig, date, printed]) {
    if (!f) continue;
    for (const w of f.field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      for (const p of pages) drop(p.node.lookup(PDFName.of('Annots')), ref);
    }
    if (acro instanceof PDFDict) drop(acro.lookup(PDFName.of('Fields')), f.field.ref);
  }

  // Signature certificate.
  const [w, h] = pages.length ? [pages[0].getWidth(), pages[0].getHeight()] : [612, 792];
  const page = doc.addPage([w, h]);
  const m = 54;
  let y = h - m;
  page.drawText('Signature certificate', { x: m, y: y - 18, size: 20, font: bold, color: ink });
  y -= 44;
  page.drawText(`${s.company ? s.company + ' · ' : ''}${s.title}`, { x: m, y, size: 11, font: helv, color: muted });
  y -= 30;
  const row = (k: string, v: string) => {
    page.drawText(k, { x: m, y, size: 9, font: bold, color: muted });
    const lines = wrap(v || '-', helv, 10, w - 2 * m - 150);
    for (const l of lines) {
      page.drawText(l, { x: m + 150, y, size: 10, font: helv, color: ink });
      y -= 15;
    }
    y -= 6;
  };
  row('Property', s.property);
  if (s.total) row('Approved amount', s.total);
  row('Sent to', s.sentTo);
  row('Sent', utc(s.sentAt));
  row('First opened', utc(s.viewedAt));
  row('Signed by', s.name);
  row('Signer email', s.email);
  row('Signed', utc(s.signedAt));
  row('IP address', s.ip);
  row('Device', s.agent);
  row('Approval ID', s.id);
  row('Original document SHA-256', s.sha);
  y -= 8;
  page.drawText('Signature', { x: m, y, size: 9, font: bold, color: muted });
  const scale = Math.min(60 / img.height, 260 / img.width);
  page.drawImage(img, { x: m + 150, y: y - 50, width: img.width * scale, height: img.height * scale });
  y -= 80;
  const note = `The signer opened this proposal from a private link emailed to ${s.sentTo}, reviewed it, agreed to sign electronically, and approved it by signing above. This certificate was added by the approval system when the proposal was signed.`;
  for (const l of wrap(note, helv, 9, w - 2 * m)) {
    page.drawText(l, { x: m, y, size: 9, font: helv, color: muted });
    y -= 13;
  }

  doc.setTitle(`${s.title} (signed)`);
  doc.setModificationDate(s.signedAt);
  return await doc.save();
}

function wrap(text: string, font: any, size: number, width: number) {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      // Long unbroken strings (hashes, user agents) are cut to fit.
      let wd = word;
      while (font.widthOfTextAtSize(wd, size) > width) {
        let n = wd.length;
        while (n > 1 && font.widthOfTextAtSize(wd.slice(0, n), size) > width) n--;
        if (line) out.push(line), (line = '');
        out.push(wd.slice(0, n));
        wd = wd.slice(n);
      }
      const t = line ? `${line} ${wd}` : wd;
      if (font.widthOfTextAtSize(t, size) > width) {
        out.push(line);
        line = wd;
      } else line = t;
    }
    out.push(line);
  }
  return out;
}

// WinAnsi (the standard PDF fonts) can't draw every character; swap what it can't.
const pdfSafe = (s: string) => s.normalize('NFKD').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '');

// ---------- actions ----------

async function send(req: Request, form: FormData) {
  const { u, company: co } = await member(req);
  const meta = JSON.parse(String(form.get('meta') || '{}'));
  const pdf = form.get('pdf');
  if (!(pdf instanceof File) || !pdf.size) throw new Fail(400, 'The proposal PDF is missing.');
  if (pdf.size > MAX_PDF) throw new Fail(413, 'This PDF is too large to send (over 25 MB). Try turning photos off in the property’s export settings.');
  const to = clip(meta.customerEmail, 200).toLowerCase();
  if (!validEmail(to)) throw new Fail(400, 'Enter the customer’s email address.');

  const id = crypto.randomUUID();
  const token = randomToken();
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  const pdfPath = `${u.id}/${id}/proposal.pdf`;
  await upload(pdfPath, bytes, 'application/pdf');
  let logoPath: string | null = null;
  const logo = form.get('logo');
  if (logo instanceof File && logo.size && logo.size < 2 * 1024 * 1024) {
    // Only PNG or JPEG, judged by the file's first bytes rather than what the phone calls it.
    const b = new Uint8Array(await logo.slice(0, 8).arrayBuffer());
    const kind = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png'
      : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : null;
    if (kind) {
      logoPath = `${u.id}/${id}/logo.${kind}`;
      await upload(logoPath, logo, kind === 'png' ? 'image/png' : 'image/jpeg');
    }
  }

  const row = {
    id, token, owner: u.id, owner_email: u.email,
    company_id: co.id,
    // The company's own name and reply-to address, never what the phone says.
    company_name: co.name,
    reply_to: co.reply_to || u.email,
    accent: /^#[0-9a-f]{6}$/i.test(meta.accent || '') ? meta.accent : '#0e7490',
    logo_path: logoPath,
    property: clip(meta.property, 300),
    report_name: clip(meta.reportName, 200),
    report_date: clip(meta.reportDate, 20),
    customer_name: clip(meta.customerName, 120),
    customer_email: to,
    message: clip(meta.message, 2000),
    estimate: meta.estimate || null,
    pdf_path: pdfPath,
    pdf_name: clip(meta.pdfName, 200) || 'Proposal.pdf',
    pdf_sha256: await sha256(bytes),
  };
  const { error } = await sb().from('approvals').insert(row);
  if (error) throw new Fail(500, `Couldn’t save the request: ${error.message}`);
  // A new request for the same report replaces the old link.
  if (meta.replaces) await sb().from('approvals').update({ status: 'cancelled' }).eq('id', meta.replaces).eq('owner', u.id).eq('status', 'sent');

  const company = row.company_name || 'Your irrigation contractor';
  const href = `${APPROVE_URL()}?a=${token}`;
  const total = row.estimate && row.estimate.total ? ` for ${money(row.estimate.total)}` : '';
  try {
    await email({
      to: [to],
      fromName: row.company_name,
      replyTo: row.reply_to,
      subject: `Please review and approve: ${row.property || row.report_name}`,
      html: emailShell(row.accent, company, `
        <p>Hi ${esc(row.customer_name || 'there')},</p>
        <p>${esc(company)} sent you a proposal${esc(total)} for <strong>${esc(row.property)}</strong> to review and approve.</p>
        ${row.message ? `<p style="white-space:pre-wrap;border-left:3px solid #e5e7eb;padding-left:12px;color:#4b5563">${esc(row.message)}</p>` : ''}
        ${button(row.accent, href, 'Review and sign')}
        <p style="color:#6b7280;font-size:13px">You can read the full proposal before signing. The link works for ${LINK_DAYS} days. Questions? Just reply to this email.</p>`),
    });
  } catch (err) {
    await sb().from('approvals').update({ status: 'cancelled' }).eq('id', id);
    throw err;
  }
  return json({ id, status: 'sent', sentAt: new Date().toISOString(), sentTo: to });
}

async function status(req: Request, body: any) {
  const { u } = await member(req);
  const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x: unknown) => typeof x === 'string').slice(0, 200);
  if (!ids.length) return json({ items: [] });
  const { data, error } = await sb().from('approvals')
    .select('id,status,customer_email,sent_at,viewed_at,decided_at,signer_name,decline_reason,signed_pdf_path,pdf_name')
    .eq('owner', u.id).in('id', ids);
  if (error) throw new Fail(500, error.message);
  const old = data.filter(expired).map((r: any) => r.id);
  if (old.length) await sb().from('approvals').update({ status: 'cancelled' }).in('id', old).eq('status', 'sent');
  const items = await Promise.all(data.map(async (r: any) => ({
    id: r.id, status: old.includes(r.id) ? 'cancelled' : r.status, expired: old.includes(r.id), sentTo: r.customer_email, sentAt: r.sent_at, viewedAt: r.viewed_at,
    decidedAt: r.decided_at, signerName: r.signer_name, declineReason: r.decline_reason,
    signedPdfUrl: r.status === 'approved' ? await link(r.signed_pdf_path, 600) : null,
    signedPdfName: signedName(r),
  })));
  return json({ items });
}

async function cancel(req: Request, body: any) {
  const { u } = await member(req);
  const { error } = await sb().from('approvals').update({ status: 'cancelled' }).eq('id', body.id).eq('owner', u.id).eq('status', 'sent');
  if (error) throw new Fail(500, error.message);
  return json({ ok: true });
}

async function view(body: any) {
  const row = await byToken(body.token);
  if (!row.viewed_at) {
    row.viewed_at = new Date().toISOString();
    await sb().from('approvals').update({ viewed_at: row.viewed_at }).eq('id', row.id).is('viewed_at', null);
  }
  return json(await publicView(row));
}

function requester(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || '';
  return { ip, agent: clip(req.headers.get('user-agent'), 400) };
}

async function sign(req: Request, body: any) {
  const row = await byToken(body.token);
  if (row.status !== 'sent') throw new Fail(409, row.status === 'approved' ? 'This proposal has already been approved.' : 'This proposal was already answered.');
  const name = clip(body.name, 120);
  if (!name) throw new Fail(400, 'Type your full name.');
  if (body.agree !== true) throw new Fail(400, 'Check the box to agree to sign electronically.');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.signature || ''));
  if (!m || m[1].length > 1_500_000) throw new Fail(400, 'Add your signature.');
  const png = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  const method = body.method === 'drawn' ? 'drawn' : 'typed';
  const { ip, agent } = requester(req);
  const signedAt = new Date();

  const original = await download(row.pdf_path);
  const est = row.estimate;
  const signed = await stampPdf(original, {
    signature: png,
    name: pdfSafe(name),
    date: pdfSafe(clip(body.date, 40)) || signedAt.toISOString().slice(0, 10),
    signedAt,
    email: row.customer_email,
    ip, agent: pdfSafe(agent),
    sentAt: row.sent_at, viewedAt: row.viewed_at, sentTo: row.customer_email,
    property: pdfSafe(row.property || ''), title: pdfSafe(row.report_name || 'Proposal'),
    total: est && est.total ? money(est.total) + (est.unpriced ? ' plus items not yet priced' : '') : '',
    sha: row.pdf_sha256, id: row.id, company: pdfSafe(row.company_name || ''),
  });
  const base = `${row.owner}/${row.id}`;
  await upload(`${base}/signature.png`, png, 'image/png');
  await upload(`${base}/signed.pdf`, signed, 'application/pdf');

  // Only the first answer counts, even if two arrive at once.
  const { data: updated } = await sb().from('approvals').update({
    status: 'approved', decided_at: signedAt.toISOString(), signer_name: name, signature_method: method,
    signature_path: `${base}/signature.png`, signed_pdf_path: `${base}/signed.pdf`, signer_ip: ip, signer_agent: agent,
  }).eq('id', row.id).eq('status', 'sent').select('id');
  if (!updated || !updated.length) throw new Fail(409, 'This proposal was already answered.');

  const company = row.company_name || 'Your irrigation contractor';
  // Email providers refuse large attachments (Resend: 40 MB total, after base64 encoding),
  // so a big signed copy goes as a download link that works for 30 days instead.
  const attach = signed.length <= MAX_ATTACHMENT;
  const attachments = attach ? [{ filename: signedName(row), content: base64(signed) }] : undefined;
  const href = attach ? '' : await link(`${base}/signed.pdf`, 30 * 24 * 3600, signedName(row));
  const copy = attach ? 'Your signed copy is attached.' : `Download your signed copy (link works for 30 days):</p>${button(row.accent, href || '', 'Download signed copy')}<p>`;
  const ownerCopy = attach ? 'The signed copy with its signature certificate is attached' : `Download the signed copy with its signature certificate (link works for 30 days):</p>${button(row.accent, href || '', 'Download signed copy')}<p>It’s also`;
  const total = est && est.total ? ` for ${money(est.total)}` : '';
  // The approval is saved; a failed email shouldn't tell the customer it wasn't.
  await Promise.allSettled([
    email({
      to: [row.customer_email], fromName: row.company_name, replyTo: row.reply_to || row.owner_email, attachments,
      subject: `Your signed approval: ${row.property || row.report_name}`,
      html: emailShell(row.accent, company, `<p>Thank you, ${esc(name)}.</p><p>You approved the proposal${esc(total)} for <strong>${esc(row.property)}</strong>. ${copy}</p>`),
    }),
    email({
      to: [row.owner_email], attachments,
      subject: `Approved: ${row.property || row.report_name}${total}`,
      html: emailShell(row.accent, company, `<p><strong>${esc(name)}</strong> (${esc(row.customer_email)}) approved the proposal${esc(total)} for <strong>${esc(row.property)}</strong> on ${esc(utc(signedAt))}.</p><p>${ownerCopy}${attach ? ', and it’s' : ''} in the app on the report.</p>`),
    }),
  ]);
  return json(await publicView({ ...row, status: 'approved', decided_at: signedAt.toISOString(), signer_name: name, signed_pdf_path: `${base}/signed.pdf` }));
}

async function decline(req: Request, body: any) {
  const row = await byToken(body.token);
  if (row.status !== 'sent') throw new Fail(409, 'This proposal was already answered.');
  const { ip, agent } = requester(req);
  const now = new Date().toISOString();
  const name = clip(body.name, 120);
  const reason = clip(body.reason, 2000);
  const { data: updated } = await sb().from('approvals').update({
    status: 'declined', decided_at: now, signer_name: name || null, decline_reason: reason || null, signer_ip: ip, signer_agent: agent,
  }).eq('id', row.id).eq('status', 'sent').select('id');
  if (!updated || !updated.length) throw new Fail(409, 'This proposal was already answered.');
  await Promise.allSettled([email({
    to: [row.owner_email], replyTo: row.customer_email,
    subject: `Declined: ${row.property || row.report_name}`,
    html: emailShell(row.accent, row.company_name || 'Zone Sense', `<p>${esc(name || row.customer_email)} declined the proposal for <strong>${esc(row.property)}</strong>.</p>${reason ? `<p style="white-space:pre-wrap;border-left:3px solid #e5e7eb;padding-left:12px">${esc(reason)}</p>` : ''}<p>Reply to this email to reach them.</p>`),
  })]);
  return json(await publicView({ ...row, status: 'declined', decided_at: now }));
}

// A bug report from the app's Settings. It needs no sign-in, so anyone using the app can
// send one, but it only ever goes to BUG_REPORT_EMAIL.
// Throws if too many bug reports came lately, and logs this one. If the log table isn't set up
// yet (schema.sql not run), reports still go through rather than break.
async function bugLimit(req: Request) {
  const { ip } = requester(req);
  const hour = new Date(Date.now() - 3600 * 1000).toISOString();
  const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [mine, all] = await Promise.all([
    sb().from('bug_reports').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('sent_at', hour),
    sb().from('bug_reports').select('id', { count: 'exact', head: true }).gte('sent_at', day),
  ]);
  if (mine.error || all.error) {
    console.error('bug_reports:', (mine.error || all.error).message);
    return;
  }
  if ((mine.count || 0) >= BUG_PER_HOUR) throw new Fail(429, 'You’ve sent several bug reports in the last hour. Try again later.');
  if ((all.count || 0) >= BUG_PER_DAY) throw new Fail(429, 'Bug reports are paused for today. Try again tomorrow.');
  await sb().from('bug_reports').insert({ ip });
  await sb().from('bug_reports').delete().lt('sent_at', new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString());
}

async function bug(req: Request, form: FormData) {
  let meta: any = {};
  try {
    meta = JSON.parse(String(form.get('meta') || '{}'));
  } catch { /* empty report */ }
  const text = clip(meta.description, 5000);
  if (!text) throw new Fail(400, 'Say what happened first.');
  await bugLimit(req);
  const from = clip(meta.email, 200).toLowerCase();
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) ? from : undefined;
  const info = meta.info && typeof meta.info === 'object' ? Object.entries(meta.info).slice(0, 20) : [];
  const shot = form.get('screenshot');
  const attachments = shot instanceof File && shot.size && shot.size <= MAX_SCREENSHOT && /^image\//.test(shot.type)
    ? [{ filename: `screenshot.${shot.type === 'image/png' ? 'png' : 'jpg'}`, content: base64(new Uint8Array(await shot.arrayBuffer())) }]
    : undefined;
  const version = (info.find(([k]) => k === 'App version') || [])[1];
  const rows = info.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(clip(k, 40))}</td><td style="padding:4px 0;white-space:pre-wrap;word-break:break-word">${esc(clip(v, 2000))}</td></tr>`).join('');
  await email({
    to: [BUG_REPORT_EMAIL()],
    replyTo,
    subject: `Bug report${version ? ` (v${clip(version, 10)})` : ''}: ${text.replace(/\s+/g, ' ').slice(0, 70)}`,
    html: emailShell('#0e7490', 'Zone Sense bug report', `
      <p style="white-space:pre-wrap">${esc(text)}</p>
      <p style="color:#6b7280">From: ${esc(replyTo || 'no email given')}${attachments ? ' · screenshot attached' : ''}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;border-top:1px solid #e5e7eb;padding-top:8px;width:100%">${rows}</table>`),
    attachments,
  });
  return json({ ok: true });
}

// ---------- accounts ----------

const companyView = (c: Record<string, any>) => ({
  id: c.id, name: c.name, replyTo: c.reply_to || '', plan: c.plan, status: c.status, createdAt: c.created_at,
});
const memberView = (m: Record<string, any>) => ({
  userId: m.user_id, email: m.email, name: m.name || '', role: m.role, status: m.status, invitedAt: m.invited_at, joinedAt: m.joined_at,
});

async function userIdFor(email: string): Promise<string | null> {
  const { data, error } = await sb().rpc('user_id_for_email', { e: email });
  if (error) throw new Fail(500, `The accounts database isn’t set up yet: run schema.sql again. (${error.message})`);
  return data || null;
}

// A one-time link that opens the app on its "choose a password" screen. The app trades the
// token for a sign-in with Supabase, so no redirect settings are needed.
async function passwordLink(email: string, isNew: boolean) {
  const { data, error } = await sb().auth.admin.generateLink({ type: isNew ? 'invite' : 'recovery', email });
  if (error || !data?.properties?.hashed_token) throw new Fail(500, `Couldn’t make the link: ${error ? error.message : 'no token'}`);
  const type = isNew ? 'invite' : 'recovery';
  return {
    userId: data.user.id as string,
    href: `${APP_URL()}?${type}=${encodeURIComponent(data.properties.hashed_token)}&email=${encodeURIComponent(email)}`,
  };
}

// Adds someone to a company and emails them. New people get a link to choose a password;
// people who already have one (say, a Zone Sense admin making their own company) just get
// told to sign in.
async function addPerson(company: Record<string, any>, to: string, role: 'owner' | 'tech', by: { id: string; email?: string }) {
  if (!validEmail(to)) throw new Fail(400, 'Enter their email address.');
  let id = await userIdFor(to);
  const { data: existing } = id ? await sb().from('members').select('*').eq('user_id', id).maybeSingle() : { data: null };
  if (existing && existing.company_id !== company.id) throw new Fail(409, `${to} is already on another company’s team.`);
  if (existing && existing.status === 'active') throw new Fail(409, `${to} is already on your team.`);
  let neverSignedIn = !id;
  if (id) {
    const { data } = await sb().auth.admin.getUserById(id);
    neverSignedIn = !data?.user?.last_sign_in_at;
  }
  let href = APP_URL();
  if (neverSignedIn) {
    const l = await passwordLink(to, !id);
    id = l.userId;
    href = l.href;
  }
  const self = id === by.id;
  const { error } = await sb().from('members').upsert({
    user_id: id, company_id: company.id, email: to, role: existing ? existing.role : role,
    status: self ? 'active' : 'invited', invited_by: by.id, invited_at: new Date().toISOString(),
    joined_at: self ? new Date().toISOString() : null,
  });
  if (error) throw new Fail(500, `Couldn’t add them: ${error.message}`);
  if (self) return;
  const accent = '#0e7490';
  const what = role === 'owner' ? `set up <strong>${esc(company.name)}</strong> on Zone Sense, the wet check app, with you as its owner` : `invited you to join <strong>${esc(company.name)}</strong> on Zone Sense, the wet check app`;
  await email({
    to: [to],
    fromName: company.name,
    replyTo: by.email,
    subject: role === 'owner' ? `Your Zone Sense account for ${company.name}` : `${company.name} invited you to Zone Sense`,
    html: emailShell(accent, company.name, `
      <p>Hi,</p>
      <p>${esc(by.email || 'Someone')} ${what}.</p>
      ${neverSignedIn
        ? `${button(accent, href, 'Choose your password')}<p style="color:#6b7280;font-size:13px">The link works once, for 24 hours. Open it on the phone you’ll use, then add Zone Sense to your home screen. If it has expired, ask for a new invite.</p>`
        : `${button(accent, href, 'Open Zone Sense')}<p style="color:#6b7280;font-size:13px">Sign in with your email and the password you already use.</p>`}`),
  });
}

async function me(req: Request) {
  const u = await user(req);
  const admin = isAdmin(u);
  const { data: m } = await sb().from('members').select('*').eq('user_id', u.id).maybeSingle();
  let company = null;
  if (m) {
    const { data } = await sb().from('companies').select('*').eq('id', m.company_id).maybeSingle();
    company = data;
    if (m.status !== 'active') {
      await sb().from('members').update({ status: 'active', joined_at: new Date().toISOString() }).eq('user_id', u.id);
      m.status = 'active';
    }
    const name = clip(u.user_metadata?.name, 120);
    if (name && name !== m.name) await sb().from('members').update({ name }).eq('user_id', u.id);
  }
  return json({
    user: { id: u.id, email: u.email, name: u.user_metadata?.name || '' },
    company: company ? companyView(company) : null,
    role: m && company ? m.role : null,
    admin,
  });
}

async function team(req: Request) {
  const { company } = await member(req);
  const { data, error } = await sb().from('members').select('*').eq('company_id', company.id).order('invited_at');
  if (error) throw new Fail(500, error.message);
  return json({ members: data.map(memberView) });
}

async function invite(req: Request, body: any) {
  const { u, company } = await member(req, { owner: true });
  await addPerson(company, clip(body.email, 200).toLowerCase(), 'tech', u);
  return team(req);
}

async function removeMember(req: Request, body: any) {
  const { u, company } = await member(req, { owner: true });
  if (body.userId === u.id) throw new Fail(400, 'You can’t remove yourself.');
  const { data: m } = await sb().from('members').select('*').eq('user_id', body.userId).eq('company_id', company.id).maybeSingle();
  if (!m) throw new Fail(404, 'They’re not on your team.');
  await sb().from('members').delete().eq('user_id', m.user_id);
  // An invite that was never used leaves no account behind, so they can be invited again later.
  const { data } = await sb().auth.admin.getUserById(m.user_id);
  if (data?.user && !data.user.last_sign_in_at && !isAdmin(data.user)) await sb().auth.admin.deleteUser(m.user_id);
  return team(req);
}

async function updateCompany(req: Request, body: any) {
  const { company } = await member(req, { owner: true });
  const name = clip(body.name, 120);
  const replyTo = clip(body.replyTo, 200).toLowerCase();
  if (!name) throw new Fail(400, 'Enter the company name.');
  if (replyTo && !validEmail(replyTo)) throw new Fail(400, 'Check the reply-to email address.');
  const { data, error } = await sb().from('companies').update({ name, reply_to: replyTo || null }).eq('id', company.id).select('*').single();
  if (error) throw new Fail(500, error.message);
  return json({ company: companyView(data) });
}

async function companies(req: Request) {
  const u = await user(req);
  if (!isAdmin(u)) throw new Fail(403, 'Only Zone Sense admins can see every company.');
  const [{ data: cs, error }, { data: ms }] = await Promise.all([
    sb().from('companies').select('*').order('created_at'),
    sb().from('members').select('company_id,email,role,status'),
  ]);
  if (error) throw new Fail(500, error.message);
  return json({
    companies: cs.map((c: any) => {
      const people = (ms || []).filter((m: any) => m.company_id === c.id);
      return { ...companyView(c), owners: people.filter((m: any) => m.role === 'owner').map((m: any) => m.email), members: people.length };
    }),
  });
}

async function createCompany(req: Request, body: any) {
  const u = await user(req);
  if (!isAdmin(u)) throw new Fail(403, 'Only Zone Sense admins can add companies.');
  const name = clip(body.name, 120);
  const ownerEmail = clip(body.ownerEmail, 200).toLowerCase();
  if (!name) throw new Fail(400, 'Enter the company name.');
  if (!validEmail(ownerEmail)) throw new Fail(400, 'Enter the owner’s email address.');
  const ownerId = await userIdFor(ownerEmail);
  if (ownerId) {
    const { data: m } = await sb().from('members').select('company_id').eq('user_id', ownerId).maybeSingle();
    if (m) throw new Fail(409, `${ownerEmail} is already on a company’s team.`);
  }
  const { data: c, error } = await sb().from('companies').insert({ name, created_by: u.id }).select('*').single();
  if (error) throw new Fail(500, `Couldn’t add the company: ${error.message}`);
  try {
    await addPerson(c, ownerEmail, 'owner', u);
  } catch (err) {
    await sb().from('companies').delete().eq('id', c.id);
    throw err;
  }
  return json({ company: companyView(c) });
}

// "Forgot password" on the sign-in screen. The answer is the same whether or not the email
// is on a team, so it can't be used to find out who has an account.
async function reset(body: any) {
  const to = clip(body.email, 200).toLowerCase();
  if (!validEmail(to)) throw new Fail(400, 'Enter your email address.');
  const id = await userIdFor(to);
  const { data: m } = id ? await sb().from('members').select('*').eq('user_id', id).maybeSingle() : { data: null };
  // One email every two minutes at most, so nobody can flood someone's inbox.
  if (m && !(m.reset_sent_at && Date.now() - Date.parse(m.reset_sent_at) < 120000)) {
    await sb().from('members').update({ reset_sent_at: new Date().toISOString() }).eq('user_id', id);
    const { data: c } = await sb().from('companies').select('name').eq('id', m.company_id).maybeSingle();
    const { href } = await passwordLink(to, false);
    const accent = '#0e7490';
    await email({
      to: [to],
      subject: 'Reset your Zone Sense password',
      html: emailShell(accent, c ? c.name : 'Zone Sense', `
        <p>Someone asked to reset the password for ${esc(to)} on Zone Sense.</p>
        ${button(accent, href, 'Choose a new password')}
        <p style="color:#6b7280;font-size:13px">The link works once, for 24 hours. If you didn’t ask for this, ignore this email and your password stays the same.</p>`),
    });
  }
  return json({ ok: true });
}

export async function handle(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  try {
    const isForm = (req.headers.get('content-type') || '').startsWith('multipart/form-data');
    if (isForm) {
      const form = await req.formData();
      return form.get('action') === 'bug' ? await bug(req, form) : await send(req, form);
    }
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'status': return await status(req, body);
      case 'cancel': return await cancel(req, body);
      case 'view': return await view(body);
      case 'sign': return await sign(req, body);
      case 'decline': return await decline(req, body);
      case 'reset': return await reset(body);
      case 'me': return await me(req);
      case 'team': return await team(req);
      case 'invite': return await invite(req, body);
      case 'remove_member': return await removeMember(req, body);
      case 'update_company': return await updateCompany(req, body);
      case 'companies': return await companies(req);
      case 'create_company': return await createCompany(req, body);
      default: return json({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    if (err instanceof Fail) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
}

if (!Deno.env.get('APPROVALS_NO_SERVE')) Deno.serve(handle);
