// Renders every test case (generated + hand-written) as a realistic-looking bill and EOB.
//   npm run render
// Output: data/rendered/<case_id>-bill.png, -bill.pdf, -eob.png, -eob.pdf
// Three layout styles rotate across cases (different column orders, fonts, date formats and totals
// placement) so extraction isn't tuned to one look. Every page is marked "SAMPLE: FICTIONAL DATA".

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'rendered');
const SETS = [path.join(ROOT, 'data', 'cases'), path.join(ROOT, 'data', 'handwritten')];

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (a, f) => r2((a || []).reduce((t, x) => t + (Number(f(x)) || 0), 0));
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const credit = (n) => `-${usd(n)}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateFmt = {
  A: (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; },
  B: (iso) => { const [y, m, d] = iso.split('-'); return `${MON[Number(m) - 1]} ${Number(d)}, ${y}`; },
  C: (iso) => iso,
};
const units = (l) => (l.units === undefined ? 1 : l.units);
const initials = (name) => name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('');
const VISIT = new Set(['99283', '99284', '99285', '99213', '97161']);
const SERVICE_LABEL = { emergency: 'Emergency room', office: 'Office visit', imaging: 'Imaging', lab: 'Laboratory', therapy: 'Physical therapy' };

// EOB remark codes (fictional short set, similar to real claim adjustment reason codes).
function remark(l) {
  if (Number(l.allowed) === 0 && Number(l.insurer_paid) === 0) return 'N96';
  const codes = [];
  if (l.billed > l.allowed) codes.push('45');
  if (l.patient_resp > 0) codes.push(VISIT.has(l.code) ? '3' : '2');
  return codes.join(' ');
}
const REMARKS = [
  ['45', 'Charge exceeds the allowed amount for this plan. The provider may not bill you for the difference if in network.'],
  ['2', 'Coinsurance amount.'],
  ['3', 'Copay amount.'],
  ['N96', 'Not covered under this plan. You are responsible for this charge.'],
];

function logo(name, shape, color) {
  const ini = esc(initials(name));
  const inner = shape === 'shield'
    ? `<path d="M24 3 L43 10 L43 25 C43 36 34 43 24 46 C14 43 5 36 5 25 L5 10 Z" fill="${color}"/>`
    : shape === 'circle' ? `<circle cx="24" cy="24" r="21" fill="${color}"/>` : `<rect x="3" y="3" width="42" height="42" rx="8" fill="${color}"/>`;
  return `<svg class="logo" viewBox="0 0 48 48" width="48" height="48">${inner}<text x="24" y="30" text-anchor="middle" font-size="16" font-weight="700" fill="#fff" font-family="Arial">${ini}</text></svg>`;
}

const BASE_CSS = `
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #1a1a1a; }
  .page { width: 816px; min-height: 1056px; padding: 44px 48px 36px; position: relative; display: flex; flex-direction: column; }
  .sample { position: absolute; top: 12px; right: 48px; font: 700 9px Arial, sans-serif; letter-spacing: .12em; color: #9a2b2b; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .grow { flex: 1; }
  .fine { font-size: 9px; color: #555; line-height: 1.45; }
  .pageno { font-size: 10px; color: #444; text-align: right; margin-top: 6px; }
`;

// ---------------- BILLS ----------------
function billRows(b) {
  const rows = [];
  rows.push(['Total charges', usd(sum(b.lines, (l) => l.charge))]);
  (b.adjustments || []).forEach((a) => rows.push([a.description || 'Adjustment', credit(a.amount)]));
  (b.insurance_payments || []).forEach((p) => rows.push([`Insurance payment, ${p.payer}`, credit(p.amount)]));
  (b.patient_payments || []).forEach((p) => rows.push(['Patient payment', credit(p.amount)]));
  if (b.previous_balance) rows.push(['Previous balance', usd(b.previous_balance)]);
  return rows;
}

function billA(c) {
  const b = c.bill; const d = dateFmt.A;
  return `<style>${BASE_CSS}
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12px; }
    .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px double #333; padding-bottom: 12px; }
    .org { display: flex; gap: 12px; align-items: center; } .org h1 { font-size: 20px; margin: 0; } .org p { margin: 2px 0 0; font-size: 11px; }
    .due { border: 2px solid #222; padding: 8px 14px; text-align: right; } .due b { display: block; font-size: 22px; }
    .blocks { display: flex; justify-content: space-between; margin: 18px 0; font-size: 12px; } .blocks p { margin: 0 0 2px; }
    .lines th { border-bottom: 1.5px solid #222; padding: 6px 4px; font-size: 11px; text-transform: uppercase; }
    .lines td { padding: 6px 4px; border-bottom: 1px solid #ddd; }
    .tot { margin-left: auto; width: 330px; margin-top: 14px; } .tot td { padding: 4px; } .tot tr:last-child td { border-top: 2px solid #222; font-weight: 700; font-size: 14px; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>
    <div class="hdr"><div class="org">${logo(b.provider.name, 'square', '#1f4e79')}<div><h1>${esc(b.provider.name)}</h1><p>${esc(b.provider.address)}</p><p>Patient Accounts: (555) 010-4410</p></div></div>
      <div class="due">PATIENT STATEMENT<br>Amount Due<b>${usd(b.amount_due)}</b>Please pay by ${esc(d(addDays(b.statement_date, 30)))}</div></div>
    <div class="blocks"><div><p><b>Patient:</b> ${esc(b.patient.name)}</p><p><b>Guarantor:</b> ${esc(b.patient.name)}</p></div>
      <div><p><b>Account #:</b> ${esc(b.account_number)}</p><p><b>Statement date:</b> ${esc(d(b.statement_date))}</p></div></div>
    <table class="lines"><thead><tr><th>Date</th><th>Code</th><th>Description</th><th class="r">Units</th><th class="r">Charges</th></tr></thead>
      <tbody>${b.lines.map((l) => `<tr><td>${esc(d(l.date))}</td><td>${esc(l.code)}</td><td>${esc(l.description)}</td><td class="r">${units(l)}</td><td class="r">${usd(l.charge)}</td></tr>`).join('')}</tbody></table>
    <table class="tot">${billRows(b).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v}</td></tr>`).join('')}<tr><td>Amount Due</td><td class="r">${usd(b.amount_due)}</td></tr></table>
    <div class="grow"></div>
    <p class="fine">This statement lists services provided at ${esc(b.provider.name)}. Charges shown are before any insurance discounts unless listed as adjustments. If you have questions about your bill, call Patient Accounts at (555) 010-4410, Monday to Friday. Financial assistance may be available. This document contains fictional sample data for software testing.</p>
    <div class="pageno">Page 1 of 1</div></div>`;
}

function billB(c) {
  const b = c.bill; const d = dateFmt.B;
  return `<style>${BASE_CSS}
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11.5px; }
    .band { background: #0e6e63; color: #fff; margin: -44px -48px 0; padding: 26px 48px 18px; display: flex; gap: 14px; align-items: center; }
    .sample { color: #fff; z-index: 2; }
    .band h1 { font-size: 19px; margin: 0; } .band p { margin: 2px 0 0; font-size: 11px; opacity: .92; }
    .grid { display: grid; grid-template-columns: 240px 1fr; gap: 22px; margin-top: 22px; }
    .side { background: #f1f6f5; border-radius: 6px; padding: 14px; font-size: 11.5px; } .side h2 { font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #0e6e63; }
    .side table td { padding: 3px 0; } .side .bal td { border-top: 1.5px solid #0e6e63; font-weight: 700; font-size: 15px; padding-top: 6px; }
    .meta p { margin: 0 0 3px; } .meta { margin-bottom: 14px; }
    .lines th { background: #e3efed; padding: 7px 6px; font-size: 10.5px; } .lines td { padding: 7px 6px; border-bottom: 1px solid #e3e3e3; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>
    <div class="band">${logo(b.provider.name, 'circle', '#0a4f47')}<div><h1>${esc(b.provider.name)}</h1><p>${esc(b.provider.address)} · Billing questions (555) 010-2277</p></div></div>
    <div class="grid"><div class="side"><h2>Account summary</h2><table>${billRows(b).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v}</td></tr>`).join('')}
        <tr class="bal"><td>Balance due</td><td class="r">${usd(b.amount_due)}</td></tr></table></div>
      <div><div class="meta"><p><b>${esc(b.patient.name)}</b></p><p>Account number ${esc(b.account_number)}</p><p>Statement date ${esc(d(b.statement_date))}</p></div>
        <table class="lines"><thead><tr><th>Description</th><th>Code</th><th>Service date</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead>
        <tbody>${b.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.code)}</td><td>${esc(d(l.date))}</td><td class="r">${units(l)}</td><td class="r">${usd(l.charge)}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="grow"></div>
    <p class="fine">Keep this statement for your records. Payments received after the statement date may not appear. To set up a payment plan, call (555) 010-2277. Sample document with fictional data, created for testing.</p>
    <div class="pageno">Page 1 of 1</div></div>`;
}

function billC(c) {
  const b = c.bill; const d = dateFmt.C;
  return `<style>${BASE_CSS}
    body { font-family: 'Courier New', Courier, monospace; font-size: 11.5px; }
    .top { display: flex; justify-content: space-between; border-bottom: 1px dashed #000; padding-bottom: 10px; }
    .top h1 { font-size: 16px; margin: 0; letter-spacing: .04em; } .top p { margin: 2px 0 0; }
    .strip { display: flex; justify-content: space-between; background: #eee; padding: 6px 8px; margin: 12px 0; font-weight: 700; }
    .lines th { border-bottom: 1px solid #000; border-top: 1px solid #000; padding: 4px 8px; font-size: 11px; } .lines td { padding: 4px 8px; }
    .summary { margin-top: 14px; border-top: 1px dashed #000; padding-top: 8px; width: 380px; } .summary div { display: flex; justify-content: space-between; }
    .summary .due { font-weight: 700; border-top: 1px solid #000; margin-top: 4px; padding-top: 4px; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>
    <div class="top"><div style="display:flex;gap:10px;align-items:center">${logo(b.provider.name, 'shield', '#5a3d8a')}<div><h1>${esc(b.provider.name.toUpperCase())}</h1><p>${esc(b.provider.address.toUpperCase())}</p></div></div>
      <div style="text-align:right"><p>STMT DATE: ${esc(d(b.statement_date))}</p><p>ACCT NO: ${esc(b.account_number)}</p><p>PATIENT: ${esc(b.patient.name.toUpperCase())}</p></div></div>
    <div class="strip"><span>ITEMIZED STATEMENT OF SERVICES</span><span>BALANCE DUE ${usd(b.amount_due)}</span></div>
    <table class="lines"><thead><tr><th>LN</th><th>SVC DATE</th><th>CPT</th><th class="r">UNITS</th><th>DESCRIPTION</th><th class="r">CHARGE</th></tr></thead>
      <tbody>${b.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(d(l.date))}</td><td>${esc(l.code)}</td><td class="r">${units(l)}</td><td>${esc(l.description.toUpperCase())}</td><td class="r">${usd(l.charge)}</td></tr>`).join('')}</tbody></table>
    <div class="summary">${billRows(b).map(([k, v]) => `<div><span>${esc(k.toUpperCase())}</span><span>${v}</span></div>`).join('')}<div class="due"><span>BALANCE DUE</span><span>${usd(b.amount_due)}</span></div></div>
    <div class="grow"></div>
    <p class="fine">PLEASE DETACH AND RETURN THE BOTTOM PORTION WITH YOUR PAYMENT. QUESTIONS: (555) 010-9031. SAMPLE STATEMENT, FICTIONAL DATA FOR TESTING ONLY.</p>
    <div class="pageno">PAGE 1 OF 1</div></div>`;
}

// ---------------- EOBs ----------------
function eobHeader(e, color, shape, d, style) {
  return `<div class="ehdr" style="display:flex;justify-content:space-between;align-items:flex-start">
    <div style="display:flex;gap:12px;align-items:center">${logo(e.insurer, shape, color)}<div><div style="font-size:19px;font-weight:700">${esc(e.insurer)}</div><div style="font-size:11px">Member services (555) 010-7700</div></div></div>
    <div style="text-align:right"><div style="font-size:15px;font-weight:700;${style}">EXPLANATION OF BENEFITS</div><div style="font-size:11px;font-weight:700">THIS IS NOT A BILL</div></div></div>`;
}
function eobMeta(e, c, d) {
  const lastDate = e.lines.reduce((m, l) => (l.date > m ? l.date : m), e.lines[0].date);
  return [
    ['Member', e.member.name], ['Member ID', e.member.id], ['Claim number', e.claim_number],
    ['Provider', e.provider_name], ['Network status', e.network === 'out-of-network' ? 'Out-of-network' : 'In-network'],
    ['Type of service', SERVICE_LABEL[e.service_type] || e.service_type], ['Processed', d(addDays(lastDate, 20))],
  ];
}
const remarkLegend = (e) => {
  const used = new Set(e.lines.flatMap((l) => remark(l).split(' ').filter(Boolean)));
  return REMARKS.filter(([k]) => used.has(k)).map(([k, v]) => `<b>${k}</b>: ${esc(v)}`).join('<br>');
};

function eobA(c) {
  const e = c.eob; const d = dateFmt.A; const t = e.totals;
  return `<style>${BASE_CSS}
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5px; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 30px; margin: 16px 0; border: 1px solid #999; padding: 10px 12px; }
    .lines th { border-bottom: 1.5px solid #222; padding: 5px 3px; font-size: 10px; text-transform: uppercase; } .lines td { padding: 5px 3px; border-bottom: 1px solid #ddd; }
    .lines tfoot td { border-top: 2px solid #222; font-weight: 700; }
    .you { margin-top: 16px; border: 2px solid #222; padding: 10px 14px; display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>${eobHeader(e, '#8a1c2b', 'shield', d, '')}
    <div class="meta">${eobMeta(e, c, d).map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</div>
    <table class="lines"><thead><tr><th>Date</th><th>Code</th><th>Description</th><th class="r">Units</th><th class="r">Billed</th><th class="r">Allowed</th><th class="r">Paid by plan</th><th class="r">You owe</th><th>Remark</th></tr></thead>
      <tbody>${e.lines.map((l) => `<tr><td>${esc(d(l.date))}</td><td>${esc(l.code)}</td><td>${esc(l.description)}</td><td class="r">${units(l)}</td><td class="r">${usd(l.billed)}</td><td class="r">${usd(l.allowed)}</td><td class="r">${usd(l.insurer_paid)}</td><td class="r">${usd(l.patient_resp)}</td><td>${remark(l)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Claim totals</td><td class="r">${usd(t.billed)}</td><td class="r">${usd(t.allowed)}</td><td class="r">${usd(t.insurer_paid)}</td><td class="r">${usd(t.patient_resp)}</td><td></td></tr></tfoot></table>
    <div class="you"><span>Your total responsibility for this claim</span><span>${usd(t.patient_resp)}</span></div>
    <p class="fine" style="margin-top:14px"><b>Remark codes</b><br>${remarkLegend(e)}</p>
    <div class="grow"></div>
    <p class="fine">This explanation of benefits shows how your claim was processed. It is not a bill. Your provider may send you a bill for the amount you owe. To appeal this decision, contact member services within 180 days. Fictional sample document for testing.</p>
    <div class="pageno">Page 1 of 1</div></div>`;
}

function eobB(c) {
  const e = c.eob; const d = dateFmt.B; const t = e.totals;
  return `<style>${BASE_CSS}
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0; }
    .card { background: #eef3fa; border-radius: 6px; padding: 10px 12px; } .card b { display: block; font-size: 17px; margin-top: 3px; }
    .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 24px; margin-bottom: 12px; }
    .lines th { background: #1d3f73; color: #fff; padding: 6px 4px; font-size: 9.5px; } .lines td { padding: 6px 4px; border-bottom: 1px solid #dde3ec; }
    .lines tfoot td { background: #eef3fa; font-weight: 700; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>${eobHeader(e, '#1d3f73', 'circle', d, 'color:#1d3f73')}
    <div class="cards"><div class="card">Amount billed<b>${usd(t.billed)}</b></div><div class="card">Your plan paid<b>${usd(t.insurer_paid)}</b></div><div class="card">You may owe<b>${usd(t.patient_resp)}</b></div></div>
    <div class="meta">${eobMeta(e, c, d).map(([k, v]) => `<div>${esc(k)}: <b>${esc(v)}</b></div>`).join('')}</div>
    <table class="lines"><thead><tr><th>Service</th><th>Date</th><th>Code</th><th class="r">Qty</th><th class="r">Amount billed</th><th class="r">Plan discount</th><th class="r">Allowed</th><th class="r">Plan paid</th><th class="r">Your responsibility</th><th>Remarks</th></tr></thead>
      <tbody>${e.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(d(l.date))}</td><td>${esc(l.code)}</td><td class="r">${units(l)}</td><td class="r">${usd(l.billed)}</td><td class="r">${usd(r2(l.billed - l.allowed))}</td><td class="r">${usd(l.allowed)}</td><td class="r">${usd(l.insurer_paid)}</td><td class="r">${usd(l.patient_resp)}</td><td>${remark(l)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="r">${usd(t.billed)}</td><td class="r">${usd(r2(t.billed - t.allowed))}</td><td class="r">${usd(t.allowed)}</td><td class="r">${usd(t.insurer_paid)}</td><td class="r">${usd(t.patient_resp)}</td><td></td></tr></tfoot></table>
    <p class="fine" style="margin-top:12px"><b>What the remark codes mean</b><br>${remarkLegend(e)}</p>
    <div class="grow"></div>
    <p class="fine">Plan discount is the amount your provider agreed not to charge because of your plan. This is not a bill. Sample document with fictional data for software testing.</p>
    <div class="pageno">Page 1 of 1</div></div>`;
}

function eobC(c) {
  const e = c.eob; const d = dateFmt.C; const t = e.totals;
  return `<style>${BASE_CSS}
    body { font-family: 'Courier New', Courier, monospace; font-size: 11px; }
    .meta { margin: 12px 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 8px 0; columns: 2; }
    .meta div { break-inside: avoid; }
    .lines th { border-bottom: 1px solid #000; padding: 4px 6px; font-size: 10.5px; } .lines td { padding: 4px 6px; }
    .lines tfoot td { border-top: 1px solid #000; font-weight: 700; }
  </style>
  <div class="page"><div class="sample">SAMPLE: FICTIONAL DATA</div>${eobHeader(e, '#2f6b2f', 'square', d, 'letter-spacing:.06em')}
    <div class="meta">${eobMeta(e, c, d).map(([k, v]) => `<div>${esc(k.toUpperCase())}: ${esc(String(v).toUpperCase())}</div>`).join('')}</div>
    <table class="lines"><thead><tr><th>CPT</th><th>DOS</th><th class="r">UNITS</th><th class="r">BILLED</th><th class="r">ALLOWED</th><th class="r">YOUR SHARE</th><th class="r">PLAN PAID</th><th>RMK</th><th>DESCRIPTION</th></tr></thead>
      <tbody>${e.lines.map((l) => `<tr><td>${esc(l.code)}</td><td>${esc(d(l.date))}</td><td class="r">${units(l)}</td><td class="r">${usd(l.billed)}</td><td class="r">${usd(l.allowed)}</td><td class="r">${usd(l.patient_resp)}</td><td class="r">${usd(l.insurer_paid)}</td><td>${remark(l)}</td><td>${esc(l.description.toUpperCase())}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">CLAIM TOTAL</td><td class="r">${usd(t.billed)}</td><td class="r">${usd(t.allowed)}</td><td class="r">${usd(t.patient_resp)}</td><td class="r">${usd(t.insurer_paid)}</td><td colspan="2"></td></tr></tfoot></table>
    <p class="fine" style="margin-top:12px">REMARK CODES:<br>${remarkLegend(e)}</p>
    <div class="grow"></div>
    <p class="fine">THIS IS NOT A BILL. KEEP FOR YOUR RECORDS. DOS = DATE OF SERVICE. SAMPLE DOCUMENT, FICTIONAL DATA FOR TESTING.</p>
    <div class="pageno">PAGE 1 OF 1</div></div>`;
}

function addDays(iso, n) {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const LAYOUTS = { A: { bill: billA, eob: eobA }, B: { bill: billB, eob: eobB }, C: { bill: billC, eob: eobC } };

function loadAll() {
  const out = [];
  for (const dir of SETS) {
    if (!fs.existsSync(dir)) continue;
    fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'answer_key.json').sort()
      .forEach((f) => out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  }
  return out;
}

async function main() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) {
    console.error('Puppeteer is not installed. Run "npm install" first.');
    process.exit(1);
  }
  const only = (process.argv.find((a) => a.startsWith('--cases=')) || '').split('=')[1];
  const cases = loadAll().filter((c) => !only || only.split(',').includes(c.id));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 2 });
  const manifest = [];
  try {
    for (const [i, c] of cases.entries()) {
      const layout = ['A', 'B', 'C'][i % 3];
      for (const doc of ['bill', 'eob']) {
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.id)} ${doc}</title></head><body>${LAYOUTS[layout][doc](c)}</body></html>`;
        await page.setContent(html, { waitUntil: 'load' });
        const base = path.join(OUT, `${c.id}-${doc}`);
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        await page.pdf({ path: `${base}.pdf`, format: 'Letter', printBackground: true, pageRanges: '1' });
      }
      manifest.push({ id: c.id, layout });
      process.stdout.write(`${c.id} (layout ${layout}) `);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nRendered ${manifest.length} cases × (bill + EOB) × (PNG + PDF) into data/rendered/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
