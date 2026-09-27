// Gemini extraction: a photo or PDF of a bill or EOB -> JSON in SecondLook's data model.
// Gemini only READS the document. It never decides what is an error; src/rules.js does that.
// This one pipeline serves both live uploads (server.js) and the extraction scoreboard
// (scripts/score-extraction.js). Live uploads are cached in memory only, by file hash, and never saved.

const crypto = require('crypto');
const { generateDetailed, hasGemini } = require('./gemini');
const V = require('./validate');

const cache = new Map(); // sha256 -> result (in memory only)
const MAX_CACHE = 50;
const MIME_OK = /^(image\/(png|jpeg|jpg|webp|heic|heif)|application\/pdf)$/;

class ExtractError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

// ---------- prompt + response schema ----------
const S = (type, extra = {}) => ({ type, ...extra });
const NUM = S('NUMBER');
const STR = S('STRING');

const BILL_SCHEMA = S('OBJECT', {
  properties: {
    provider: S('OBJECT', { properties: { name: STR, address: STR } }),
    patient: S('OBJECT', { properties: { name: STR } }),
    account_number: STR,
    statement_date: S('STRING', { description: 'YYYY-MM-DD' }),
    lines: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          date: S('STRING', { description: 'Service date, YYYY-MM-DD' }),
          code: S('STRING', { description: 'CPT/HCPCS code exactly as printed, e.g. 73610' }),
          description: STR,
          units: S('NUMBER', { description: 'Units / Qty / Quantity column. 1 if not shown.' }),
          charge: S('NUMBER', { description: 'Line total charge as printed' }),
        },
        required: ['date', 'code', 'description', 'units', 'charge'],
      }),
    }),
    printed_total_charges: S('NUMBER', { nullable: true, description: 'The "Total charges" figure printed on the bill, or null if none is printed' }),
    adjustments: S('ARRAY', { items: S('OBJECT', { properties: { description: STR, amount: NUM }, required: ['amount'] }) }),
    insurance_payments: S('ARRAY', { items: S('OBJECT', { properties: { date: STR, payer: STR, amount: NUM }, required: ['amount'] }) }),
    patient_payments: S('ARRAY', { items: S('OBJECT', { properties: { date: STR, amount: NUM }, required: ['amount'] }) }),
    previous_balance: S('NUMBER', { description: 'Previous / prior balance carried forward, 0 if none' }),
    amount_due: S('NUMBER', { description: 'Amount due / balance due / please pay' }),
  },
  required: ['lines', 'amount_due'],
});

const EOB_SCHEMA = S('OBJECT', {
  properties: {
    insurer: STR,
    member: S('OBJECT', { properties: { name: STR, id: STR } }),
    claim_number: STR,
    provider_name: STR,
    network: S('STRING', { enum: ['in-network', 'out-of-network'] }),
    service_type: S('STRING', { enum: ['emergency', 'office', 'imaging', 'lab', 'therapy'] }),
    lines: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          date: S('STRING', { description: 'Date of service, YYYY-MM-DD' }),
          code: STR,
          description: STR,
          units: S('NUMBER', { description: 'Units / Qty column. 1 if not shown.' }),
          billed: S('NUMBER', { description: 'Amount billed / charged by the provider' }),
          allowed: S('NUMBER', { description: 'Allowed amount. NOT the plan discount.' }),
          insurer_paid: S('NUMBER', { description: 'Paid by plan / plan paid / insurer paid' }),
          patient_resp: S('NUMBER', { description: 'Your share / you owe / patient responsibility' }),
        },
        required: ['date', 'code', 'billed', 'allowed', 'insurer_paid', 'patient_resp'],
      }),
    }),
    totals: S('OBJECT', { properties: { billed: NUM, allowed: NUM, insurer_paid: NUM, patient_resp: NUM } }),
  },
  required: ['lines', 'totals', 'network', 'service_type'],
});

const COMMON_RULES = [
  'Copy values exactly as printed. Do not calculate, correct, round or guess. If a value is not printed, leave it out (or 0 / [] where the schema needs a value).',
  'Money is a plain number with no $ sign or commas: "$1,240.50" -> 1240.5.',
  'Dates become YYYY-MM-DD whatever the printed format ("03/03/2026", "Mar 3, 2026" and "2026-03-03" are all 2026-03-03).',
  'Make one entry in "lines" for every printed service line, in printed order, even when two lines look identical. Do not merge or drop repeated lines.',
  'Codes are the 5-character CPT/HCPCS codes (e.g. 99284, 73610). Copy them exactly.',
  'Units: use the Units / Qty / Quantity column. If there is no such column, use 1. The line amount is the total for all units; do not divide it.',
  'Ignore remark codes, logos, page numbers, phone numbers and small print.',
];

function prompt(docType) {
  if (docType === 'bill') {
    return `This file is a hospital or doctor BILL (patient statement). Read it into JSON.\n\nRules:\n- ${COMMON_RULES.join('\n- ')}\n`
      + '- adjustments: contractual adjustments, discounts and write-offs. insurance_payments: payments from an insurer or health plan. patient_payments: payments by the patient. All three are POSITIVE numbers even if printed with a minus sign or in parentheses.\n'
      + '- previous_balance: a balance carried forward from an earlier statement ("previous balance", "prior balance", "balance forward"). 0 if none.\n'
      + '- printed_total_charges: the total charges figure if the bill prints one, otherwise null.\n'
      + '- amount_due: the amount the patient is asked to pay ("amount due", "balance due", "please pay").';
  }
  return `This file is an insurance EXPLANATION OF BENEFITS (EOB). It is not a bill. Read it into JSON.\n\nRules:\n- ${COMMON_RULES.join('\n- ')}\n`
    + '- Column names vary. billed = amount billed/charged. allowed = allowed amount. insurer_paid = plan paid / paid by plan. patient_resp = your share / you owe / your responsibility. Some EOBs also print a "plan discount" column: that is billed minus allowed, NOT the allowed amount.\n'
    + '- A line that was denied or not covered can show allowed 0 and insurer_paid 0; copy it as printed.\n'
    + '- totals: the claim totals row as printed.\n'
    + '- network: "out-of-network" only if the EOB says the provider is out of network; otherwise "in-network".\n'
    + '- service_type: emergency (ER / emergency room), office (office or clinic visit), imaging (X-ray, CT, MRI, radiology), lab (laboratory, blood tests), therapy (physical/occupational therapy).';
}

// ---------- normalizing Gemini's JSON into the data model ----------
function toNumber(v, where, errors) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === 'string') {
    const neg = /^\s*\(.*\)\s*$/.test(v) || /^\s*-/.test(v);
    const n = Number(v.replace(/[^0-9.]/g, ''));
    if (v.trim() && Number.isFinite(n)) return Math.round((neg ? -n : n) * 100) / 100;
  }
  errors.push(`${where} is not a number`);
  return 0;
}
// Units (quantity) default to 1 when missing or unreadable.
function toUnits(v) {
  const n = typeof v === 'number' ? v : Number(String(v === undefined || v === null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 1;
}
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);
const optNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
};

function normDate(v) {
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const t = Date.parse(s);
  if (s && !Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return s;
}

function validateBill(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new ExtractError('The reader did not return a bill.');
  const lines = arr(raw.lines).map((l, i) => ({
    line_no: i + 1,
    date: normDate(l && l.date),
    code: str(l && l.code).toUpperCase(),
    description: str(l && l.description),
    units: toUnits(l && l.units),
    charge: toNumber(l && l.charge, `Line ${i + 1} charge`, errors),
  }));
  if (!lines.length) errors.push('No service lines were found on the bill');
  const bill = {
    id: 'BILL-upload',
    provider: { name: str(raw.provider && raw.provider.name), address: str(raw.provider && raw.provider.address) },
    patient: { name: str(raw.patient && raw.patient.name) },
    account_number: str(raw.account_number),
    statement_date: normDate(raw.statement_date),
    lines,
    adjustments: arr(raw.adjustments).map((a, i) => ({ description: str(a && a.description) || 'Adjustment', amount: Math.abs(toNumber(a && a.amount, `Adjustment ${i + 1}`, errors)) })),
    insurance_payments: arr(raw.insurance_payments).map((p, i) => ({ date: normDate(p && p.date), payer: str(p && p.payer), amount: Math.abs(toNumber(p && p.amount, `Insurance payment ${i + 1}`, errors)) })),
    patient_payments: arr(raw.patient_payments).map((p, i) => ({ date: normDate(p && p.date), amount: Math.abs(toNumber(p && p.amount, `Patient payment ${i + 1}`, errors)) })),
    previous_balance: optNumber(raw.previous_balance) || 0,
    printed_total_charges: optNumber(raw.printed_total_charges),
    amount_due: toNumber(raw.amount_due, 'Amount due', errors),
  };
  return { bill, errors, warnings };
}

function validateEob(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new ExtractError('The reader did not return an EOB.');
  const lines = arr(raw.lines).map((l, i) => ({
    date: normDate(l && l.date),
    code: str(l && l.code).toUpperCase(),
    description: str(l && l.description),
    units: toUnits(l && l.units),
    billed: toNumber(l && l.billed, `EOB line ${i + 1} billed`, errors),
    allowed: toNumber(l && l.allowed, `EOB line ${i + 1} allowed`, errors),
    insurer_paid: toNumber(l && l.insurer_paid, `EOB line ${i + 1} insurer paid`, errors),
    patient_resp: toNumber(l && l.patient_resp, `EOB line ${i + 1} patient responsibility`, errors),
  }));
  if (!lines.length) errors.push('No service lines were found on the EOB');
  const s = (k) => Math.round(lines.reduce((t, l) => t + l[k], 0) * 100) / 100;
  const t = raw.totals && typeof raw.totals === 'object' ? raw.totals : {};
  // Keep the PRINTED totals when present, so the review step can compare them with the lines.
  const totals = {};
  for (const k of ['billed', 'allowed', 'insurer_paid', 'patient_resp']) {
    const printed = optNumber(t[k]);
    totals[k] = printed === null ? s(k) : printed;
    if (printed === null) warnings.push(`The EOB total for ${k.replace('_', ' ')} wasn't found, so we added up the lines.`);
  }
  let network = str(raw.network).toLowerCase();
  if (!['in-network', 'out-of-network'].includes(network)) {
    network = /out/.test(network) ? 'out-of-network' : 'in-network';
    warnings.push(`Network status wasn't clear, so we assumed ${network}. Please check it.`);
  }
  let service = str(raw.service_type).toLowerCase();
  if (!['emergency', 'office', 'imaging', 'lab', 'therapy'].includes(service)) {
    service = /emerg|\ber\b/.test(service) ? 'emergency' : 'office';
    warnings.push(`Type of care wasn't clear, so we assumed ${service}. Please check it.`);
  }
  const eob = {
    id: 'EOB-upload',
    insurer: str(raw.insurer),
    member: { name: str(raw.member && raw.member.name), id: str(raw.member && raw.member.id) },
    claim_number: str(raw.claim_number),
    provider_name: str(raw.provider_name),
    network, service_type: service, lines, totals,
  };
  return { eob, errors, warnings };
}

// Map a Gemini failure to a clear message. Configuration problems name the model and GEMINI_MODEL.
function geminiFailure(err) {
  const config = ['model_not_found', 'permission', 'bad_key', 'unavailable', 'bad_request'];
  if (config.includes(err.kind)) return new ExtractError(err.message, 502);
  if (err.kind === 'rate_limited') return new ExtractError(err.message, 429);
  if (err.kind === 'timeout') return new ExtractError(`${err.message} Try a smaller or clearer file, or try again.`, 504);
  return new ExtractError(`We couldn't read that document right now (${err.message}) Please try again, or type the numbers in yourself.`, 502);
}

// Read raw Gemini JSON for one document. Exported for the scoreboard script, which keeps its own disk cache.
async function readDocument({ data, mime, docType }) {
  const parts = [{ inline_data: { mime_type: mime, data } }, { text: prompt(docType) }];
  const schema = docType === 'bill' ? BILL_SCHEMA : EOB_SCHEMA;
  let r = await generateDetailed({ parts, json: true, schema, temperature: 0, maxOutputTokens: 8192 });
  if (r.error && r.error.kind === 'bad_request' && /schema/i.test(`${r.error.detail} ${r.error.message}`)) {
    // Same model, same prompt, just without the structured-output schema.
    console.warn('[extract] the configured model rejected the response schema; retrying once without it');
    r = await generateDetailed({ parts, json: true, temperature: 0, maxOutputTokens: 8192 });
  }
  if (r.error) throw geminiFailure(r.error);
  try {
    return JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    throw new ExtractError("The reader's answer wasn't valid data. Please try a clearer photo, or type the numbers in yourself.", 502);
  }
}

// Normalize + check. Returns { bill|eob, warnings, issues }. Issues are "please review these numbers" items.
function finish(docType, raw) {
  const v = docType === 'bill' ? validateBill(raw) : validateEob(raw);
  const doc = docType === 'bill' ? v.bill : v.eob;
  const issues = docType === 'bill' ? V.checkBill(doc) : V.checkEob(doc);
  // Values that couldn't be read at all become review issues instead of a hard failure,
  // so the person can type them in.
  v.errors.forEach((msg) => issues.unshift({ message: `${msg}. Please type it in.`, fields: [] }));
  return { [docType]: doc, warnings: v.warnings, issues };
}

async function extract({ image_base64, mime_type, doc_type }) {
  if (!['bill', 'eob'].includes(doc_type)) throw new ExtractError('doc_type must be "bill" or "eob".', 400);
  if (!image_base64 || typeof image_base64 !== 'string') throw new ExtractError('No file was sent.', 400);
  const mime = str(mime_type).toLowerCase() || 'image/jpeg';
  if (!MIME_OK.test(mime)) throw new ExtractError('Please upload a PDF, PNG or JPG file.', 400);
  if (!hasGemini()) {
    throw new ExtractError('Reading documents needs a Gemini API key, and none is set up. You can type the numbers in yourself, or try an example.', 501);
  }
  const data = image_base64.replace(/^data:[^;]+;base64,/, '');
  const hash = crypto.createHash('sha256').update(doc_type).update(data).digest('hex');
  if (cache.has(hash)) return { ...cache.get(hash), cached: true };

  const raw = await readDocument({ data, mime, docType: doc_type });
  const result = finish(doc_type, raw);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(hash, result);
  return result;
}

module.exports = { extract, readDocument, finish, ExtractError, validateBill, validateEob, prompt, BILL_SCHEMA, EOB_SCHEMA };
