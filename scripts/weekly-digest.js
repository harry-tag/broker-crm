'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const ws               = require('ws');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const DRY_RUN        = process.argv.includes('--dry-run');

if (!RESEND_API_KEY) { console.error('ERROR: Missing RESEND_API_KEY'); process.exit(1); }
if (!SUPABASE_URL)   { console.error('ERROR: Missing SUPABASE_URL');   process.exit(1); }
if (!SUPABASE_KEY)   { console.error('ERROR: Missing SUPABASE_KEY');   process.exit(1); }

const supa   = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: ws } });
const resend = new Resend(RESEND_API_KEY);

// ── Same logic as the CRM ─────────────────────────────────────
function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).setHours(0, 0, 0, 0);
  return Math.max(0, Math.floor(ms / 86400000));
}
function daysUntilOverdue(b, thresholds) {
  if (!b.lastContacted) return null;
  return (thresholds[b.tier] || 30) - daysSince(b.lastContacted);
}
function statusOf(b, thresholds) {
  if (!b.lastContacted) return 'never';
  const d   = daysSince(b.lastContacted);
  const thr = thresholds[b.tier] || 30;
  const r   = d / thr;
  if (r >= 1)   return 'overdue';
  if (r >= 0.5) return 'soon';
  return 'fresh';
}
function fmtDate(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const [{ data: rows, error: bErr }, { data: settingsRows, error: sErr }] = await Promise.all([
    supa.from('brokers').select('*'),
    supa.from('settings').select('*'),
  ]);

  if (bErr) { console.error('Failed to fetch brokers:', bErr.message); process.exit(1); }
  if (sErr) { console.error('Failed to fetch settings:', sErr.message); process.exit(1); }

  const brokers = (rows || []).map(row => ({
    ...row,
    lastContacted: row.last_contacted || null,
  }));

  const map        = Object.fromEntries((settingsRows || []).map(s => [s.key, s.value]));
  const thresholds = Object.assign({ 1: 14, 2: 30, 3: 60 }, map.thresholds);
  const recipients = ((map.digest && map.digest.emails) || []).filter(Boolean);

  if (recipients.length === 0) {
    console.error('No recipients found. Add emails in the CRM under Digest settings.');
    process.exit(1);
  }

  const overdue = brokers
    .filter(b => statusOf(b, thresholds) === 'overdue')
    .sort((a, b) => (daysSince(b.lastContacted) || 0) - (daysSince(a.lastContacted) || 0));

  const dueSoon = brokers
    .filter(b => {
      if (statusOf(b, thresholds) !== 'soon') return false;
      const dtu = daysUntilOverdue(b, thresholds);
      return dtu !== null && dtu <= 7;
    })
    .sort((a, b) => (daysUntilOverdue(a, thresholds) || 0) - (daysUntilOverdue(b, thresholds) || 0));

  const never  = brokers.filter(b => statusOf(b, thresholds) === 'never');

  const weekOf  = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Broker CRM — Week of ${weekOf}: ${overdue.length} overdue, ${dueSoon.length} due soon`;

  if (DRY_RUN) {
    console.log('\n=== DRY RUN (no email sent) ===');
    console.log('Subject :', subject);
    console.log('To      :', recipients.join(', '));
    console.log('Overdue :', overdue.length, overdue.map(b => b.name).join(', ') || '—');
    console.log('Due soon:', dueSoon.length, dueSoon.map(b => b.name).join(', ') || '—');
    console.log('Never   :', never.length,   never.map(b => b.name).join(', ')   || '—');
    return;
  }

  const html = buildEmail({ overdue, dueSoon, never, weekOf, thresholds });

  const { data, error } = await resend.emails.send({
    from: 'Broker CRM <onboarding@resend.dev>',
    to: recipients,
    subject,
    html,
  });

  if (error) { console.error('Send failed:', error); process.exit(1); }
  console.log(`[${new Date().toISOString()}] Sent to ${recipients.join(', ')} — id: ${data.id}`);
}

// ── Email builder ─────────────────────────────────────────────
function brokerRow(b, thresholds) {
  const days = daysSince(b.lastContacted);
  const thr  = thresholds[b.tier] || 30;
  const dtu  = daysUntilOverdue(b, thresholds);
  const tierColor = b.tier === 1 ? '#8b9cf8' : b.tier === 2 ? '#f0a832' : '#8892aa';

  let statusHtml;
  if (days !== null && days >= thr) {
    statusHtml = `<span style="color:#e85050">${days - thr}d overdue</span>`;
  } else if (dtu !== null) {
    statusHtml = `<span style="color:#f0a832">due in ${dtu}d</span>`;
  } else {
    statusHtml = `<span style="color:#5a6480">never contacted</span>`;
  }

  return `
    <tr style="border-bottom:1px solid #2a2f45">
      <td style="padding:10px 14px">
        <div style="font-weight:500;color:#dce3f0">${esc(b.name)}</div>
        <div style="font-size:11px;color:#5a6480">${esc(b.firm)}</div>
      </td>
      <td style="padding:10px 14px">
        <span style="font-size:11px;font-weight:600;color:${tierColor};background:rgba(91,110,245,.15);padding:2px 7px;border-radius:3px">T${b.tier}</span>
      </td>
      <td style="padding:10px 14px;font-size:12px;color:#8892aa">${fmtDate(b.lastContacted)}</td>
      <td style="padding:10px 14px;font-size:12px">${statusHtml}</td>
    </tr>`;
}

function tableSection(title, color, rows, thresholds) {
  if (rows.length === 0) return '';
  return `
    <h3 style="margin:24px 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:${color}">${title} (${rows.length})</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;border-collapse:collapse">
      <thead>
        <tr style="background:#1c2030">
          <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Broker</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Tier</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Last Contact</th>
          <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Status</th>
        </tr>
      </thead>
      <tbody>${rows.map(b => brokerRow(b, thresholds)).join('')}</tbody>
    </table>`;
}

function buildEmail({ overdue, dueSoon, never, weekOf, thresholds }) {
  const neverLine = never.length > 0
    ? `<p style="margin:8px 0 0;font-size:12px;color:#5a6480">${never.map(b => `${esc(b.name)} (T${b.tier})`).join(' · ')}</p>`
    : '';
  const neverSection = never.length > 0
    ? `<h3 style="margin:24px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480">Never Contacted (${never.length})</h3>${neverLine}`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0f17;font-family:'Courier New',monospace">
  <div style="max-width:680px;margin:0 auto;padding:32px 24px">

    <div style="margin-bottom:28px">
      <div style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#dce3f0">BROKER<span style="color:#5b6ef5">CRM</span></div>
      <div style="font-size:12px;color:#5a6480;margin-top:4px">Week of ${weekOf}</div>
    </div>

    <table cellpadding="0" cellspacing="0" style="margin-bottom:8px"><tr style="gap:10px">
      <td style="padding-right:10px">
        <div style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;padding:12px 18px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;margin-bottom:4px">Overdue</div>
          <div style="font-size:28px;font-weight:700;color:#e85050">${overdue.length}</div>
        </div>
      </td>
      <td style="padding-right:10px">
        <div style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;padding:12px 18px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;margin-bottom:4px">Due This Week</div>
          <div style="font-size:28px;font-weight:700;color:#f0a832">${dueSoon.length}</div>
        </div>
      </td>
      <td>
        <div style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;padding:12px 18px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;margin-bottom:4px">Never Contacted</div>
          <div style="font-size:28px;font-weight:700;color:#5a6480">${never.length}</div>
        </div>
      </td>
    </tr></table>

    ${tableSection('Needs Outreach Now', '#e85050', overdue, thresholds)}
    ${tableSection('Due This Week', '#f0a832', dueSoon, thresholds)}
    ${neverSection}

    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #2a2f45;font-size:11px;color:#5a6480">
      Generated by Broker CRM &middot; ${new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}
    </div>
  </div>
</body></html>`;
}

main().catch(e => { console.error(e); process.exit(1); });
