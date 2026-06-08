'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');
const ws               = require('ws');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const CRM_URL        = process.env.CRM_URL || '';
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

  // brokers needing attention per tier, sorted overdue-first then soonest-to-tip
  function tierBrokers(tierNum) {
    return brokers
      .filter(b => b.tier === tierNum && (statusOf(b, thresholds) === 'overdue' || statusOf(b, thresholds) === 'soon'))
      .sort((a, b) => (daysSince(b.lastContacted) || 0) - (daysSince(a.lastContacted) || 0));
  }

  const t1 = tierBrokers(1);
  const t2 = tierBrokers(2);
  const t3 = tierBrokers(3);

  const totalOverdue = brokers.filter(b => statusOf(b, thresholds) === 'overdue').length;
  const totalSoon    = brokers.filter(b => statusOf(b, thresholds) === 'soon').length;
  const totalNever   = brokers.filter(b => statusOf(b, thresholds) === 'never').length;

  const weekOf  = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Broker CRM — Week of ${weekOf}: ${totalOverdue} overdue, ${totalSoon} due soon`;

  if (DRY_RUN) {
    console.log('\n=== DRY RUN (no email sent) ===');
    console.log('Subject  :', subject);
    console.log('To       :', recipients.join(', '));
    console.log('Overdue  :', totalOverdue);
    console.log('Due soon :', totalSoon);
    console.log('Never    :', totalNever);
    console.log('T1 action:', t1.length, t1.map(b => b.name).join(', ') || '—');
    console.log('T2 action:', t2.length, t2.map(b => b.name).join(', ') || '—');
    console.log('T3 action:', t3.length, t3.map(b => b.name).join(', ') || '—');
    return;
  }

  const html = buildEmail({
    t1, t2, t3,
    totalBrokers: brokers.length, totalOverdue, totalSoon, totalNever,
    weekOf, thresholds,
  });

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

  const statusHtml = (days !== null && days >= thr)
    ? `<span style="color:#e85050;font-weight:600">${days - thr}d overdue</span>`
    : `<span style="color:#f0a832">due in ${dtu}d</span>`;

  return `
    <tr style="border-bottom:1px solid #2a2f45">
      <td style="padding:10px 14px;width:55%">
        <div style="font-weight:500;color:#dce3f0">${esc(b.name)}</div>
        <div style="font-size:11px;color:#5a6480;margin-top:1px">${esc(b.firm)}</div>
      </td>
      <td style="padding:10px 14px;font-size:12px;color:#8892aa;white-space:nowrap">${fmtDate(b.lastContacted)}</td>
      <td style="padding:10px 14px;font-size:12px;white-space:nowrap">${statusHtml}</td>
    </tr>`;
}

function tierSection(label, cadence, color, rows, thresholds) {
  if (rows.length === 0) return '';
  return `
    <div style="margin-top:28px">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${color}">${label}</span>
        <span style="font-size:11px;color:#5a6480">every ${cadence}d &middot; ${rows.length} need attention</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;border-collapse:collapse">
        <thead>
          <tr style="background:#1c2030">
            <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Broker</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Last Contact</th>
            <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;font-weight:500;border-bottom:1px solid #2a2f45">Status</th>
          </tr>
        </thead>
        <tbody>${rows.map(b => brokerRow(b, thresholds)).join('')}</tbody>
      </table>
    </div>`;
}

function statCard(label, value, color) {
  return `
    <td style="padding-right:10px">
      <div style="background:#13161f;border:1px solid #2a2f45;border-radius:5px;padding:12px 18px;min-width:100px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#5a6480;margin-bottom:4px">${label}</div>
        <div style="font-size:28px;font-weight:700;color:${color}">${value}</div>
      </div>
    </td>`;
}

function buildEmail({ t1, t2, t3, totalBrokers, totalOverdue, totalSoon, totalNever, weekOf, thresholds }) {
  const wrapOpen  = CRM_URL ? `<a href="${CRM_URL}" style="display:block;text-decoration:none;color:inherit;cursor:pointer">` : '<div>';
  const wrapClose = CRM_URL ? '</a>' : '</div>';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d0f17;font-family:'Courier New',monospace">
${wrapOpen}
  <div style="max-width:680px;margin:0 auto;padding:32px 24px">

    <div style="margin-bottom:28px">
      <div style="font-size:15px;font-weight:700;letter-spacing:.12em;color:#dce3f0">BROKER<span style="color:#5b6ef5">CRM</span></div>
      <div style="font-size:12px;color:#5a6480;margin-top:4px">Week of ${weekOf}</div>
    </div>

    <table cellpadding="0" cellspacing="0"><tr>
      ${statCard('Total', totalBrokers, '#dce3f0')}
      ${statCard('Overdue', totalOverdue, '#e85050')}
      ${statCard('Due Soon', totalSoon, '#f0a832')}
      ${statCard('Never', totalNever, '#5a6480')}
    </tr></table>

    ${tierSection('Tier 1', thresholds[1] || 14, '#8b9cf8', t1, thresholds)}
    ${tierSection('Tier 2', thresholds[2] || 30, '#f0a832', t2, thresholds)}
    ${tierSection('Tier 3', thresholds[3] || 60, '#8892aa', t3, thresholds)}

    ${(t1.length + t2.length + t3.length === 0)
      ? '<p style="margin-top:32px;font-size:13px;color:#22c47a">&#10003; All brokers are up to date this week.</p>'
      : ''}

    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #2a2f45;font-size:11px;color:#5a6480">
      Generated by Broker CRM &middot; ${new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}
      ${CRM_URL ? `&middot; <span style="color:#5b6ef5">Open CRM →</span>` : ''}
    </div>

  </div>
${wrapClose}
</body></html>`;
}

main().catch(e => { console.error(e); process.exit(1); });
