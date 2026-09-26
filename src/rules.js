// SecondLook rules engine. Pure functions, no I/O.
// Code decides what is an error. Every flag carries evidence (bill lines, EOB lines) and arithmetic.

const { CPT } = require('./cpt');

const TOL = 0.5; // dollars

const round2 = (x) => Math.round(x * 100) / 100;
const sum = (arr, f) => round2((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0));

function money(n) {
  const v = round2(Math.abs(n));
  const s = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function niceDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || 'an unknown date');
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// Lowercase the first letter of a description so it reads well mid-sentence ("the ankle X-ray").
function lowerDesc(desc) {
  const d = String(desc || 'service').trim();
  if (/^[A-Z]{2}/.test(d)) return d; // keep acronyms like "ER", "CT", "MRI"
  return d.charAt(0).toLowerCase() + d.slice(1);
}

// Short plain name for a bill line: the known CPT short name, else its own description.
function plainName(line) {
  const c = CPT[String((line && line.code) || '').trim()];
  return c ? c.short : lowerDesc(line && line.description);
}

// Clean up input so bad data can't crash the engine: drop non-object lines, coerce money to numbers,
// give every bill line a unique line_no. Returns copies; the caller's objects are not changed.
function normalize(bill, eob) {
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? round2(n) : 0;
  };
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);
  const txt = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const b = obj(bill);
  const e = obj(eob);
  const seen = new Set();
  // Units (quantity) default to 1. A line's charge is the total for all its units.
  const units = (v) => {
    const n = num(v === undefined || v === null || v === '' ? 1 : v);
    return n > 0 ? n : 1;
  };
  const billLines = list(b.lines).map((l, i) => {
    let no = Number(l.line_no);
    if (!Number.isInteger(no) || no < 1 || seen.has(no)) no = i + 1;
    while (seen.has(no)) no += 1000;
    seen.add(no);
    return { ...l, line_no: no, date: txt(l.date), code: txt(l.code), description: txt(l.description), units: units(l.units), charge: num(l.charge) };
  });
  const eobLines = list(e.lines).map((l) => ({
    ...l, date: txt(l.date), code: txt(l.code), description: txt(l.description), units: units(l.units),
    billed: num(l.billed), allowed: num(l.allowed), insurer_paid: num(l.insurer_paid), patient_resp: num(l.patient_resp),
  }));
  const t = obj(e.totals);
  const tot = (k) => (t[k] !== undefined && t[k] !== null && t[k] !== '' ? num(t[k]) : sum(eobLines, (l) => l[k]));
  return {
    bill: {
      ...b, lines: billLines,
      adjustments: list(b.adjustments).map((a) => ({ ...a, amount: num(a.amount) })),
      insurance_payments: list(b.insurance_payments).map((p) => ({ ...p, amount: num(p.amount) })),
      patient_payments: list(b.patient_payments).map((p) => ({ ...p, amount: num(p.amount) })),
      // A balance carried over from an earlier statement. It's part of amount_due but not checked here.
      previous_balance: Math.max(0, num(b.previous_balance)),
      amount_due: num(b.amount_due),
    },
    eob: {
      ...e, lines: eobLines,
      totals: { billed: tot('billed'), allowed: tot('allowed'), insurer_paid: tot('insurer_paid'), patient_resp: tot('patient_resp') },
    },
  };
}

function check(rawBill, rawEob) {
  const { bill, eob } = normalize(rawBill, rawEob);
  const billLines = bill.lines;
  const eobLines = eob.lines;

  const flags = [];
  const matches = [];
  const unmatched = [];
  const notes = [];
  let n = 0;
  const addFlag = (f) => { n += 1; flags.push({ id: `f${n}-${f.type}`, ...f }); };

  // ---------- 1. match lines by date|code, comparing total units ----------
  // Bill and EOB lines with the same date and code form a group. The EOB's processed units are handed
  // out to the bill lines in order. Units the EOB never processed are extra (duplicate_charge).
  // The same total units split differently across lines (1 line x 2 units vs 2 lines x 1 unit) is fine.
  const keyOf = (l) => `${String(l.date || '').trim()}|${String(l.code || '').trim()}`;
  const eobByKey = new Map();
  eobLines.forEach((l, i) => {
    const k = keyOf(l);
    if (!eobByKey.has(k)) eobByKey.set(k, []);
    eobByKey.get(k).push(i);
  });
  const groups = new Map(); // key -> bill lines, in bill order of first appearance
  billLines.forEach((l) => {
    const k = keyOf(l);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  const used = new Set(); // EOB indexes that processed at least one billed unit

  for (const [k, lines] of groups) {
    const eobIdx = eobByKey.get(k) || [];
    const first = lines[0];

    if (!eobIdx.length) {
      for (const bl of lines) {
        unmatched.push({ line_no: bl.line_no, reason: 'not_on_eob' });
        addFlag({
          type: 'not_submitted_to_insurance',
          title: `Not on your insurer's statement: ${plainName(bl)}`,
          amount: bl.charge,
          explanation: `Line ${bl.line_no}, the ${plainName(bl)} on ${niceDate(bl.date)} for ${money(bl.charge)}, is not on your insurer's statement at all. It looks like it was never sent to insurance. It should go to your insurer before you pay for it.`,
          what_to_ask: `Was line ${bl.line_no} (code ${bl.code}) sent to my insurance? Please submit it to my insurer and hold this charge until they process it.`,
          evidence: { bill_lines: [bl.line_no], eob_lines: [] },
        });
      }
      continue;
    }

    // Hand out EOB units to bill lines in order.
    const pool = eobIdx.map((i) => ({ i, left: eobLines[i].units }));
    const alloc = lines.map((bl) => {
      let need = bl.units;
      const pairs = [];
      for (const p of pool) {
        if (need <= 1e-9) break;
        if (p.left <= 1e-9) continue;
        const take = Math.min(need, p.left);
        p.left = round2(p.left - take);
        need = round2(need - take);
        pairs.push({ i: p.i, units: take });
      }
      const covered = round2(bl.units - need);
      return { bl, pairs, covered, extra: need, perUnit: bl.charge / bl.units };
    });
    const touched = [...new Set(alloc.flatMap((a) => a.pairs.map((p) => p.i)))].sort((a, b) => a - b);
    touched.forEach((i) => used.add(i));
    const usedUnitsOf = (i) => round2(eobLines[i].units - pool.find((p) => p.i === i).left);

    const billUnits = round2(lines.reduce((t, l) => t + l.units, 0));
    const eobUnits = round2(eobIdx.reduce((t, i) => t + eobLines[i].units, 0));
    const extraUnits = round2(alloc.reduce((t, a) => t + a.extra, 0));
    const dupAmount = round2(alloc.reduce((t, a) => t + a.extra * a.perUnit, 0));
    const matchedCharge = round2(alloc.reduce((t, a) => t + a.covered * a.perUnit, 0));
    const eobBilledUsed = round2(touched.reduce((t, i) => t + eobLines[i].billed * (usedUnitsOf(i) / eobLines[i].units), 0));
    const coveredLines = alloc.filter((a) => a.covered > 0).map((a) => a.bl.line_no);
    const unitsMode = lines.some((l) => l.units !== 1) || eobIdx.some((i) => eobLines[i].units !== 1);

    // ---------- 2. charge mismatch (charges for the matched units vs. the EOB's billed amount) ----------
    const diff = round2(matchedCharge - eobBilledUsed);
    const mismatch = diff > TOL;
    for (const a of alloc) {
      for (const p of a.pairs) matches.push({ bill_line_no: a.bl.line_no, eob_index: p.i, status: mismatch ? 'charge_mismatch' : 'ok' });
      if (a.covered <= 0) unmatched.push({ line_no: a.bl.line_no, reason: 'duplicate' });
      else if (a.extra > 0) unmatched.push({ line_no: a.bl.line_no, reason: 'extra_units', extra_units: a.extra });
    }
    if (mismatch) {
      const simple = coveredLines.length === 1 && touched.length === 1 && !unitsMode;
      const bl = alloc.find((a) => a.covered > 0).bl;
      addFlag({
        type: 'charge_mismatch',
        title: `Price is higher than your insurer's record: ${plainName(bl)}`,
        amount: diff,
        explanation: simple
          ? `The bill charges ${money(matchedCharge)} for the ${plainName(bl)} on ${niceDate(bl.date)} (line ${bl.line_no}). Your insurer's statement says the hospital billed ${money(eobBilledUsed)} for it. That is ${money(diff)} more than what was sent to insurance.`
          : `The bill charges ${money(matchedCharge)} for ${fmtUnits(round2(billUnits - extraUnits))} of ${plainName(bl)} on ${niceDate(bl.date)} (${lineList(coveredLines)}). Your insurer's statement says the hospital billed ${money(eobBilledUsed)} for them. That is ${money(diff)} more than what was sent to insurance.`,
        what_to_ask: simple
          ? `Why is line ${bl.line_no} ${money(matchedCharge)} on my bill when my insurer was billed ${money(eobBilledUsed)}? Please correct it to match the claim.`
          : `Why does my bill charge ${money(matchedCharge)} for code ${bl.code} on ${niceDate(bl.date)} when my insurer was billed ${money(eobBilledUsed)}? Please correct it to match the claim.`,
        evidence: { bill_lines: coveredLines, eob_lines: touched },
      });
    }

    // ---------- duplicate charge (more units billed than the EOB processed) ----------
    if (extraUnits > 0 && dupAmount > TOL) {
      const dupLines = alloc.filter((a) => a.covered <= 0).map((a) => a.bl.line_no);
      const firstNo = coveredLines[0];
      const name = plainName(first);
      const details = { mode: unitsMode ? 'units' : 'lines', bill_units: billUnits, eob_units: eobUnits, extra_units: extraUnits, first_line: firstNo, dup_lines: dupLines };
      if (!unitsMode) {
        addFlag({
          type: 'duplicate_charge',
          title: billUnits === 2 ? `Charged twice: ${name}` : `Charged ${times(billUnits)}: ${name}`,
          amount: dupAmount,
          explanation: `You were charged ${times(billUnits)} for the same ${name} on ${niceDate(first.date)} (${lineList(lines.map((l) => l.line_no))}). Your insurer only has it ${times(eobUnits)}.`,
          what_to_ask: `${dupLines.length === 1 ? `Line ${dupLines[0]} looks like a repeat` : `${cap(lineList(dupLines))} look like repeats`} of line ${firstNo} (code ${first.code} on ${niceDate(first.date)}). Can you remove the extra ${money(dupAmount)} ${dupLines.length === 1 ? 'charge' : 'in charges'}?`,
          evidence: { bill_lines: lines.map((l) => l.line_no), eob_lines: touched },
          details,
        });
      } else {
        addFlag({
          type: 'duplicate_charge',
          title: `Billed for extra units: ${name}`,
          amount: dupAmount,
          explanation: `You were billed for ${fmtUnits(billUnits)} of ${name} on ${niceDate(first.date)} (${lineList(lines.map((l) => l.line_no))}). Your insurer processed ${fmtUnits(eobUnits)}. The extra ${fmtUnits(extraUnits)} ${extraUnits === 1 ? 'costs' : 'cost'} ${money(dupAmount)}.`,
          what_to_ask: `My insurer processed ${fmtUnits(eobUnits)} of code ${first.code} on ${niceDate(first.date)}, but my bill has ${fmtUnits(billUnits)}. Can you remove the extra ${fmtUnits(extraUnits)} (${money(dupAmount)})?`,
          evidence: { bill_lines: lines.map((l) => l.line_no), eob_lines: touched },
          details,
        });
      }
    }
  }

  const matchedEob = [...used].sort((a, b) => a - b);
  const unusedEob = eobLines.map((_, i) => i).filter((i) => !used.has(i));
  if (unusedEob.length) {
    notes.push(`Your insurer's statement lists ${unusedEob.length === 1 ? 'a service' : `${unusedEob.length} services`} not on the bill (EOB line ${unusedEob.map((i) => i + 1).join(', ')}). That can be fine, but it is worth asking about.`);
  }

  // ---------- 3. missing insurance payment ----------
  const eobPaid = eob.totals.insurer_paid;
  const billPaid = sum(bill.insurance_payments, (p) => p.amount);
  const missingPay = round2(eobPaid - billPaid);
  if (missingPay > TOL) {
    addFlag({
      type: 'missing_insurance_payment',
      title: 'Insurance payment not applied',
      amount: missingPay,
      explanation: billPaid > 0
        ? `Your insurer says it paid ${money(eobPaid)} on claim ${eob.claim_number || '(no number)'}. The bill only shows ${money(billPaid)} from insurance. The other ${money(missingPay)} is missing from the bill.`
        : `Your insurer says it paid ${money(eobPaid)} on claim ${eob.claim_number || '(no number)'}. The bill does not show any insurance payment. That ${money(missingPay)} should come off what you owe.`,
      what_to_ask: `My insurer paid ${money(eobPaid)} on claim ${eob.claim_number || '(no number)'}. Can you apply the missing ${money(missingPay)} to my account?`,
      evidence: { bill_lines: [], eob_lines: eobLines.map((_, i) => i).filter((i) => Number(eobLines[i].insurer_paid) > 0), bill_sections: ['insurance_payments'] },
    });
  }

  // ---------- 4. contractual adjustment ----------
  // What the provider must write off: billed minus what the insurer and the patient pay. For a normal line
  // that equals billed - allowed. For a denied line (allowed $0, patient owes the full charge) it is $0.
  const expectedAdj = sum(matchedEob, (i) => eobLines[i].billed - eobLines[i].insurer_paid - eobLines[i].patient_resp);
  const billAdj = sum(bill.adjustments, (a) => a.amount);
  const shortfall = round2(expectedAdj - billAdj);
  const oon = eob.network === 'out-of-network';
  const emergency = eob.service_type === 'emergency';
  if (shortfall > TOL) {
    if (oon && emergency) {
      addFlag({
        type: 'surprise_bill_nsa',
        title: 'Surprise bill: emergency care is protected',
        amount: shortfall,
        explanation: `This was emergency care from a hospital outside your insurance network. A federal law called the No Surprises Act says you only pay what you would pay in network. Your insurer applied in-network prices, so ${money(expectedAdj)} should be taken off. The bill takes off ${money(billAdj)}. That leaves ${money(shortfall)} you should not be asked to pay.`,
        what_to_ask: `This was emergency care, so the No Surprises Act protects me from balance billing. Please remove the ${money(shortfall)} above my in-network cost sharing.`,
        evidence: { bill_lines: [], eob_lines: matchedEob, bill_sections: ['adjustments'] },
      });
    } else if (!oon) {
      addFlag({
        type: 'adjustment_missing',
        title: 'In-network discount missing',
        amount: shortfall,
        explanation: `This provider is in your insurance network, so it agreed to lower prices. Your insurer's statement shows ${money(expectedAdj)} should be taken off (the billed amount minus what your insurer and you pay). The bill only takes off ${money(billAdj)}. The other ${money(shortfall)} is missing.`,
        what_to_ask: `You're in my insurance network. Can you apply the full contractual adjustment of ${money(expectedAdj)}? My bill only shows ${money(billAdj)}.`,
        evidence: { bill_lines: [], eob_lines: matchedEob, bill_sections: ['adjustments'] },
      });
    } else {
      notes.push(`This provider is out of your network and this was not an emergency, so they may be allowed to bill you for more than your insurer allowed (called balance billing). The bill takes off ${money(shortfall)} less than your insurer's allowed prices would. Ask for an itemized explanation of that ${money(shortfall)}.`);
    }
  }

  // ---------- 5. owed, pending, potential savings ----------
  const amountDue = round2(Number(bill.amount_due) || 0);
  const previous = bill.previous_balance;
  const patientPaid = sum(bill.patient_payments, (p) => p.amount);
  const likelyOwe = Math.max(0, round2(sum(matchedEob, (i) => eobLines[i].patient_resp) - patientPaid));
  const pending = sum(billLines.filter((l) => unmatched.some((u) => u.line_no === l.line_no && u.reason === 'not_on_eob')), (l) => l.charge);
  const potential = Math.max(0, round2(amountDue - previous - likelyOwe - pending));

  // ---------- 6. math, step by step ----------
  const math = [{ label: 'The bill says you owe', amount: amountDue }];
  let running = amountDue;
  if (previous > 0) {
    // Set aside before reconciling: this visit is checked, the older balance is not.
    math.push({ label: 'Minus the balance carried over from an earlier bill (not checked here)', amount: -previous });
    running = round2(running - previous);
  }
  for (const f of flags) {
    math.push({ label: `Minus ${mathLabel(f, billLines)}`, amount: -f.amount });
    running = round2(running - f.amount);
  }
  const leftover = round2(running - likelyOwe);
  if (Math.abs(leftover) > TOL) {
    const higher = leftover > 0;
    addFlag({
      type: 'unexplained_difference',
      title: higher ? "A difference we can't explain" : 'The bill is lower than expected',
      amount: round2(Math.abs(leftover)),
      explanation: higher
        ? `After taking out the problems above, the bill is still ${money(leftover)} more than your insurer says you owe (${money(likelyOwe)}). We could not match this to a specific line. Ask the billing office to explain it.`
        : `After taking out the problems above, the bill is ${money(-leftover)} less than your insurer says you owe (${money(likelyOwe)}). You may get another bill later. Ask the billing office if more is coming.`,
      what_to_ask: higher
        ? `My balance is ${money(leftover)} higher than my insurer's statement explains. Can you send an itemized bill and explain the difference?`
        : `My insurer says I owe ${money(likelyOwe)}, but my bill shows less. Will I get another bill?`,
      evidence: { bill_lines: [], eob_lines: [], bill_sections: ['amount_due'] },
    });
    math.push({ label: higher ? 'Minus a difference we cannot explain' : 'Plus an amount the bill has not charged yet', amount: -leftover });
    running = round2(running - leftover);
  }
  math.push({ label: previous > 0 ? "What you likely owe for this visit (matches your insurer's statement)" : "What you likely owe (matches your insurer's statement)", amount: running });

  if (pending > TOL) {
    notes.push(`${money(pending)} on this bill has not gone through insurance yet. You may owe some of it later, after your insurer reviews it.`);
  }
  if (patientPaid > 0) {
    notes.push(`You already paid ${money(patientPaid)}. That payment is counted.`);
  }
  if (previous > 0) {
    notes.push(`${money(previous)} carried over from an earlier bill; not checked here.`);
  }

  return {
    flags,
    matches,
    unmatched_bill_lines: unmatched,
    summary: { amount_due: amountDue, previous_balance: previous, likely_owe: likelyOwe, pending_amount: pending, potential_savings: potential },
    math,
    notes,
  };
}

const TIMES = { 1: 'once', 2: 'twice' };
function times(n) { return TIMES[n] || `${n} times`; }
function fmtUnits(n) { return `${n} ${n === 1 ? 'unit' : 'units'}`; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function lineList(nos) {
  if (nos.length === 1) return `line ${nos[0]}`;
  return `lines ${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]}`;
}

function mathLabel(f, billLines) {
  const line = (no) => billLines.find((l) => l.line_no === no);
  switch (f.type) {
    case 'duplicate_charge': {
      const l = line(f.evidence.bill_lines[0]);
      if (f.details && f.details.mode === 'units') return `extra ${fmtUnits(f.details.extra_units)} of ${plainName(l)}`;
      return `duplicate ${plainName(l)}`;
    }
    case 'not_submitted_to_insurance': {
      const l = line(f.evidence.bill_lines[0]);
      return `${plainName(l)} not sent to insurance yet`;
    }
    case 'charge_mismatch': {
      const l = line(f.evidence.bill_lines[0]);
      return `overcharge on ${plainName(l)}`;
    }
    case 'missing_insurance_payment': return 'insurance payment not applied';
    case 'adjustment_missing': return 'in-network discount not applied';
    case 'surprise_bill_nsa': return 'surprise bill protection (No Surprises Act)';
    default: return f.title.toLowerCase();
  }
}

module.exports = { check, normalize, money, niceDate, lowerDesc, plainName, round2, fmtUnits, lineList };
