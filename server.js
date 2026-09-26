// SecondLook server. Express, in-memory state only. Works with no API keys.

const fs = require('fs');
const path = require('path');

require('./src/env').loadEnv();

const express = require('express');
const { check, normalize } = require('./src/rules');
const { buildLetter, buildCallScript } = require('./src/letter');
const { explainTerm, explainFinding, explainTermSmart, explainFindingSmart } = require('./src/explain');
const { extract } = require('./src/extract');
const { speak, hasTTS } = require('./src/tts');
const { hasGemini, config: geminiConfig, lastError: geminiLastError } = require('./src/gemini');
const disputes = require('./src/disputes');
const practice = require('./src/callpractice');
const ask = require('./src/ask');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA = path.join(__dirname, 'data');

app.use(express.json({ limit: '25mb' }));

// ---------- test cases (loaded once) ----------
function loadCases() {
  const dir = path.join(DATA, 'cases');
  if (!fs.existsSync(dir)) {
    console.warn('No test cases found. Run `npm run generate`.');
    return [];
  }
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
const CASES = loadCases();
const caseById = (id) => CASES.find((c) => c.id === id);

// Validate the minimum shape the rules engine needs, so bad input gets a friendly 400.
function badDocs(bill, eob) {
  if (!bill || typeof bill !== 'object' || !Array.isArray(bill.lines)) return 'The bill is missing or has no lines.';
  if (!eob || typeof eob !== 'object' || !Array.isArray(eob.lines)) return "The insurer's statement (EOB) is missing or has no lines.";
  if (bill.lines.length > 500 || eob.lines.length > 500) return 'That bill has too many lines for this demo.';
  return null;
}

function fullCheck(rawBill, rawEob) {
  const { bill, eob } = normalize(rawBill, rawEob);
  const result = check(bill, eob);
  return { ...result, letter: buildLetter(bill, eob, result), call_script: buildCallScript(result, bill, eob) };
}

// ---------- routes ----------
// Demo mode: the page sends this header, and the server skips every outside AI service.
const noAI = (req) => req.get('X-SecondLook-Demo') === '1';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Wraps a handler so known errors become friendly JSON and nothing can crash or hang the server.
const safe = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (e) {
    if (res.headersSent) return;
    if (Number.isInteger(e.status) && e.status >= 400 && e.status < 600 && e.message) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  }
};

app.get('/api/status', safe(() => ({
  gemini: hasGemini(), gemini_model: hasGemini() ? geminiConfig().model : null, gemini_error: geminiLastError(), elevenlabs: hasTTS(), cases: CASES.length,
})));

app.get('/api/cases', safe(() => CASES.map((c) => ({ id: c.id, title: c.title, profile: c.profile }))));

app.get('/api/cases/:id', safe((req) => {
  const c = caseById(req.params.id);
  if (!c) throw new HttpError(404, "We couldn't find that test case.");
  return { id: c.id, title: c.title, bill: c.bill, eob: c.eob, profile: c.profile };
}));

app.post('/api/check', safe((req) => {
  const { bill, eob } = req.body || {};
  const bad = badDocs(bill, eob);
  if (bad) throw new HttpError(400, bad);
  return fullCheck(bill, eob);
}));

app.post('/api/explain', safe(async (req) => {
  const body = req.body || {};
  const bad = badDocs(body.bill, body.eob);
  const { bill, eob } = bad ? {} : normalize(body.bill, body.eob);
  if (body.flag_id) {
    if (bad) throw new HttpError(400, bad);
    // Re-run the rules: we only explain flags the code found, never ones sent by the client.
    const flag = check(bill, eob).flags.find((f) => f.id === body.flag_id);
    if (!flag) throw new HttpError(404, 'That finding is no longer on this bill. Try re-checking.');
    if (noAI(req)) return { title: flag.title, text: explainFinding(flag, bill, eob), source: 'glossary' };
    return explainFindingSmart(flag, bill, eob);
  }
  if (!body.term || typeof body.term !== 'string') throw new HttpError(400, 'Send a term or a flag_id.');
  const term = body.term.slice(0, 80);
  const context = bad ? {} : { bill, eob };
  if (noAI(req)) {
    const t = explainTerm(term, context);
    return { title: t.title, text: t.text, source: 'glossary' };
  }
  return explainTermSmart(term, context);
}));

app.post('/api/extract', safe((req) => {
  if (noAI(req)) throw new HttpError(501, 'Uploads are off in demo mode. Turn off demo mode to read your own documents.');
  return extract(req.body || {});
}));

app.post('/api/tts', safe(async (req, res) => {
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string') throw new HttpError(400, 'No text to read.');
  if (!hasTTS() || noAI(req)) throw new HttpError(501, 'Voice is not set up. Using your browser voice instead.');
  const audio = await speak(text);
  if (!audio) throw new HttpError(502, 'The voice service did not answer. Using your browser voice instead.');
  res.set('Content-Type', 'audio/mpeg').send(audio);
}));

app.get('/api/scoreboard', safe((req, res) => {
  const file = path.join(DATA, 'scoreboard.json');
  if (!fs.existsSync(file)) throw new HttpError(404, 'No scoreboard yet. Run `npm run score`.');
  res.type('application/json').send(fs.readFileSync(file, 'utf8'));
}));

// Written by `npm run score:extraction` (needs a Gemini key). { available: false } until it has been run.
app.get('/api/extraction-scoreboard', safe((req, res) => {
  const file = path.join(DATA, 'extraction-scoreboard.json');
  if (!fs.existsSync(file)) return { available: false };
  res.type('application/json').send(fs.readFileSync(file, 'utf8'));
}));

// ---------- dispute agent ----------
app.get('/api/disputes', safe((req) => disputes.list({ profile_id: req.query.profile_id })));
app.post('/api/disputes', safe((req) => {
  const { case_id, bill, eob } = req.body || {};
  const bad = badDocs(bill, eob);
  if (bad) throw new HttpError(400, bad);
  // For test cases, trust the server's profile, not the client's.
  const c = case_id ? caseById(case_id) : null;
  return disputes.create({ case_id: c ? c.id : null, profile: c ? c.profile : (req.body.profile || null), bill, eob });
}));
app.post('/api/disputes/:id/send', safe((req) => disputes.markSent(req.params.id, req.body || {})));
app.post('/api/disputes/:id/advance', safe((req) => disputes.advance(req.params.id, { noAI: noAI(req) })));
app.post('/api/disputes/:id/resolve', safe((req) => disputes.resolve(req.params.id, req.body || {})));

// ---------- family bill manager + cost history ----------
// Per-claim numbers come from the documents and the rules. Savings come from disputes:
// "potential" is what the checks found; "confirmed" (Total Saved) counts resolved disputes only.
const MONEY_KEYS = ['billed', 'allowed', 'insurer_paid', 'patient_resp', 'patient_payments', 'amount_due', 'likely_owe', 'disputed', 'potential_savings', 'confirmed_savings'];
const r2 = (x) => Math.round(x * 100) / 100;
const CASE_SUMMARY = new Map(CASES.map((c) => {
  const { bill, eob } = normalize(c.bill, c.eob);
  const r = check(bill, eob);
  return [c.id, {
    case_id: c.id, title: c.title, profile: c.profile,
    service_date: (bill.lines[0] || {}).date || '', provider: (bill.provider || {}).name || '', claim_number: eob.claim_number,
    billed: r2(bill.lines.reduce((t, l) => t + l.charge, 0)), allowed: eob.totals.allowed, insurer_paid: eob.totals.insurer_paid,
    patient_resp: eob.totals.patient_resp, patient_payments: r2(bill.patient_payments.reduce((t, p) => t + p.amount, 0)),
    amount_due: r.summary.amount_due, likely_owe: r.summary.likely_owe, potential_savings: r.summary.potential_savings,
    findings: r.flags.length,
  }];
}));

function sumTotals(rows) {
  const t = Object.fromEntries(MONEY_KEYS.map((k) => [k, 0]));
  rows.forEach((row) => MONEY_KEYS.forEach((k) => { t[k] = r2(t[k] + (row[k] || 0)); }));
  t.claims = rows.length;
  t.findings = rows.reduce((n, row) => n + (row.findings || 0), 0);
  t.resolved = rows.filter((row) => row.dispute && row.dispute.status === 'resolved').length;
  return t;
}

app.get('/api/family', safe(() => {
  const all = disputes.list();
  const latestFor = (caseId) => {
    const mine = all.filter((d) => d.case_id === caseId);
    return mine.find((d) => d.status !== 'resolved') || mine[mine.length - 1] || null;
  };
  const claimRow = (s) => {
    const d = latestFor(s.case_id);
    const resolvedSaved = all.filter((x) => x.case_id === s.case_id && x.status === 'resolved').reduce((t, x) => t + x.confirmed_savings, 0);
    return {
      ...s,
      disputed: d ? d.disputed_amount : 0,
      confirmed_savings: r2(resolvedSaved),
      dispute: d ? { id: d.id, status: d.status, disputed_amount: d.disputed_amount, confirmed_savings: d.confirmed_savings, resolved_amount: d.resolved_amount } : null,
    };
  };
  const byProfile = new Map();
  for (const s of CASE_SUMMARY.values()) {
    const k = s.profile.id;
    if (!byProfile.has(k)) byProfile.set(k, { profile: s.profile, claims: [] });
    byProfile.get(k).claims.push(claimRow(s));
  }
  const people = [...byProfile.values()].map((p) => ({ ...p, totals: sumTotals(p.claims) }));
  // Disputes on uploaded bills belong to no test profile; they still count toward the family's Total Saved.
  const uploads = all.filter((d) => !d.case_id);
  const family = sumTotals(people.flatMap((p) => p.claims));
  const uploadSaved = r2(uploads.filter((d) => d.status === 'resolved').reduce((t, d) => t + d.confirmed_savings, 0));
  family.confirmed_savings = r2(family.confirmed_savings + uploadSaved);
  family.disputed = r2(family.disputed + uploads.reduce((t, d) => t + d.disputed_amount, 0));
  return { people, family, uploads: { disputes: uploads.length, confirmed_savings: uploadSaved }, total_saved: family.confirmed_savings };
}));

// ---------- Ask SecondLook: explains the current result; never creates findings ----------
app.post('/api/ask', safe((req) => {
  const { question, intent, history, bill, eob } = req.body || {};
  const bad = badDocs(bill, eob);
  if (bad) throw new HttpError(400, bad);
  return ask.answer({ question, intent, history, bill, eob, noAI: noAI(req) });
}));

// ---------- call practice (still used by /classic/) ----------
app.post('/api/practice/start', safe((req) => {
  const { bill, eob, case_id } = req.body || {};
  const bad = badDocs(bill, eob);
  if (bad) throw new HttpError(400, bad);
  return practice.start({ bill, eob, case_id, noAI: noAI(req) });
}));
app.post('/api/practice/:id/reply', safe((req) => practice.reply(req.params.id, (req.body || {}).text)));
app.post('/api/practice/:id/finish', safe((req) => practice.finish(req.params.id)));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// The review screen runs the same consistency checks as the server.
app.get('/askfacts.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'src', 'askfacts.js')));
app.get('/validate.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'src', 'validate.js')));
app.use(express.static(path.join(__dirname, 'public')));

// Friendly errors, including bad JSON bodies.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "That request wasn't valid JSON." });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big. Please use a file under 12 MB.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SecondLook running at http://localhost:${PORT}`);
    console.log(`Gemini: ${hasGemini() ? `on, model "${geminiConfig().model}" (set GEMINI_MODEL to change)` : 'off (using templates)'} | ElevenLabs: ${hasTTS() ? 'on' : 'off (browser voice)'} | ${CASES.length} test cases`);
  });
}

module.exports = app;
