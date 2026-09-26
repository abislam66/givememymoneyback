// Builds 18 made-up test cases (bill + EOB) and an answer key.
// Every provider, insurer and patient here is fictional. Output is reproducible (seeded RNG).
//
//   npm run generate

const fs = require('fs');
const path = require('path');
const { CPT } = require('../src/cpt');

const OUT_DIR = __dirname;
const CASES_DIR = path.join(OUT_DIR, 'cases');

// ---------- seeded random ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260926);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const randDigits = (n) => Array.from({ length: n }, () => randInt(0, 9)).join('');
const round2 = (x) => Math.round(x * 100) / 100;
const sum = (arr, f) => round2(arr.reduce((s, x) => s + f(x), 0));

function addDays(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- fictional people and organizations ----------
const PROFILES = {
  maya: { id: 'maya', name: 'Maya Torres', relation: 'self' },
  daniel: { id: 'daniel', name: 'Daniel Torres', relation: 'spouse' },
  leo: { id: 'leo', name: 'Leo Torres', relation: 'child' },
  rosa: { id: 'rosa', name: 'Rosa Torres', relation: 'parent' },
};
const MEMBER_IDS = { maya: 'BFH' + '482913', daniel: 'BFH' + '482914', leo: 'BFH' + '482915', rosa: 'EVM' + '771208' };
const INSURER = { maya: 'Bluefinch Health Plan', daniel: 'Bluefinch Health Plan', leo: 'Bluefinch Health Plan', rosa: 'Evergreen Mutual Health' };

const PROVIDERS = {
  owlbrook: { name: 'Owlbrook Regional Hospital', address: '1200 Linden Ridge Rd, Fairhaven, PA 19000' },
  stonebridge: { name: 'Stonebridge Emergency Center', address: '88 Quarry Lane, Millbrook, PA 19001' },
  brightwater: { name: 'Brightwater Family Practice', address: '45 Elm Court, Fairhaven, PA 19000' },
  quillfield: { name: 'Quillfield Imaging Center', address: '310 Mercer Ave, Fairhaven, PA 19002' },
  kestrel: { name: 'Kestrel Lab Services', address: '9 Harbor Point Dr, Millbrook, PA 19001' },
  northgate: { name: 'Northgate Physical Therapy', address: '702 North Gate Blvd, Fairhaven, PA 19003' },
};

// ---------- visit templates ----------
// charge: [low, high] in whole dollars. day: offset from the first service date.
const VISIT_CODES = new Set(['99283', '99284', '99285', '99213', '97161']);
const TEMPLATES = {
  er_chest: {
    service_type: 'emergency', what: 'ER visit for chest pain',
    lines: [
      { code: '99285', charge: [2400, 2900] }, { code: '93000', charge: [180, 260] },
      { code: '71046', charge: [320, 420] }, { code: '80053', charge: [180, 240] },
      { code: '85025', charge: [90, 130] }, { code: '36415', charge: [30, 45] },
    ],
  },
  er_cut: {
    service_type: 'emergency', what: 'ER visit for a cut hand',
    lines: [
      { code: '99283', charge: [700, 900] }, { code: '12002', charge: [500, 700] },
      { code: '90715', charge: [90, 120] }, { code: '90471', charge: [40, 60] },
    ],
  },
  er_head: {
    service_type: 'emergency', what: 'ER visit for a head bump',
    lines: [
      { code: '99284', charge: [1000, 1300] }, { code: '70450', charge: [1400, 1900] },
      { code: '96374', charge: [220, 300] },
    ],
  },
  er_ankle: {
    service_type: 'emergency', what: 'ER visit for a twisted ankle',
    lines: [
      { code: '99284', charge: [1000, 1250] }, { code: '73610', charge: [340, 420] },
      { code: '29540', charge: [150, 210] },
    ],
  },
  office: {
    service_type: 'office', what: 'yearly checkup at the family doctor',
    lines: [
      { code: '99213', charge: [180, 240] }, { code: '80061', charge: [90, 130] },
      { code: '85025', charge: [60, 90] }, { code: '36415', charge: [25, 40] },
    ],
  },
  mri: {
    service_type: 'imaging', what: 'MRI of the lower back',
    lines: [{ code: '72148', charge: [1800, 2600] }],
  },
  lab: {
    service_type: 'lab', what: 'blood tests at a lab',
    lines: [
      { code: '80053', charge: [160, 230] }, { code: '80061', charge: [90, 130] },
      { code: '84443', charge: [90, 130] }, { code: '36415', charge: [25, 40] },
    ],
  },
  pt: {
    service_type: 'therapy', what: 'physical therapy for a sore knee',
    lines: [
      { code: '97161', charge: [220, 280] }, { code: '97110', charge: [110, 150] },
      { code: '97110', charge: [110, 150], day: 7 }, { code: '97110', charge: [110, 150], day: 14 },
    ],
  },
};

// Cost sharing: a copay on the visit line for ER and office visits, coinsurance on everything else.
const COST_SHARE = {
  emergency: { copay: 150, coins: 0.2 },
  office: { copay: 30, coins: 0.1 },
  imaging: { copay: 0, coins: 0.2 },
  lab: { copay: 0, coins: 0.1 },
  therapy: { copay: 0, coins: 0.2 },
};

// ---------- build a correct case ----------
function buildCorrectCase({ id, template, profile, provider, network, date, patientPayment }) {
  const t = TEMPLATES[template];
  const p = PROFILES[profile];
  const prov = PROVIDERS[provider];
  const share = COST_SHARE[t.service_type];
  const insurer = INSURER[profile];

  const eobLines = t.lines.map((l) => {
    const billed = randInt(l.charge[0], l.charge[1]);
    const allowed = Math.round(billed * (0.35 + rand() * 0.25)); // 35–60% of billed
    let patient_resp;
    if (VISIT_CODES.has(l.code) && share.copay > 0) patient_resp = Math.min(share.copay, allowed);
    else patient_resp = Math.round(allowed * share.coins);
    return {
      date: addDays(date, l.day || 0), code: l.code, description: CPT[l.code].name, units: 1,
      billed, allowed, insurer_paid: allowed - patient_resp, patient_resp,
    };
  });

  const lastDate = eobLines.reduce((m, l) => (l.date > m ? l.date : m), date);
  const statement_date = addDays(lastDate, 34);

  const eob = {
    id: `EOB-${id}`, insurer, member: { name: p.name, id: MEMBER_IDS[profile] },
    claim_number: `CLM-${randDigits(9)}`, provider_name: prov.name,
    network, service_type: t.service_type,
    lines: eobLines, totals: eobTotals(eobLines),
  };

  const bill = {
    id: `BILL-${id}`, provider: { ...prov }, patient: { name: p.name },
    account_number: `ACCT-${randDigits(8)}`, statement_date,
    lines: eobLines.map((l, i) => ({ line_no: i + 1, date: l.date, code: l.code, description: l.description, units: l.units, charge: l.billed })),
    adjustments: [{ description: 'Contractual adjustment', amount: sum(eobLines, (l) => l.billed - l.allowed) }],
    insurance_payments: [{ date: addDays(lastDate, 21), payer: insurer, amount: eob.totals.insurer_paid }],
    patient_payments: patientPayment ? [{ date, amount: patientPayment }] : [],
    amount_due: 0,
  };
  recomputeAmountDue(bill);
  return { id, title: '', profile: { ...p }, bill, eob };
}

function eobTotals(lines) {
  return {
    billed: sum(lines, (l) => l.billed), allowed: sum(lines, (l) => l.allowed),
    insurer_paid: sum(lines, (l) => l.insurer_paid), patient_resp: sum(lines, (l) => l.patient_resp),
  };
}

function recomputeAmountDue(bill) {
  bill.amount_due = round2(
    sum(bill.lines, (l) => l.charge) - sum(bill.adjustments, (a) => a.amount)
    - sum(bill.insurance_payments, (p) => p.amount) - sum(bill.patient_payments, (p) => p.amount)
  );
}

function renumber(bill) { bill.lines.forEach((l, i) => { l.line_no = i + 1; }); }

// ---------- plant errors (each returns { type, amount }) ----------
const plant = {
  duplicate_charge(c, code) {
    const idx = c.bill.lines.findIndex((l) => l.code === code);
    if (idx < 0 || VISIT_CODES.has(code)) throw new Error(`${c.id}: can't duplicate ${code}`);
    const copy = { ...c.bill.lines[idx] };
    c.bill.lines.splice(idx + 1, 0, copy);
    renumber(c.bill);
    return { type: 'duplicate_charge', amount: copy.charge };
  },
  missing_insurance_payment(c, fraction) {
    // fraction = share of the insurer payment that never shows up on the bill (1 = removed entirely)
    const pay = c.bill.insurance_payments[0];
    const missing = round2(Math.round(pay.amount * fraction));
    if (fraction >= 1) c.bill.insurance_payments = [];
    else pay.amount = round2(pay.amount - missing);
    return { type: 'missing_insurance_payment', amount: fraction >= 1 ? c.eob.totals.insurer_paid : missing };
  },
  not_submitted_to_insurance(c, code, charge) {
    const date = c.bill.lines[0].date;
    if (c.eob.lines.some((l) => l.code === code && l.date === date)) throw new Error(`${c.id}: ${code} already on EOB`);
    c.bill.lines.push({ line_no: 0, date, code, description: CPT[code].name, units: 1, charge });
    renumber(c.bill);
    return { type: 'not_submitted_to_insurance', amount: charge };
  },
  adjustment_missing(c, fraction) {
    const adj = c.bill.adjustments[0];
    const short = fraction >= 1 ? adj.amount : round2(Math.round(adj.amount * fraction));
    if (fraction >= 1) c.bill.adjustments = [];
    else adj.amount = round2(adj.amount - short);
    return { type: 'adjustment_missing', amount: short };
  },
  charge_mismatch(c, code, extra) {
    const line = c.bill.lines.find((l) => l.code === code);
    line.charge = round2(line.charge + extra);
    return { type: 'charge_mismatch', amount: extra };
  },
  surprise_bill_nsa(c) {
    if (c.eob.network !== 'out-of-network' || c.eob.service_type !== 'emergency') throw new Error(`${c.id}: NSA needs OON emergency`);
    const amount = sum(c.bill.adjustments, (a) => a.amount);
    c.bill.adjustments = [];
    return { type: 'surprise_bill_nsa', amount };
  },
};

// ---------- hero case (exact numbers from the spec) ----------
function heroCase() {
  const date = '2026-03-03';
  const p = PROFILES.maya;
  const eobLines = [
    { date, code: '99284', description: CPT['99284'].name, units: 1, billed: 1100, allowed: 560, insurer_paid: 410, patient_resp: 150 },
    { date, code: '73610', description: CPT['73610'].name, units: 1, billed: 380, allowed: 180, insurer_paid: 110, patient_resp: 70 },
    { date, code: '29540', description: CPT['29540'].name, units: 1, billed: 180, allowed: 120, insurer_paid: 90, patient_resp: 30 },
  ];
  const bill = {
    id: 'BILL-case-01', provider: { ...PROVIDERS.owlbrook }, patient: { name: p.name },
    account_number: 'ACCT-40218837', statement_date: '2026-04-06',
    lines: [
      { line_no: 1, date, code: '99284', description: CPT['99284'].name, units: 1, charge: 1100 },
      { line_no: 2, date, code: '73610', description: CPT['73610'].name, units: 1, charge: 380 },
      { line_no: 3, date, code: '73610', description: CPT['73610'].name, units: 1, charge: 380 },
      { line_no: 4, date, code: '29540', description: CPT['29540'].name, units: 1, charge: 180 },
    ],
    adjustments: [{ description: 'Contractual adjustment', amount: 800 }],
    insurance_payments: [],
    patient_payments: [],
    amount_due: 0,
  };
  recomputeAmountDue(bill);
  const eob = {
    id: 'EOB-case-01', insurer: INSURER.maya, member: { name: p.name, id: MEMBER_IDS.maya },
    claim_number: 'CLM-771045213', provider_name: PROVIDERS.owlbrook.name,
    network: 'in-network', service_type: 'emergency',
    lines: eobLines, totals: eobTotals(eobLines),
  };
  return {
    case: { id: 'case-01', title: 'Maya, ER visit for a sprained ankle', profile: { ...p }, bill, eob },
    errors: [{ type: 'duplicate_charge', amount: 380 }, { type: 'missing_insurance_payment', amount: 610 }],
  };
}

// ---------- the other 17 cases ----------
// plants: [ [plantName, ...args] ]
const SPECS = [
  { profile: 'daniel', template: 'office', provider: 'brightwater', network: 'in-network', date: '2026-01-14', plants: [] },
  { profile: 'rosa', template: 'lab', provider: 'kestrel', network: 'in-network', date: '2026-01-28', plants: [] },
  { profile: 'leo', template: 'er_cut', provider: 'owlbrook', network: 'in-network', date: '2026-02-09', patientPayment: 100, plants: [], note: 'paid $100 at the visit' },
  { profile: 'daniel', template: 'er_head', provider: 'stonebridge', network: 'out-of-network', date: '2026-02-21', plants: [], note: 'out-of-network ER, billed correctly' },
  { profile: 'rosa', template: 'er_chest', provider: 'owlbrook', network: 'in-network', date: '2026-03-12', plants: [['duplicate_charge', '93000']] },
  { profile: 'maya', template: 'mri', provider: 'quillfield', network: 'in-network', date: '2026-03-25', plants: [['missing_insurance_payment', 0.5]] },
  { profile: 'rosa', template: 'office', provider: 'brightwater', network: 'in-network', date: '2026-04-02', plants: [['not_submitted_to_insurance', '84443', 115]] },
  { profile: 'daniel', template: 'pt', provider: 'northgate', network: 'in-network', date: '2026-04-13', plants: [['adjustment_missing', 0.4]] },
  { profile: 'maya', template: 'lab', provider: 'kestrel', network: 'in-network', date: '2026-04-27', plants: [['charge_mismatch', '80053', 65]] },
  { profile: 'leo', template: 'er_ankle', provider: 'stonebridge', network: 'out-of-network', date: '2026-05-08', plants: [['surprise_bill_nsa']] },
  { profile: 'maya', template: 'er_head', provider: 'stonebridge', network: 'out-of-network', date: '2026-05-19', plants: [['surprise_bill_nsa'], ['duplicate_charge', '70450']] },
  { profile: 'daniel', template: 'er_cut', provider: 'owlbrook', network: 'in-network', date: '2026-06-01', plants: [['not_submitted_to_insurance', '99070', 85], ['charge_mismatch', '12002', 120]] },
  { profile: 'leo', template: 'office', provider: 'brightwater', network: 'in-network', date: '2026-06-15', plants: [['adjustment_missing', 1], ['missing_insurance_payment', 1]] },
  { profile: 'rosa', template: 'pt', provider: 'northgate', network: 'in-network', date: '2026-06-24', plants: [['charge_mismatch', '97161', 40], ['duplicate_charge', '97110']] },
  { profile: 'daniel', template: 'mri', provider: 'quillfield', network: 'in-network', date: '2026-07-07', plants: [['not_submitted_to_insurance', '99070', 140]] },
  { profile: 'maya', template: 'er_chest', provider: 'owlbrook', network: 'in-network', date: '2026-07-20', plants: [['adjustment_missing', 0.3]] },
  { profile: 'leo', template: 'lab', provider: 'kestrel', network: 'in-network', date: '2026-08-04', plants: [['missing_insurance_payment', 1]] },
];

function firstName(profile) { return PROFILES[profile].name.split(' ')[0]; }

function main() {
  fs.mkdirSync(CASES_DIR, { recursive: true });
  for (const f of fs.readdirSync(CASES_DIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(CASES_DIR, f));

  const cases = [];
  const answerKey = {};

  const hero = heroCase();
  cases.push(hero.case);
  answerKey[hero.case.id] = { errors: hero.errors, expected_owe: expectedOwe(hero.case) };

  SPECS.forEach((spec, i) => {
    const id = `case-${String(i + 2).padStart(2, '0')}`;
    const c = buildCorrectCase({ id, ...spec });
    c.title = `${firstName(spec.profile)}, ${TEMPLATES[spec.template].what}` +
      (spec.network === 'out-of-network' ? ' (out-of-network)' : '');
    const errors = spec.plants.map(([name, ...args]) => plant[name](c, ...args));
    recomputeAmountDue(c.bill); // always recompute after planting
    cases.push(c);
    answerKey[id] = { errors, expected_owe: expectedOwe(c) };
  });

  // ---------- check ----------
  let ok = true;
  const rows = [];
  for (const c of cases) {
    const b = c.bill;
    const recomputed = round2(sum(b.lines, (l) => l.charge) - sum(b.adjustments, (a) => a.amount)
      - sum(b.insurance_payments, (p) => p.amount) - sum(b.patient_payments, (p) => p.amount));
    const consistent = Math.abs(recomputed - b.amount_due) < 0.005;
    const totalsOk = JSON.stringify(eobTotals(c.eob.lines)) === JSON.stringify(c.eob.totals);
    const linesOk = c.eob.lines.every((l) => Math.abs(l.allowed - l.patient_resp - l.insurer_paid) < 0.005);
    if (!consistent || !totalsOk || !linesOk) ok = false;
    const key = answerKey[c.id];
    rows.push({
      id: c.id, profile: c.profile.id, title: c.title,
      errors: key.errors.map((e) => `${e.type} $${e.amount}`).join(', ') || '(none)',
      amount_due: b.amount_due, expected_owe: key.expected_owe,
      check: consistent && totalsOk && linesOk ? 'ok' : 'BAD',
    });
    fs.writeFileSync(path.join(CASES_DIR, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'answer_key.json'), JSON.stringify(answerKey, null, 2) + '\n');

  printTable(rows);
  const counts = {};
  Object.values(answerKey).forEach((k) => k.errors.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; }));
  console.log('\nPlanted errors by type:', counts);
  console.log(`Clean cases: ${Object.values(answerKey).filter((k) => k.errors.length === 0).length}`);
  const hero1 = cases[0].bill.amount_due;
  if (hero1 !== 1240 || answerKey['case-01'].expected_owe !== 250) { ok = false; console.log('HERO CASE WRONG'); }
  console.log(ok ? `\nWrote ${cases.length} cases. amount_due verified for every case.` : '\nCHECK FAILED');
  if (!ok) process.exit(1);
}

function expectedOwe(c) {
  return Math.max(0, round2(c.eob.totals.patient_resp - sum(c.bill.patient_payments, (p) => p.amount)));
}

function printTable(rows) {
  const cols = ['id', 'profile', 'title', 'errors', 'amount_due', 'expected_owe', 'check'];
  const width = Object.fromEntries(cols.map((k) => [k, Math.max(k.length, ...rows.map((r) => String(r[k]).length))]));
  const line = (r) => cols.map((k) => String(r[k]).padEnd(width[k])).join(' | ');
  console.log(line(Object.fromEntries(cols.map((k) => [k, k]))));
  console.log(cols.map((k) => '-'.repeat(width[k])).join('-+-'));
  rows.forEach((r) => console.log(line(r)));
}

main();
