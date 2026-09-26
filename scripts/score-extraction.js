// Extraction scoreboard: runs Gemini extraction on the rendered sample documents (and any phone photos)
// and compares the result with the ground-truth JSON. Uses the SAME pipeline as live uploads
// (src/extract.js readDocument + finish), so this measures what the app really does.
//
//   npm run score:extraction                         # default 8 cases, PNG, one request every 6 s
//   npm run score:extraction -- --cases=case-01,hw-04 --delay=10 --format=pdf
//   npm run score:extraction -- --cases=3            # first 3 of the default list
//   npm run score:extraction -- --no-cache           # ignore cached answers and read again
//
// Phone photos: put data/photos/<case_id>-bill.jpg and <case_id>-eob.jpg (photos of printed documents).
// Cached answers go to data/extraction-cache/ (sample documents only, never user uploads).
// Writes data/extraction-scoreboard.json. Needs GEMINI_API_KEY; without it, exits cleanly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('../src/env').loadEnv();
const { hasGemini, config } = require('../src/gemini');
const { readDocument, finish, prompt, ExtractError } = require('../src/extract');
const { check } = require('../src/rules');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RENDERED = path.join(DATA, 'rendered');
const PHOTOS = path.join(DATA, 'photos');
const CACHE = path.join(DATA, 'extraction-cache');
const OUT = path.join(DATA, 'extraction-scoreboard.json');
const DEFAULT_CASES = ['case-01', 'case-05', 'case-09', 'case-12', 'case-14', 'hw-04', 'hw-06', 'hw-08'];
const TOL = 0.005; // "exact" means to the cent
const MONEY_TOL = 0.5; // for flag amounts and owed amounts, same as the rules scoreboard

// ---------- args ----------
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);
let caseIds = DEFAULT_CASES;
if (arg('cases')) caseIds = /^\d+$/.test(arg('cases')) ? DEFAULT_CASES.slice(0, Number(arg('cases'))) : arg('cases').split(',').map((s) => s.trim()).filter(Boolean);
const delayMs = Math.max(0, Number(arg('delay') || 6) * 1000);
const format = (arg('format') || 'png').toLowerCase();
const useCache = !flag('no-cache');

// ---------- ground truth ----------
function loadTruth() {
  const truth = {};
  const sets = [
    [path.join(DATA, 'cases'), path.join(DATA, 'answer_key.json')],
    [path.join(DATA, 'handwritten'), path.join(DATA, 'handwritten', 'answer_key.json')],
  ];
  for (const [dir, keyFile] of sets) {
    const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'answer_key.json')) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      truth[c.id] = { ...c, key: key[c.id] };
    }
  }
  return truth;
}

// ---------- comparing ----------
const eq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= TOL;
const sumAmt = (arr) => (arr || []).reduce((t, x) => t + (Number(x.amount) || 0), 0);
const units = (l) => (l.units === undefined ? 1 : Number(l.units));

// Line items matched by date and code (in order, so repeated lines pair up one-to-one).
function compareLines(truthLines, gotLines, fields) {
  const used = new Set();
  const rows = truthLines.map((t) => {
    const idx = gotLines.findIndex((g, i) => !used.has(i) && g.date === t.date && String(g.code).trim() === String(t.code).trim());
    if (idx < 0) return { ok: false, missing: true, key: `${t.date}|${t.code}` };
    used.add(idx);
    const g = gotLines[idx];
    const wrong = fields.filter((f) => (f === 'units' ? units(g) !== units(t) : !eq(g[f], t[f])));
    return { ok: wrong.length === 0, wrong, key: `${t.date}|${t.code}` };
  });
  const extra = gotLines.length - used.size;
  return { rows, exact: rows.filter((r) => r.ok).length, total: truthLines.length, extra };
}

function compareHeaders(tb, te, gb, ge) {
  const checks = [
    ['amount_due', eq(gb.amount_due, tb.amount_due)],
    ['insurance_payments', eq(sumAmt(gb.insurance_payments), sumAmt(tb.insurance_payments))],
    ['adjustments', eq(sumAmt(gb.adjustments), sumAmt(tb.adjustments))],
    ['network', ge.network === te.network],
    ['service_type', ge.service_type === te.service_type],
  ];
  return { checks: checks.map(([name, ok]) => ({ name, ok })), exact: checks.filter(([, ok]) => ok).length, total: checks.length };
}

function endToEnd(key, gb, ge) {
  const r = check(gb, ge);
  const found = r.flags.map((f) => ({ type: f.type, amount: f.amount }));
  const remaining = [...found];
  let caught = 0;
  for (const p of key.errors) {
    const i = remaining.findIndex((f) => f.type === p.type && Math.abs(f.amount - p.amount) <= MONEY_TOL);
    if (i >= 0) { caught += 1; remaining.splice(i, 1); }
  }
  const flagsOk = caught === key.errors.length && remaining.length === 0;
  const oweOk = Math.abs(r.summary.likely_owe - key.expected_owe) <= MONEY_TOL;
  return { flags_ok: flagsOk, owe_ok: oweOk, found: found.map((f) => `${f.type} ${f.amount}`), expected: key.errors.map((e) => `${e.type} ${e.amount}`), likely_owe: r.summary.likely_owe, expected_owe: key.expected_owe };
}

// ---------- reading, with a disk cache for sample documents ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function throttle() {
  const wait = lastCall + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function readFile(file, docType, label) {
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' }[ext];
  const { model } = config();
  const hash = crypto.createHash('sha256').update(bytes).update(model).update(prompt(docType)).digest('hex');
  const cacheFile = path.join(CACHE, `${label}-${docType}-${ext}-${model.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  if (useCache && fs.existsSync(cacheFile)) {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (c.hash === hash) return { raw: c.raw, cached: true };
  }
  await throttle();
  const raw = await readDocument({ data: bytes.toString('base64'), mime, docType });
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify({ hash, model, file: path.relative(ROOT, file), read_at: new Date().toISOString(), raw }, null, 2)}\n`);
  return { raw, cached: false };
}

async function scoreCase(truth, billFile, eobFile, label) {
  const rb = await readFile(billFile, 'bill', label);
  const re = await readFile(eobFile, 'eob', label);
  const gb = finish('bill', rb.raw);
  const ge = finish('eob', re.raw);
  const bl = compareLines(truth.bill.lines, gb.bill.lines, ['charge', 'units']);
  const el = compareLines(truth.eob.lines, ge.eob.lines, ['units', 'billed', 'allowed', 'insurer_paid', 'patient_resp']);
  const hd = compareHeaders(truth.bill, truth.eob, gb.bill, ge.eob);
  const e2e = endToEnd(truth.key, gb.bill, ge.eob);
  return {
    id: truth.id,
    cached: rb.cached && re.cached,
    bill_lines: { exact: bl.exact, total: bl.total, extra: bl.extra, wrong: bl.rows.filter((r) => !r.ok) },
    eob_lines: { exact: el.exact, total: el.total, extra: el.extra, wrong: el.rows.filter((r) => !r.ok) },
    headers: hd,
    review_issues: gb.issues.length + ge.issues.length, // what the review screen would have asked the person to check
    end_to_end: e2e,
  };
}

function totalsOf(rows) {
  const ok = rows.filter((r) => !r.error);
  const s = (f) => ok.reduce((t, r) => t + f(r), 0);
  return {
    cases: rows.length,
    errors: rows.length - ok.length,
    line_items_exact: s((r) => r.bill_lines.exact + r.eob_lines.exact),
    line_items_total: s((r) => r.bill_lines.total + r.eob_lines.total),
    headers_exact: s((r) => r.headers.exact),
    headers_total: s((r) => r.headers.total),
    flags_correct: ok.filter((r) => r.end_to_end.flags_ok).length,
    owe_correct: ok.filter((r) => r.end_to_end.owe_ok).length,
    review_flagged: ok.filter((r) => r.review_issues > 0).length,
  };
}

function printSummary(title, t) {
  console.log(`\n${title}: Read ${t.line_items_exact} of ${t.line_items_total} line items exactly. Header fields ${t.headers_exact} of ${t.headers_total}. `
    + `End-to-end: flags correct on ${t.flags_correct} of ${t.cases} cases, owed amount correct on ${t.owe_correct} of ${t.cases}.`
    + (t.errors ? ` (${t.errors} could not be read.)` : '')
    + ` The review step would have asked the person to check numbers on ${t.review_flagged} of ${t.cases - t.errors}.`);
}

async function runSet(title, items) {
  const rows = [];
  for (const it of items) {
    process.stdout.write(`  ${it.label} ... `);
    try {
      const r = await scoreCase(it.truth, it.bill, it.eob, it.label);
      rows.push(r);
      console.log(`${r.cached ? '(cached) ' : ''}lines ${r.bill_lines.exact + r.eob_lines.exact}/${r.bill_lines.total + r.eob_lines.total}, headers ${r.headers.exact}/${r.headers.total}, flags ${r.end_to_end.flags_ok ? 'ok' : 'WRONG'}, owe ${r.end_to_end.owe_ok ? 'ok' : 'WRONG'}${r.review_issues ? `, review flagged ${r.review_issues}` : ''}`);
    } catch (e) {
      const msg = e instanceof ExtractError ? e.message : `${e.message}`;
      console.log(`ERROR: ${msg}`);
      rows.push({ id: it.truth.id, error: msg });
      // A configuration problem (wrong model, bad key) will fail every case the same way; stop early.
      if (e instanceof ExtractError && /GEMINI_MODEL|GEMINI_API_KEY/.test(msg)) throw e;
    }
  }
  const totals = totalsOf(rows);
  printSummary(title, totals);
  return { name: title, totals, cases: rows };
}

async function main() {
  if (!hasGemini()) {
    console.log('No GEMINI_API_KEY is set, so extraction can\'t be scored. Add your key to .env (see .env.example) and run "npm run score:extraction" again.');
    console.log('No accuracy numbers were produced.');
    return;
  }
  if (!fs.existsSync(RENDERED)) {
    console.log('No rendered documents found. Run "npm run render" first.');
    process.exitCode = 1;
    return;
  }
  const truth = loadTruth();
  const unknown = caseIds.filter((id) => !truth[id]);
  if (unknown.length) { console.log(`Unknown case ids: ${unknown.join(', ')}`); process.exitCode = 1; return; }

  const { model } = config();
  console.log(`Extraction scoreboard. Model: "${model}" (GEMINI_MODEL). Format: ${format}. One request every ${delayMs / 1000}s. Cache: ${useCache ? 'on' : 'off'}.`);

  const rendered = caseIds.map((id) => ({
    label: id, truth: truth[id],
    bill: path.join(RENDERED, `${id}-bill.${format}`), eob: path.join(RENDERED, `${id}-eob.${format}`),
  }));
  const missing = rendered.filter((r) => !fs.existsSync(r.bill) || !fs.existsSync(r.eob));
  if (missing.length) { console.log(`Missing rendered files for ${missing.map((m) => m.label).join(', ')}. Run "npm run render".`); process.exitCode = 1; return; }

  const result = { generated_at: new Date().toISOString(), model, format, sets: [] };
  try {
    console.log(`\nRendered documents (${rendered.length} cases):`);
    result.sets.push({ id: 'rendered', ...(await runSet(`Rendered documents (${rendered.length} cases)`, rendered)) });

    const photos = [];
    if (fs.existsSync(PHOTOS)) {
      for (const id of Object.keys(truth)) {
        const find = (doc) => ['jpg', 'jpeg', 'png'].map((e) => path.join(PHOTOS, `${id}-${doc}.${e}`)).find((p) => fs.existsSync(p));
        const b = find('bill');
        const e = find('eob');
        if (b && e) photos.push({ label: `${id}-photo`, truth: truth[id], bill: b, eob: e });
      }
    }
    if (photos.length) {
      console.log(`\nPhone photos (${photos.length} cases):`);
      result.sets.push({ id: 'photos', ...(await runSet(`Phone photos (${photos.length} cases)`, photos)) });
    } else {
      console.log('\nPhone photos: none found in data/photos/ (name them <case_id>-bill.jpg and <case_id>-eob.jpg).');
    }
  } catch (e) {
    console.log(`\nStopped: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
