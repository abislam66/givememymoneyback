// In-memory dispute tracker. Status: draft -> sent -> follow_up_due -> resolved.
// Every dispute has an owner (a signed-in user, a guest viewing an example, or 'public' for /classic/) and is only
// visible to that owner. src/accounts.js saves signed-in users' disputes to Supabase after each change.
// Flags always come from the rules engine. Confirmed savings only exist after resolution.

const { check, normalize, round2, money } = require('./rules');
const { buildLetter, buildFollowUpLetter, longDate } = require('./letter');
const { polish } = require('./gemini');

const store = new Map();
let seq = 0;

class DisputeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

function escalationPath(d) {
  const insurer = d.eob.insurer || 'your insurer';
  return [
    { step: 'Call and ask for a billing supervisor', detail: `Call ${d.provider}. Give account ${d.account_number} and say you sent a dispute on ${longDate(d.sent_date)} with no answer. Ask for a supervisor and a reference number.` },
    { step: `File a complaint with ${insurer}`, detail: `Call the member services number on your insurance card. Give claim ${d.claim_number}. Ask them to contact the provider about the billing errors.` },
    { step: 'Contact your state insurance department', detail: 'Every state has a consumer help line for insurance and medical billing problems. You can file a complaint online for free.' },
  ];
}

function publicView(d) {
  const { bill, eob, owner, ...rest } = d; // eslint-disable-line no-unused-vars
  return rest;
}

function create({ owner = 'public', case_id, analysis_id, profile, bill: rawBill, eob: rawEob }) {
  const { bill, eob } = normalize(rawBill, rawEob);
  if (!bill.lines.length || !eob.lines.length) throw new DisputeError('A dispute needs a bill and an insurer statement.');
  const result = check(bill, eob);
  if (!result.flags.length) throw new DisputeError('There is nothing to dispute on this bill. It matches your insurer\'s statement.');

  // One open dispute per test case (or saved analysis) at a time, per owner.
  if (case_id || analysis_id) {
    const open = [...store.values()].find((d) => d.owner === owner && d.status !== 'resolved'
      && ((analysis_id && d.analysis_id === analysis_id) || (!analysis_id && case_id && d.case_id === case_id)));
    if (open) return { dispute: publicView(open), existing: true };
  }

  seq += 1;
  const s = result.summary;
  const d = {
    id: `D${String(seq).padStart(3, '0')}`,
    owner,
    analysis_id: analysis_id || null,
    case_id: case_id || null,
    profile_id: (profile && profile.id) || null,
    profile_name: (profile && profile.name) || (bill.patient && bill.patient.name) || '',
    provider: (bill.provider && bill.provider.name) || 'the provider',
    account_number: bill.account_number || '',
    claim_number: eob.claim_number || '',
    flags: result.flags,
    amount_due: s.amount_due,
    likely_owe: s.likely_owe,
    previous_balance: s.previous_balance || 0,
    disputed_amount: Math.max(0, round2(s.amount_due - (s.previous_balance || 0) - s.likely_owe)),
    potential_savings: s.potential_savings,
    pending_amount: s.pending_amount,
    totals: { billed: eob.totals.billed, allowed: eob.totals.allowed, insurer_paid: eob.totals.insurer_paid, patient_resp: eob.totals.patient_resp,
      patient_payments: round2(bill.patient_payments.reduce((t, p) => t + p.amount, 0)) },
    status: 'draft',
    created_date: todayIso(),
    sent_date: null,
    follow_up_date: null,
    today: todayIso(), // simulated "today" (moves when you simulate time passing)
    letter: buildLetter(bill, eob, result),
    follow_up_letter: null,
    follow_up_source: null,
    escalation: [],
    resolved_amount: null,
    resolved_date: null,
    confirmed_savings: 0,
    history: [{ date: todayIso(), status: 'draft', note: 'Dispute created from verified findings.' }],
    bill,
    eob,
  };
  store.set(d.id, d);
  return { dispute: publicView(d), existing: false };
}

function get(id, owner = 'public') {
  const d = store.get(id);
  if (!d || d.owner !== owner) throw new DisputeError('We could not find that dispute. The server may have restarted.', 404);
  return d;
}

function markSent(id, { date } = {}, owner) {
  const d = get(id, owner);
  if (d.status === 'resolved') throw new DisputeError('This dispute is already resolved.');
  if (d.status !== 'draft') throw new DisputeError('This dispute was already sent.');
  const sent = validDate(date) ? date : d.today;
  d.status = 'sent';
  d.sent_date = sent;
  d.follow_up_date = addDays(sent, 30);
  d.history.push({ date: sent, status: 'sent', note: `Letter sent. Follow up on ${longDate(d.follow_up_date)} if there is no answer.` });
  return publicView(d);
}

// "Simulate 30 days passing": the agent notices no answer, drafts the follow-up, and lays out the escalation path.
async function advance(id, { noAI = false } = {}, owner) {
  const d = get(id, owner);
  if (d.status === 'draft') throw new DisputeError('Mark the letter as sent first.');
  if (d.status === 'resolved') throw new DisputeError('This dispute is already resolved.');
  if (d.status === 'follow_up_due') return publicView(d);
  d.today = d.follow_up_date;
  d.status = 'follow_up_due';
  const template = buildFollowUpLetter(d, { date: d.today });
  const polished = noAI ? { text: template, source: 'template' } : await polish(template, {
    instruction: 'Make this follow-up letter firm but polite. Keep the same structure, every line item, and every number, date, code and account number exactly as written. Keep the [bracketed] placeholders.',
  });
  d.follow_up_letter = polished.text;
  d.follow_up_source = polished.source;
  d.escalation = escalationPath(d);
  d.history.push({ date: d.today, status: 'follow_up_due', note: '30 days passed with no answer. Follow-up letter drafted.' });
  return publicView(d);
}

function resolve(id, { amount } = {}, owner) {
  const d = get(id, owner);
  if (d.status === 'resolved') throw new DisputeError('This dispute is already resolved.');
  const n = typeof amount === 'number' ? amount : Number(String(amount === undefined ? '' : amount).replace(/[$,\s]/g, ''));
  if (String(amount === undefined ? '' : amount).trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new DisputeError('Enter the amount the provider now says you owe, like 250.');
  }
  d.resolved_amount = round2(n);
  d.resolved_date = d.today;
  d.confirmed_savings = Math.max(0, round2(d.amount_due - d.resolved_amount));
  d.status = 'resolved';
  d.history.push({ date: d.today, status: 'resolved', note: `Provider corrected the balance to ${money(d.resolved_amount)}. Saved ${money(d.confirmed_savings)}.` });
  return publicView(d);
}

function list({ owner = 'public', profile_id } = {}) {
  return [...store.values()].filter((d) => d.owner === owner && (!profile_id || d.profile_id === profile_id)).map(publicView);
}

// For src/accounts.js: the full record (to save), a saved record loaded back, a new id after saving, and removal.
const raw = (id, owner) => get(id, owner);
function adopt(d) { store.set(d.id, d); }
function rekey(oldId, newId) {
  const d = store.get(oldId);
  store.delete(oldId);
  d.id = newId;
  store.set(newId, d);
  return d;
}
function forget(id) { store.delete(id); }
function forgetOwner(owner) { for (const [id, d] of store) if (d.owner === owner) store.delete(id); }

module.exports = { create, markSent, advance, resolve, list, raw, adopt, rekey, forget, forgetOwner, publicView, DisputeError };
