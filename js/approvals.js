// Online approvals (send a report for the customer to sign) and the Approvals and work
// dashboard (#/approvals).

import * as db from './db.js';
import { $, showDialog, askAction, askConfirm, formatDate } from './ui.js';
import { formatMoney } from './issues.js';
import { DEFAULT_ACCENT, pdfFileName } from './pdf.js';
import { callApprovals, cloudReady, signedInEmail } from './cloud.js';
import { screens, current, render, showToast, deliverFile, setCurrent, setHeader, showView, row, reportHref } from './core.js';
import { WORK_TAGS, reportDetail } from './folders.js';
import { confirmSignature, reportPdf } from './reports.js';

screens.approvals = renderApprovals;

// ---------- Online approvals ----------
// "Send for approval" emails the customer a link to approve.html, where they review the PDF
// and sign; the "approvals" Edge Function (supabase/) keeps the record, makes the signed PDF
// and emails it to both sides. The report keeps report.approval { id, status: 'sent' |
// 'approved' | 'declined' | 'cancelled', sentTo, customerName, sentAt, viewedAt, decidedAt,
// signerName, declineReason, pdfName } and, once signed, report.approvalPdf (Blob, kept
// top-level so db.put copies it).

const APPROVAL_ICONS = {
  sent: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  approved: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12.5l2.7 2.7L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  declined: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 9l6 6m0-6l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const shortTime = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function sendForApproval(report) {
  const path = await db.getPath(report.folderId);
  const contact = (path.length && path[0].profile && path[0].profile.contact) || {};
  const prev = report.approval;
  $('#approval-name-input').value = (prev && prev.customerName) || contact.name || '';
  $('#approval-email').value = (prev && prev.sentTo) || contact.email || '';
  $('#approval-message').value = '';
  $('#approval-error').hidden = true;
  $('#approval-form').onsubmit = (e) => {
    e.preventDefault();
    $('#approval-dialog').close('ok');
  };
  if ((await showDialog($('#approval-dialog'))) !== 'ok') return;
  const customerName = $('#approval-name-input').value.trim();
  const customerEmail = $('#approval-email').value.trim();
  const message = $('#approval-message').value.trim();
  report = await confirmSignature(report, 'Send');
  if (!report) return;

  const dialog = $('#pdf-dialog');
  $('#pdf-share').hidden = $('#pdf-download').hidden = $('#pdf-open').hidden = true;
  $('#pdf-title').textContent = 'Sending…';
  $('#pdf-text').textContent = 'Making the PDF and emailing it to the customer.';
  const closed = showDialog(dialog);
  try {
    const [pdf, logo, companyName, accent] = await Promise.all([
      emailablePdf(report),
      db.getSetting('companyLogo'),
      db.getSetting('companyName'),
      db.getSetting('accentColor'),
    ]);
    const e = pdf.estimate;
    const meta = {
      customerName,
      customerEmail,
      message,
      companyName: companyName || '',
      accent: accent || DEFAULT_ACCENT,
      property: path.map((f) => f.name).join(', '),
      reportName: report.name,
      reportDate: report.date,
      pdfName: pdf.name,
      // What the approval page lists; with individual prices off, only the total shows.
      estimate: e && e.lines.length ? {
        lines: e.lines.map((l) => ({ issue: l.issue, qty: l.qty, amount: pdf.itemized ? l.amount : null })),
        subtotal: e.subtotal,
        discount: e.discount,
        discountLabel: e.discountLabel,
        total: e.total,
        unpriced: e.unpriced,
        itemized: pdf.itemized,
      } : null,
      replaces: prev && prev.status === 'sent' ? prev.id : null,
    };
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('pdf', pdf.blob, pdf.name);
    if (logo instanceof Blob) form.append('logo', logo, 'logo');
    const r = await callApprovals(form);
    report = await db.updateReport(report.id, {
      approval: { id: r.id, status: 'sent', sentTo: r.sentTo, customerName, sentAt: r.sentAt, total: meta.estimate ? meta.estimate.total : null },
      approvalPdf: null,
    });
    $('#pdf-title').textContent = 'Sent for approval';
    $('#pdf-text').textContent = `${r.sentTo} will get an email with a link to review and sign. You’ll get an email when they answer, and the signed copy shows on this report.`;
  } catch (x) {
    $('#pdf-title').textContent = 'Couldn’t send';
    $('#pdf-text').textContent = x && x.message ? x.message : 'Something went wrong. Try again.';
  }
  await closed;
  if (current.kind === 'report' && current.id === report.id) render();
}

// The report's PDF with photos scaled down to email size (they print about 3 inches wide, so
// 1000 pixels is plenty); a report with very many photos goes smaller again.
const EMAIL_PDF_MAX = 18 * 1024 * 1024;
async function emailablePdf(report) {
  let pdf = await reportPdf(report, { photoMax: 1000 });
  if (pdf.blob.size > EMAIL_PDF_MAX) pdf = await reportPdf(report, { photoMax: 640 });
  if (pdf.blob.size > EMAIL_PDF_MAX) {
    throw new Error(`This report’s PDF is still ${(pdf.blob.size / 1024 / 1024).toFixed(0)} MB with smaller photos, too large to send. Turn finding photos off in the property’s Export settings, then send it again.`);
  }
  return pdf;
}

export function renderApprovalCard(report) {
  const a = report.approval;
  const card = $('#approval-card');
  card.hidden = !a || !APPROVAL_ICONS[a.status];
  if (card.hidden) return;
  card.dataset.status = a.status;
  $('#approval-icon').innerHTML = APPROVAL_ICONS[a.status];
  if (a.status === 'approved') {
    $('#approval-name').textContent = `Approved by ${a.signerName || a.sentTo}`;
    const w = report.work && WORK_TAGS[report.work.status];
    $('#approval-detail').textContent = `Signed ${shortTime(a.decidedAt)}${w ? ` · ${w}` : ''}. Tap for the signed copy or to update the work.`;
  } else if (a.status === 'declined') {
    $('#approval-name').textContent = `Declined by ${a.signerName || a.sentTo}`;
    $('#approval-detail').textContent = [shortTime(a.decidedAt), a.declineReason ? `“${a.declineReason}”` : ''].filter(Boolean).join(' · ');
  } else {
    $('#approval-name').textContent = 'Waiting for approval';
    $('#approval-detail').textContent = `Sent to ${a.sentTo} ${shortTime(a.sentAt)} · ${a.viewedAt ? `opened ${shortTime(a.viewedAt)}` : 'not opened yet'}`;
  }
}

// Asks the server where the report's request stands and keeps the answer (and the signed
// PDF) on the report. Quiet checks (on opening a report) run at most every 30 seconds.
const approvalChecked = new Map();
export async function refreshApproval(report, quiet = true) {
  const a = report.approval;
  if (!a || (quiet && Date.now() - (approvalChecked.get(a.id) || 0) < 30000)) return report;
  try {
    await refreshApprovals([report]);
  } catch (x) {
    if (!quiet) showToast(x.message);
  }
  return (await db.getReport(report.id)) || report;
}

// One server request for several reports. Saves each answer (and downloads signed copies)
// and resolves true if anything changed. Throws on a connection or sign-in problem.
async function refreshApprovals(reports) {
  const open = reports.filter((r) => r.approval && (r.approval.status === 'sent' || (r.approval.status === 'approved' && !r.approvalPdf)));
  if (!open.length || !cloudReady || !signedInEmail() || !navigator.onLine) return false;
  for (const r of open) approvalChecked.set(r.approval.id, Date.now());
  const { items } = await callApprovals({ action: 'status', ids: open.map((r) => r.approval.id) });
  let changed = false;
  for (const it of items || []) {
    const report = open.find((r) => r.approval.id === it.id);
    if (!report) continue;
    const a = report.approval;
    const patch = {
      approval: { ...a, status: it.status, viewedAt: it.viewedAt, decidedAt: it.decidedAt, signerName: it.signerName, declineReason: it.declineReason, pdfName: it.signedPdfName },
    };
    if (it.status === 'approved' && it.signedPdfUrl && !report.approvalPdf) {
      try {
        const res = await fetch(it.signedPdfUrl);
        if (res.ok) patch.approvalPdf = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
      } catch {} // tried again next time
    }
    if (it.status !== a.status || it.viewedAt !== a.viewedAt || patch.approvalPdf) changed = true;
    const updated = await db.updateReport(report.id, patch);
    if (current.kind === 'report' && current.id === updated.id) {
      current.record = updated;
      renderApprovalCard(updated);
      $('#subtitle').textContent = reportDetail(updated);
    }
    if (a.status === 'sent' && it.status === 'approved') showToast(`${it.signerName || it.sentTo} approved ${updated.name}.`, 'ok');
    if (a.status === 'sent' && it.status === 'declined') showToast(`${it.signerName || it.sentTo} declined ${updated.name}.`);
  }
  return changed;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !current) return;
  if (current.kind === 'report') refreshApproval(current.record);
  if (current.kind === 'approvals') render();
});

$('#approval-card').addEventListener('click', async () => {
  let report = current.record;
  const a = report.approval;
  if (!a) return;
  if (a.status === 'approved') {
    const choice = await askAction(`Approved by ${a.signerName || a.sentTo}`, [{ label: 'Signed copy', value: 'copy' }, ...workActions(report)]);
    if (choice.startsWith('work:')) return setWork(report, choice.slice(5));
    if (choice !== 'copy') return;
    return showSignedCopy(report);
  }
  const action = await askAction(a.status === 'sent' ? 'Waiting for approval' : 'Declined', [
    ...(a.status === 'sent' ? [{ label: 'Check for an answer', value: 'check' }] : []),
    { label: 'Send again', value: 'send' },
    ...(a.status === 'sent' ? [{ label: 'Cancel the request', value: 'cancel', danger: true }] : []),
  ]);
  if (action === 'check') {
    report = await refreshApproval(report, false);
    if (report.approval.status === 'sent') showToast(report.approval.viewedAt ? 'Opened, but not answered yet.' : 'Not opened yet.', 'ok');
  }
  if (action === 'send') await sendForApproval(report);
  if (action === 'cancel') {
    if (!(await askConfirm('Cancel the request', `The link sent to ${a.sentTo} will stop working.`, 'Cancel request'))) return;
    try {
      await callApprovals({ action: 'cancel', id: a.id });
      current.record = await db.updateReport(report.id, { approval: { ...a, status: 'cancelled' } });
      render();
    } catch (x) {
      showToast(x.message);
    }
  }
});

function showSignedCopy(report) {
  const a = report.approval;
  return deliverFile({
      working: 'Getting the signed copy…',
      workingText: '',
      ready: 'Signed copy',
      failed: 'Couldn’t get the signed copy',
      canOpen: true,
      build: async () => {
        if (!(report.approvalPdf instanceof Blob)) report = await refreshApproval(report, false);
        if (!(report.approvalPdf instanceof Blob)) throw new Error('The signed copy hasn’t downloaded to this phone yet. Try again when you’re online.');
        return { blob: report.approvalPdf, name: a.pdfName || pdfFileName([], report).replace(/\.pdf$/i, ' - signed.pdf'), detail: `Signed by ${a.signerName}, with its signature certificate on the last page` };
      },
    });
}

// ---------- Work status and the approvals dashboard ----------
// report.work { status: 'progress' | 'done', startedAt, doneAt } tracks the job once it's
// approved (online or on paper). Clearing it puts the report back to just "approved".

export function workActions(report) {
  const w = report.work && report.work.status;
  if (w === 'progress') return [{ label: 'Mark work done', value: 'work:done' }, { label: 'Work not started yet', value: 'work:none' }];
  if (w === 'done') return [{ label: 'Reopen work (in progress)', value: 'work:progress' }];
  return [{ label: 'Mark work in progress', value: 'work:progress' }, { label: 'Mark work done', value: 'work:done' }];
}

export async function setWork(report, status) {
  const prev = report.work || {};
  const now = Date.now();
  const work = status === 'none' ? null : {
    status,
    startedAt: status === 'progress' && prev.status !== 'progress' ? now : prev.startedAt || now,
    doneAt: status === 'done' ? now : null,
  };
  const updated = await db.updateReport(report.id, { work });
  if (current.kind === 'report' && current.id === report.id) current.record = updated;
  await render();
  showToast(status === 'progress' ? `${report.name}: work in progress.` : status === 'done' ? `${report.name}: work done.` : `${report.name}: back to not started.`, 'ok');
  return updated;
}

// Which dashboard section a report belongs in, or '' if none.
function workStage(r) {
  const w = r.work && r.work.status;
  if (w === 'progress' || w === 'done') return w;
  const a = r.approval && r.approval.status;
  return a === 'sent' || a === 'approved' || a === 'declined' ? a : '';
}

const STAGES = [
  { key: 'sent', title: 'Waiting for approval' },
  { key: 'approved', title: 'Approved, not started' },
  { key: 'progress', title: 'In progress' },
  { key: 'done', title: 'Done' },
  { key: 'declined', title: 'Declined' },
];
const STAGE_ICONS = {
  sent: APPROVAL_ICONS.sent,
  approved: APPROVAL_ICONS.approved,
  declined: APPROVAL_ICONS.declined,
  progress: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5l5 5-9.5 9.5H5v-5zM12.5 6.5l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const DONE_SHOWN = 20; // the most recent finished jobs

export async function renderApprovalsCard(show) {
  const card = $('#approvals-card');
  if (!show) return (card.hidden = true);
  const reports = await db.listAllReports();
  const counts = {};
  for (const r of reports) {
    const s = workStage(r);
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  const parts = [
    counts.sent && `${counts.sent} waiting`,
    counts.approved && `${counts.approved} approved`,
    counts.progress && `${counts.progress} in progress`,
  ].filter(Boolean);
  card.hidden = !cloudReady && !Object.keys(counts).length;
  $('#approvals-card-detail').textContent = parts.length ? parts.join(' · ') : 'Proposals sent for approval and approved work show here.';
}

$('#approvals-card').addEventListener('click', () => (location.hash = '#/approvals'));

async function renderApprovals() {
  setCurrent({ kind: 'approvals', id: '', record: null });
  setHeader({ title: 'Approvals and work', back: true });
  const [reports, folders] = await Promise.all([db.listAllReports(), db.listAllFolders()]);
  drawApprovals(reports, folders);
  showView('approvals');
  // Then ask the server about anything still waiting, and redraw if an answer came in.
  const stale = reports.filter((r) => r.approval && Date.now() - (approvalChecked.get(r.approval.id) || 0) > 30000);
  const changed = await refreshApprovals(stale).catch(() => false);
  if (changed && current.kind === 'approvals') drawApprovals(await db.listAllReports(), folders);
}

function drawApprovals(reports, folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const where = (folderId) => {
    const names = [];
    for (let f = byId.get(folderId), n = 0; f && n < 50; f = byId.get(f.parentId), n++) names.unshift(f.name);
    return names.join(' › ');
  };
  const groups = new Map(STAGES.map((s) => [s.key, []]));
  for (const r of reports) {
    const s = workStage(r);
    if (s) groups.get(s).push(r);
  }
  const when = (r) => {
    const a = r.approval || {};
    const w = r.work || {};
    return w.doneAt || w.startedAt || Date.parse(a.decidedAt || a.sentAt || '') || r.updatedAt || 0;
  };
  const out = [];
  for (const { key, title } of STAGES) {
    let list = groups.get(key).sort((x, y) => when(y) - when(x));
    if (!list.length) continue;
    const total = list.length;
    if (key === 'done') list = list.slice(0, DONE_SHOWN);
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = key === 'done' && total > DONE_SHOWN ? `${title} · latest ${DONE_SHOWN} of ${total}` : `${title} · ${total}`;
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...list.map((r) => approvalRow(r, key, where(r.folderId))));
    out.push(h, ul);
  }
  $('#approvals-list').replaceChildren(...out);
  $('#approvals-empty').hidden = out.length > 0;
}

function approvalRow(r, stage, place) {
  const a = r.approval || {};
  const w = r.work || {};
  const money = a.total ? formatMoney(a.total) : '';
  const detail = {
    sent: [`Sent to ${a.sentTo} ${a.sentAt ? shortTime(a.sentAt) : ''}`, a.viewedAt ? 'opened' : 'not opened yet'],
    approved: [a.signerName ? `Approved by ${a.signerName}` : 'Approved', a.decidedAt ? shortTime(a.decidedAt) : ''],
    progress: [w.startedAt ? `Started ${shortTime(w.startedAt)}` : 'In progress', a.signerName ? `approved by ${a.signerName}` : ''],
    done: [w.doneAt ? `Done ${shortTime(w.doneAt)}` : 'Done'],
    declined: [`Declined by ${a.signerName || a.sentTo}`, a.declineReason ? `“${a.declineReason}”` : ''],
  }[stage];
  const quick = {
    approved: { label: 'Start', value: 'progress' },
    progress: { label: 'Done', value: 'done' },
  }[stage];
  const li = row({
    icon: `<span class="ico status ${stage}">${STAGE_ICONS[stage]}</span>`,
    name: `${place ? place + ' · ' : ''}${r.name}`,
    detail: [formatDate(r.date), money, ...detail].filter(Boolean).join(' · '),
    href: reportHref(r.id),
    action: quick && {
      label: quick.label,
      run: () => setWork(r, quick.value),
    },
    menuLabel: `Options for ${r.name}`,
    onMenu: async () => {
      const choice = await askAction(r.name, [
        ...(a.status === 'approved' ? [{ label: 'Signed copy', value: 'copy' }] : []),
        ...(a.status === 'sent' ? [{ label: 'Check for an answer', value: 'check' }] : []),
        ...(stage !== 'sent' && stage !== 'declined' ? workActions(r) : []),
        ...(stage === 'declined' ? [{ label: 'Send again', value: 'send' }, { label: 'Remove from this list', value: 'hide' }] : []),
        { label: 'Open report', value: 'open' },
      ]);
      if (choice === 'copy') await showSignedCopy(r);
      if (choice === 'check') {
        await refreshApproval(r, false);
        render();
      }
      if (choice.startsWith('work:')) await setWork(r, choice.slice(5));
      if (choice === 'send') await sendForApproval(r);
      if (choice === 'hide') {
        await db.updateReport(r.id, { approval: { ...a, status: 'cancelled' } });
        render();
      }
      if (choice === 'open') location.hash = reportHref(r.id);
    },
  });
  return li;
}
