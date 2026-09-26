// Call practice: the app plays a billing rep. Practice only; no real calls are ever placed.
// Scripted rep without a key; Gemini rep with a key (facts limited to verified findings).
// The checklist is scored by code, never by AI.

const crypto = require('crypto');
const { check, normalize, money, niceDate, plainName, fmtUnits } = require('./rules');
const { chat, hasGemini, sameFacts } = require('./gemini');

const sessions = new Map();
const MAX_SESSIONS = 200;
const SCRIPTED_TURNS = 5;
const GEMINI_TURNS = 6;

class PracticeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const REP_NAME = 'Jordan';

// The bill line a finding is about: the repeated line for a duplicate, else the last evidence line.
function lineOf(bill, flag) {
  const d = flag.details || {};
  const nos = (flag.evidence && flag.evidence.bill_lines) || [];
  const no = d.mode === 'units' ? nos[0] : ((d.dup_lines && d.dup_lines[0]) || nos[nos.length - 1]);
  return bill.lines.find((l) => l.line_no === no);
}

// The rep's pushback on one verified finding. Uses only facts from the documents.
function pushback(flag, bill, eob) {
  const l = lineOf(bill, flag);
  switch (flag.type) {
    case 'duplicate_charge': return flag.details && flag.details.mode === 'units'
      ? `Let me look. Our records show ${fmtUnits(flag.details.bill_units)} of ${plainName(l)} on ${niceDate(l.date)}. How do you know only ${flag.details.eob_units} ${flag.details.eob_units === 1 ? 'was' : 'were'} done?`
      : `Let me look. Our records show two ${plainName(l)} charges on ${niceDate(l.date)}. How do you know it was only done once?`;
    case 'missing_insurance_payment': return `Hmm, I don't see that insurance payment on our side yet. Do you have the claim number from ${eob.insurer || 'your insurer'}?`;
    case 'not_submitted_to_insurance': return `That ${plainName(l)} charge should have gone to insurance automatically. What makes you think it didn't?`;
    case 'adjustment_missing': return 'The adjustment on your account is what our system applied. Why do you think it is too small?';
    case 'charge_mismatch': return `${money(l.charge)} is our standard price for the ${plainName(l)}. Where are you seeing a different amount?`;
    case 'surprise_bill_nsa': return 'Our hospital is out of network for your plan, so the full charge applies. Why do you think it doesn\'t?';
    default: return 'The balance looks right to me. What part doesn\'t add up for you?';
  }
}

function scriptedLine(s, turn) {
  const { bill, eob, flags } = s;
  const prov = (bill.provider && bill.provider.name) || 'the billing office';
  switch (turn) {
    case 1: return `Thank you for calling ${prov} billing. My name is ${REP_NAME}. Can I have the account number and the patient's name, please?`;
    case 2: return `Thanks. I have the account for ${(bill.patient && bill.patient.name) || 'the patient'}. It shows a balance of ${money(bill.amount_due)}. What are you calling about today?`;
    case 3: return flags.length ? pushback(flags[0], bill, eob) : 'I can help with that. What would you like us to send you?';
    case 4: return flags.length > 1
      ? "Okay, I've made a note to review that. Is there anything else on this bill you want to raise?"
      : "Okay, I've made a note on the account to review that. Is there anything else?";
    default: return "Alright. I've sent this to our billing review team. Thanks for calling, and have a good day.";
  }
}

// Facts the Gemini rep is allowed to use, as plain text. Also the reference for number checks.
function factSheet(s) {
  const { bill, eob, flags, summary } = s;
  const lines = [
    `Provider: ${(bill.provider && bill.provider.name) || 'unknown'}`,
    `Patient: ${(bill.patient && bill.patient.name) || 'unknown'}`,
    `Account number: ${bill.account_number || 'unknown'}`,
    `Statement date: ${bill.statement_date || 'unknown'}`,
    `Balance on the account: ${money(summary.amount_due)}`,
    `Insurer: ${eob.insurer || 'unknown'}, claim number ${eob.claim_number || 'unknown'}`,
    'Bill lines:',
    ...bill.lines.map((l) => `  line ${l.line_no}: ${l.date} code ${l.code} ${l.description} ${money(l.charge)}`),
    'Problems the patient may raise (already verified; the rep does not know yet if they are right):',
    ...flags.map((f) => `  - ${f.title}: ${money(f.amount)}. ${f.explanation}`),
  ];
  return lines.join('\n');
}

function systemPrompt(s) {
  return `You are ${REP_NAME}, a hospital billing representative in a PRACTICE phone call. The user is a patient practicing how to dispute a bill.\n`
    + 'Be realistic: polite, a little busy, and push back once or twice before agreeing to review something. Keep each reply to 1 to 3 short sentences.\n'
    + 'Rules you must follow:\n'
    + '- Use ONLY the facts below. Never invent new charges, amounts, dates, codes, payments, names or policies.\n'
    + '- Do not say any number that is not in the facts below.\n'
    + '- Never promise a refund or a final amount. You can only agree to send the account for review, send an itemized bill, or put the account on hold.\n'
    + '- Do not give legal or medical advice.\n'
    + `- This call lasts at most ${GEMINI_TURNS} of your turns. On your last turn, wrap up the call politely.\n\n`
    + `FACTS:\n${factSheet(s)}`;
}

function start({ bill: rawBill, eob: rawEob, case_id, noAI = false }) {
  const { bill, eob } = normalize(rawBill, rawEob);
  if (!bill.lines.length || !eob.lines.length) throw new PracticeError('Pick a bill first, then start the practice call.');
  const result = check(bill, eob);
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const s = {
    id: crypto.randomUUID(),
    case_id: case_id || null,
    bill, eob,
    flags: result.flags,
    summary: result.summary,
    mode: hasGemini() && !noAI ? 'gemini' : 'scripted',
    max_turns: hasGemini() && !noAI ? GEMINI_TURNS : SCRIPTED_TURNS,
    turn: 1,
    transcript: [],
    done: false,
  };
  const first = scriptedLine(s, 1); // same opening either way, so the call starts instantly
  s.transcript.push({ role: 'rep', text: first });
  sessions.set(s.id, s);
  return { id: s.id, mode: s.mode, max_turns: s.max_turns, turn: s.turn, rep: first, done: false };
}

async function reply(id, text) {
  const s = sessions.get(id);
  if (!s) throw new PracticeError('That practice call ended. Start a new one.', 404);
  if (s.done) throw new PracticeError('This practice call is over. Press "Finish and score my call".');
  const said = String(text || '').trim().slice(0, 1000);
  if (!said) throw new PracticeError('Type what you would say to the billing rep.');
  s.transcript.push({ role: 'you', text: said });
  s.turn += 1;

  let rep = null;
  let source = 'scripted';
  if (s.mode === 'gemini') {
    const history = s.transcript.map((t) => ({ role: t.role === 'rep' ? 'model' : 'user', text: t.text }));
    // Gemini requires the conversation to start with a user turn.
    history.unshift({ role: 'user', text: '(The patient calls the billing office.)' });
    const out = await chat({ system: systemPrompt(s), history });
    // The rep may not introduce numbers that aren't in the verified facts or the patient's own words.
    if (out && sameFacts(out, `${factSheet(s)}\n${s.transcript.map((t) => t.text).join('\n')}`)) { rep = out; source = 'gemini'; }
  }
  if (!rep) rep = scriptedLine(s, Math.min(s.turn, SCRIPTED_TURNS));
  s.transcript.push({ role: 'rep', text: rep });
  if (s.turn >= s.max_turns) s.done = true;
  return { rep, source, turn: s.turn, max_turns: s.max_turns, done: s.done };
}

// ---------- deterministic checklist ----------
const TYPE_WORDS = {
  duplicate_charge: ['duplicate', 'twice', 'double', 'two times', 'charged two', 'billed two', 'same x-ray', 'repeat', 'extra unit', 'units'],
  missing_insurance_payment: ['payment', 'paid', 'not applied', 'missing'],
  not_submitted_to_insurance: ['not submitted', 'never submitted', 'submit', 'never sent', 'not sent', 'not on my eob', 'not on the eob', 'not on my insurance'],
  adjustment_missing: ['adjustment', 'discount', 'in-network', 'in network', 'contract'],
  charge_mismatch: ['price', 'higher', 'overcharg', 'different amount', "doesn't match", 'does not match', 'mismatch'],
  surprise_bill_nsa: ['no surprises', 'surprise', 'balance bill', 'emergency'],
  unexplained_difference: ['explain', 'difference', "doesn't add up", 'does not add up'],
};
const TYPE_TIP = {
  duplicate_charge: 'Say the line number, the date and the word "duplicate", so they can find it fast.',
  missing_insurance_payment: 'Say how much your insurer paid and give the claim number.',
  not_submitted_to_insurance: 'Ask them to submit that line to your insurance before billing you.',
  adjustment_missing: 'Say you are in network and the contractual adjustment is missing.',
  charge_mismatch: 'Say the bill price is higher than what they billed your insurer.',
  surprise_bill_nsa: 'Mention the No Surprises Act. It protects emergency care.',
  unexplained_difference: 'Ask them to explain the part of the balance your EOB does not cover.',
};

const digits = (s) => String(s || '').replace(/\D/g, '');

function mentionsFlag(text, f, bill) {
  const t = text.toLowerCase();
  const nums = t.replace(/(\d),(\d)/g, '$1$2');
  const l = lineOf(bill, f);
  const amt = String(Math.round(f.amount * 100) / 100);
  if (new RegExp(`(^|[^\\d.])${amt.replace('.', '\\.')}(?![\\d])`).test(nums)) return true;
  if (l && l.code && t.includes(l.code)) return true;
  if (l && (f.type === 'duplicate_charge' || f.type === 'charge_mismatch' || f.type === 'not_submitted_to_insurance')) {
    const name = plainName(l).toLowerCase().replace(/\s*\(.*\)/, '');
    if (name && t.includes(name) && (TYPE_WORDS[f.type] || []).some((w) => t.includes(w))) return true;
    const d = niceDate(l.date).toLowerCase();
    if (t.includes(d) && (TYPE_WORDS[f.type] || []).some((w) => t.includes(w))) return true;
  }
  return (TYPE_WORDS[f.type] || []).some((w) => t.includes(w));
}

function score(s) {
  const text = s.transcript.filter((t) => t.role === 'you').map((t) => t.text).join('\n');
  const t = text.toLowerCase();
  const items = [];
  s.flags.forEach((f) => {
    items.push({ item: `Named the problem: ${f.title} (${money(f.amount)})`, ok: mentionsFlag(text, f, s.bill), tip: TYPE_TIP[f.type] || 'Name this problem clearly.' });
  });
  const acct = digits(s.bill.account_number);
  const claim = digits(s.eob.claim_number);
  const said = digits(text.replace(/\s/g, ''));
  const gaveNumber = (acct.length >= 4 && said.includes(acct)) || (claim.length >= 4 && said.includes(claim))
    || (s.bill.account_number && t.includes(s.bill.account_number.toLowerCase())) || (s.eob.claim_number && t.includes(s.eob.claim_number.toLowerCase()));
  items.push({ item: 'Gave the account or claim number', ok: Boolean(gaveNumber), tip: `Read your account number (${s.bill.account_number || 'on your bill'}) at the start of the call.` });
  items.push({ item: 'Asked for an itemized bill', ok: /itemi[sz]ed/.test(t), tip: 'Ask for a corrected, itemized bill. It lists every charge.' });
  items.push({ item: 'Asked them to keep the bill out of collections', ok: /collection/.test(t), tip: 'Ask them to put the account on hold so it does not go to collections.' });
  items.push({
    item: 'Asked about next steps or a timeline',
    ok: /next step|what happens next|timeline|time ?frame|how long|when (will|should|can|do|would)|by when|how many days|follow[- ]?up|hear back/.test(t),
    tip: 'Ask "What are the next steps, and when will I hear back?"',
  });
  const got = items.filter((i) => i.ok).length;
  return { items, got, total: items.length };
}

function finish(id) {
  const s = sessions.get(id);
  if (!s) throw new PracticeError('That practice call ended. Start a new one.', 404);
  s.done = true;
  const r = score(s);
  return { checklist: r.items, got: r.got, total: r.total, transcript: s.transcript };
}

module.exports = { start, reply, finish, PracticeError, score };
