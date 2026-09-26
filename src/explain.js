// Explains billing terms and findings. Deterministic glossary first; Gemini may only reword it,
// and any rewrite whose numbers, dates or codes differ is thrown away.

const { CPT } = require('./cpt');
const { money, niceDate } = require('./rules');
const { polish } = require('./gemini');

const GLOSSARY = {
  'eob': {
    title: 'EOB (explanation of benefits)',
    text: "A statement from your insurance company about a visit. It lists what the provider charged, what your insurer agreed to pay, and what part is yours to pay. It is not a bill. It is the best way to check if your bill is right.",
  },
  'allowed amount': {
    title: 'Allowed amount',
    text: 'The most your insurance plan says a service is worth. In-network providers agreed to accept this price. Your share and the insurer\'s payment are both taken from this number, not from the full charge.',
  },
  'contractual adjustment': {
    title: 'Contractual adjustment',
    text: 'The discount an in-network provider must take off the bill. It is the full charge minus the allowed amount. If it is missing or too small, you may be asked to pay money you don\'t owe.',
  },
  'patient responsibility': {
    title: 'Patient responsibility',
    text: 'The part of the allowed amount that you have to pay. It can include your deductible, copay and coinsurance. This is usually what you really owe.',
  },
  'deductible': {
    title: 'Deductible',
    text: 'The amount you pay each year for covered care before your insurance starts to share the cost. For example, with a $1,000 deductible, you pay the first $1,000 of covered care.',
  },
  'coinsurance': {
    title: 'Coinsurance',
    text: 'Your share of the cost as a percent. For example, 20% coinsurance on a $100 allowed amount means you pay $20 and insurance pays $80.',
  },
  'copay': {
    title: 'Copay',
    text: 'A set amount you pay for a type of care, like $30 for a doctor visit or $150 for an ER visit. It is the same no matter what the visit costs.',
  },
  'in-network': {
    title: 'In-network',
    text: 'A provider that has a deal with your insurance company. They agreed to lower prices, so you usually pay less.',
  },
  'out-of-network': {
    title: 'Out-of-network',
    text: 'A provider that has no deal with your insurance company. You may pay more. But for emergency care, the No Surprises Act limits what you pay to in-network amounts.',
  },
  'balance billing': {
    title: 'Balance billing',
    text: 'When a provider bills you for the difference between their full charge and what your insurance allowed. In-network providers are not allowed to do this. For emergency care, out-of-network providers usually are not allowed to either.',
  },
  'cpt code': {
    title: 'CPT code',
    text: 'A five-digit code that names each medical service, like 73610 for an ankle X-ray. The bill and your EOB use the same codes, which is how SecondLook lines them up.',
  },
  'no surprises act': {
    title: 'No Surprises Act',
    text: 'A federal law from 2022. It protects you from surprise bills for emergency care, and for some care at in-network hospitals by out-of-network doctors. In those cases you only pay your normal in-network share.',
  },
  'itemized bill': {
    title: 'Itemized bill',
    text: 'A bill that lists every single service, with its date, code and price. You have the right to ask for one. It makes errors much easier to find.',
  },
  'billed amount': {
    title: 'Billed amount',
    text: 'The full price the provider charged before any insurance discount. Most people never pay this full price.',
  },
  'insurer paid': {
    title: 'Insurer paid',
    text: 'How much your insurance company paid the provider. This payment should show up on your bill as a credit.',
  },
  'amount due': {
    title: 'Amount due',
    text: 'What the bill says you owe right now. It should equal the charges, minus the discount, minus what insurance paid, minus what you already paid.',
  },
  'units': {
    title: 'Units',
    text: 'How many of a service you got. Some services are counted in blocks of time. For example, 2 units of therapy exercise can mean two 15-minute blocks. The bill and your EOB should have the same total number of units.',
  },
  'claim number': {
    title: 'Claim number',
    text: 'The number your insurer gave to this visit. Use it when you call or write, so everyone looks at the same record.',
  },
  'insurance payment': {
    title: 'Insurance payment',
    text: 'Money your insurance company sent to the provider. It lowers what you owe.',
  },
};

const ALIASES = {
  'explanation of benefits': 'eob', 'allowed': 'allowed amount', 'adjustment': 'contractual adjustment',
  'contractual adjustments': 'contractual adjustment', 'patient resp': 'patient responsibility', 'your share': 'patient responsibility',
  'you pay': 'patient responsibility', 'in network': 'in-network', 'out of network': 'out-of-network', 'cpt': 'cpt code',
  'nsa': 'no surprises act', 'billed': 'billed amount', 'charge': 'billed amount', 'insurer_paid': 'insurer paid', 'paid by insurer': 'insurer paid',
  'amount_due': 'amount due', 'balance': 'amount due', 'insurance payments': 'insurance payment', 'itemized': 'itemized bill',
  'patient_resp': 'patient responsibility',
};

function normTerm(term) {
  return String(term || '').toLowerCase().replace(/[“”"'.?!:]/g, '').replace(/\s+/g, ' ').trim();
}

// Facts about this term taken from the user's own documents.
function fromDocuments(key, { bill, eob } = {}) {
  if (!bill || !eob) return '';
  const sum = (arr, f) => Math.round((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0) * 100) / 100;
  const t = eob.totals || {};
  switch (key) {
    case 'contractual adjustment': return `On this bill, the adjustment is ${money(sum(bill.adjustments, (a) => a.amount))}.`;
    case 'allowed amount': return Number.isFinite(t.allowed) ? `On your EOB, the total allowed amount is ${money(t.allowed)}.` : '';
    case 'patient responsibility': return Number.isFinite(t.patient_resp) ? `Your EOB says your share is ${money(t.patient_resp)}.` : '';
    case 'insurer paid': return Number.isFinite(t.insurer_paid) ? `Your EOB says ${eob.insurer || 'your insurer'} paid ${money(t.insurer_paid)}.` : '';
    case 'insurance payment': return `This bill shows ${money(sum(bill.insurance_payments, (p) => p.amount))} in insurance payments.`;
    case 'amount due': return `This bill says ${money(bill.amount_due)}.`;
    case 'claim number': return eob.claim_number ? `Your claim number is ${eob.claim_number}.` : '';
    case 'in-network': case 'out-of-network': return eob.network ? `Your EOB says this provider is ${eob.network}.` : '';
    default: return '';
  }
}

function explainTerm(term, context = {}) {
  const raw = String(term || '').trim();
  const code = (raw.match(/\b\d{5}\b/) || [])[0];
  if (code && CPT[code]) {
    return { title: `${code}: ${CPT[code].name}`, text: `${CPT[code].explain} (CPT code ${code}.)`, found: true };
  }
  let key = normTerm(raw);
  key = ALIASES[key] || key;
  const g = GLOSSARY[key];
  if (!g) {
    return { title: raw || 'Unknown term', text: "Sorry, we don't have an explanation for that term yet. You can ask the billing office or your insurer to explain it.", found: false };
  }
  const extra = fromDocuments(key, context);
  return { title: g.title, text: extra ? `${g.text} ${extra}` : g.text, found: true };
}

// Mention units only when there is more than one, so simple lines read the same as before.
function unitText(l) { return Number(l.units) > 1 ? `, ${l.units} units` : ''; }

function quoteBillLine(l) {
  return `Bill line ${l.line_no}: ${niceDate(l.date)}, code ${l.code}, "${l.description}"${unitText(l)}, ${money(l.charge)}.`;
}
function quoteEobLine(l, i) {
  return `Insurer statement line ${i + 1}: ${niceDate(l.date)}, code ${l.code}, "${l.description}"${unitText(l)}, billed ${money(l.billed)}, allowed ${money(l.allowed)}, insurer paid ${money(l.insurer_paid)}, your share ${money(l.patient_resp)}.`;
}

// Deterministic explanation that quotes the exact lines behind a verified flag.
function explainFinding(flag, bill, eob) {
  const ev = flag.evidence || {};
  const parts = [flag.explanation];
  const billLines = (ev.bill_lines || []).map((no) => (bill.lines || []).find((l) => l.line_no === no)).filter(Boolean);
  const eobLines = (ev.eob_lines || []).map((i) => [(eob.lines || [])[i], i]).filter(([l]) => l);
  if (billLines.length || eobLines.length) parts.push('\nHere are the exact lines:');
  billLines.forEach((l) => parts.push(`- ${quoteBillLine(l)}`));
  if (flag.type === 'duplicate_charge' && eobLines.length && eobLines.length <= 3) eobLines.forEach(([l, i]) => parts.push(`- ${quoteEobLine(l, i)}`));
  else if (eobLines.length <= 3) eobLines.forEach(([l, i]) => parts.push(`- ${quoteEobLine(l, i)}`));
  else parts.push(`- Insurer statement lines ${eobLines.map(([, i]) => i + 1).join(', ')}.`);

  const sections = ev.bill_sections || [];
  const sum = (arr, f) => Math.round((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0) * 100) / 100;
  if (sections.includes('insurance_payments')) parts.push(`- Bill, insurance payments: ${money(sum(bill.insurance_payments, (p) => p.amount))}. Insurer statement, total insurer paid: ${money((eob.totals || {}).insurer_paid)}.`);
  if (sections.includes('adjustments')) parts.push(`- Bill, adjustments: ${money(sum(bill.adjustments, (a) => a.amount))}. Insurer statement, billed minus what the insurer and you pay: ${money(sum(ev.eob_lines || [], (i) => { const l = eob.lines[i] || {}; return (l.billed || 0) - (l.insurer_paid || 0) - (l.patient_resp || 0); }))}.`);
  parts.push(`\nWhat to ask: ${flag.what_to_ask}`);
  return parts.join('\n');
}

// ---------- optional Gemini layer ----------
async function explainTermSmart(term, context) {
  const base = explainTerm(term, context);
  if (!base.found) return { title: base.title, text: base.text, source: 'glossary' };
  const r = await polish(base.text, {
    instruction: `Explain the billing term "${base.title}" to a patient in 2 to 4 short sentences. Use only the facts in the original.`,
  });
  return { title: base.title, text: r.text, source: r.source === 'gemini' ? 'gemini' : 'glossary' };
}

async function explainFindingSmart(flag, bill, eob) {
  const base = explainFinding(flag, bill, eob);
  const r = await polish(base, {
    instruction: 'Rewrite this finding for a worried patient. Keep the list of exact lines and the "What to ask" line. Keep every number, date and code exactly the same.',
  });
  return { title: flag.title, text: r.text, source: r.source === 'gemini' ? 'gemini' : 'glossary' };
}

module.exports = { explainTerm, explainFinding, explainTermSmart, explainFindingSmart, GLOSSARY };
