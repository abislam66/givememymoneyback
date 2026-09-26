// Deterministic templates: dispute letter, follow-up letter, call script.
// Every fact comes from the bill, the EOB and the verified flags from rules.js.

const { money, plainName, fmtUnits } = require('./rules');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '[date]');
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

const sum = (arr, f) => Math.round((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0) * 100) / 100;
const lineByNo = (bill, no) => (bill.lines || []).find((l) => l.line_no === no);

// One numbered paragraph per flag, with dates, codes and amounts.
function flagLines(flags, bill, eob) {
  const claim = eob.claim_number || '[claim number]';
  const insurer = eob.insurer || 'My insurer';
  return flags.map((f, i) => {
    const n = `${i + 1}.`;
    const ev = f.evidence || {};
    switch (f.type) {
      case 'duplicate_charge': {
        const d = f.details || {};
        if (d.mode === 'units') {
          const l = lineByNo(bill, ev.bill_lines[0]) || {};
          const where = ev.bill_lines.length === 1 ? `Line ${l.line_no}` : `Lines ${ev.bill_lines.join(', ')}`;
          return `${n} Extra units billed. ${where}, code ${l.code} (${l.description}), ${longDate(l.date)}: the bill charges for ${fmtUnits(d.bill_units)}. My EOB for claim ${claim} shows my insurer processed ${fmtUnits(d.eob_units)}. The extra ${fmtUnits(d.extra_units)} is ${money(f.amount)}.`;
        }
        const dups = d.dup_lines && d.dup_lines.length ? d.dup_lines : [ev.bill_lines[ev.bill_lines.length - 1]];
        const first = d.first_line || ev.bill_lines[0];
        const l = lineByNo(bill, dups[0]) || {};
        const once = d.eob_units > 1 ? `${d.eob_units} times` : 'only once';
        return dups.length === 1
          ? `${n} Duplicate charge. Line ${dups[0]}, code ${l.code} (${l.description}), ${longDate(l.date)}, ${money(f.amount)}. This is the same service as line ${first}. My EOB for claim ${claim} lists it ${once}.`
          : `${n} Duplicate charges. Lines ${dups.join(', ')}, code ${l.code} (${l.description}), ${longDate(l.date)}, ${money(f.amount)} in total. These repeat line ${first}. My EOB for claim ${claim} lists it ${once}.`;
      }
      case 'not_submitted_to_insurance': {
        const l = lineByNo(bill, ev.bill_lines[0]) || {};
        return `${n} Charge not sent to insurance. Line ${l.line_no}, code ${l.code} (${l.description}), ${longDate(l.date)}, ${money(f.amount)}. This service does not appear on my EOB for claim ${claim}. Please submit it to ${insurer === 'My insurer' ? 'my insurer' : insurer} before billing me for it.`;
      }
      case 'charge_mismatch': {
        const l = lineByNo(bill, ev.bill_lines[0]) || {};
        const e = (eob.lines || [])[ev.eob_lines[0]] || {};
        return `${n} Charge does not match the claim. Line ${l.line_no}, code ${l.code} (${l.description}), ${longDate(l.date)}, is billed to me at ${money(l.charge)}. Your claim to my insurer (claim ${claim}) lists it at ${money(e.billed)}. The difference is ${money(f.amount)}.`;
      }
      case 'missing_insurance_payment': {
        const paid = eob.totals ? eob.totals.insurer_paid : sum(eob.lines, (x) => x.insurer_paid);
        const shown = sum(bill.insurance_payments, (p) => p.amount);
        return `${n} Insurance payment not applied. ${insurer} paid ${money(paid)} on claim ${claim}. The bill shows ${money(shown)} in insurance payments. ${money(f.amount)} is missing from my account.`;
      }
      case 'adjustment_missing': {
        const shown = sum(bill.adjustments, (a) => a.amount);
        return `${n} In-network discount not applied. You are in network with ${insurer}. Based on my EOB, the contractual adjustment should be ${money(shown + f.amount)}. The bill shows ${money(shown)}. ${money(f.amount)} is missing.`;
      }
      case 'surprise_bill_nsa': {
        const shown = sum(bill.adjustments, (a) => a.amount);
        return `${n} Balance billing for emergency care. This was emergency care. Under the federal No Surprises Act, I can only be billed my in-network cost sharing, even though your facility is out of network. My EOB applies in-network cost sharing, which means ${money(shown + f.amount)} should be taken off. The bill takes off ${money(shown)}. I am disputing the extra ${money(f.amount)}.`;
      }
      case 'unexplained_difference':
        return `${n} Unexplained balance. After the items above, my balance is still ${money(f.amount)} different from what my EOB says I owe. Please explain this amount in writing.`;
      default:
        return `${n} ${f.title}: ${money(f.amount)}.`;
    }
  });
}

function buildLetter(bill, eob, result, { date } = {}) {
  bill = bill || {}; eob = eob || {};
  const flags = (result && result.flags) || [];
  const s = (result && result.summary) || {};
  const prov = bill.provider || {};
  const patient = (bill.patient && bill.patient.name) || '[Your name]';
  const claim = eob.claim_number || '[claim number]';

  const out = [];
  out.push(patient, '[Your street address]', '[City, State ZIP]', '[Phone number]', '');
  out.push(longDate(date || todayIso()), '');
  out.push(prov.name || '[Provider name]', 'Attn: Billing Department', prov.address || '[Provider address]', '');
  out.push(`Re: Billing dispute for account ${bill.account_number || '[account number]'}`);
  out.push(`Patient: ${patient}`);
  out.push(`Statement date: ${longDate(bill.statement_date)}`);
  out.push(`Insurance: ${eob.insurer || '[insurer]'}, member ID ${(eob.member && eob.member.id) || '[member ID]'}, claim ${claim}`, '');
  out.push('Dear Billing Department,', '');

  if (!flags.length) {
    out.push(`I compared my bill with my insurer's explanation of benefits (EOB) for claim ${claim}. Please send me a fully itemized bill so I can confirm the charges.`, '');
  } else {
    out.push(`I am writing to dispute charges on the bill above. I compared the bill with my insurer's explanation of benefits (EOB) for claim ${claim} and found ${flags.length === 1 ? 'this problem' : 'these problems'}:`, '');
    flagLines(flags, bill, eob).forEach((p) => out.push(p, ''));
    let owe = s.previous_balance > 0
      ? `The bill says I owe ${money(s.amount_due)}. That includes ${money(s.previous_balance)} carried over from an earlier bill, which this letter does not dispute. Based on my EOB, my share for this visit is ${money(s.likely_owe)}.`
      : `The bill says I owe ${money(s.amount_due)}. Based on my EOB, my share is ${money(s.likely_owe)}.`;
    if (s.pending_amount > 0) owe += ` Another ${money(s.pending_amount)} has not been processed by my insurer yet.`;
    out.push(owe, '');
  }

  out.push('Please:');
  out.push('- Correct these errors and send me a corrected, itemized bill.');
  out.push('- Place my account on hold, and do not send it to collections, while this dispute is open.');
  out.push('- Reply to me in writing within 30 days.', '');
  out.push('I have enclosed copies of the bill and the EOB. Thank you for your help.', '');
  out.push('Sincerely,', '', patient);
  return out.join('\n');
}

// dispute: record from disputes.js (has bill, eob, flags, sent_date, amounts)
function buildFollowUpLetter(dispute, { date } = {}) {
  const bill = dispute.bill || {};
  const eob = dispute.eob || {};
  const prov = bill.provider || {};
  const patient = (bill.patient && bill.patient.name) || '[Your name]';
  const claim = eob.claim_number || '[claim number]';
  const out = [];
  out.push(patient, '[Your street address]', '[City, State ZIP]', '[Phone number]', '');
  out.push(longDate(date || todayIso()), '');
  out.push(prov.name || '[Provider name]', 'Attn: Billing Department', prov.address || '[Provider address]', '');
  out.push(`Re: SECOND REQUEST. Billing dispute for account ${bill.account_number || '[account number]'}, claim ${claim}`, '');
  out.push('Dear Billing Department,', '');
  out.push(`On ${longDate(dispute.sent_date)}, I sent you a letter disputing charges on this account. I have not received a corrected bill or a written answer. The problems I reported were:`, '');
  flagLines(dispute.flags || [], bill, eob).forEach((p) => out.push(p, ''));
  out.push(dispute.previous_balance > 0
    ? `The bill says I owe ${money(dispute.amount_due)}, including ${money(dispute.previous_balance)} carried over from an earlier bill that I am not disputing here. Based on my EOB, my share for this visit is ${money(dispute.likely_owe)}.`
    : `The bill says I owe ${money(dispute.amount_due)}. Based on my EOB, my share is ${money(dispute.likely_owe)}.`, '');
  out.push('Please send me a corrected, itemized bill within 15 days. Please confirm in writing that my account is on hold and will not be sent to collections while this dispute is open.', '');
  out.push(`If I do not hear back, I will ask for a billing supervisor, file a complaint with ${eob.insurer || 'my insurer'}, and contact my state insurance department.`, '');
  out.push('Sincerely,', '', patient);
  return out.join('\n');
}

function ordinal(i) { return ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'][i] || 'Also'; }

function buildCallScript(result, bill, eob) {
  bill = bill || {}; eob = eob || {};
  const flags = (result && result.flags) || [];
  const s = (result && result.summary) || {};
  const patient = (bill.patient && bill.patient.name) || '[your name]';
  const lines = [];
  lines.push(`Hi, my name is ${patient}. I'm calling about account ${bill.account_number || '[account number]'}, for the bill dated ${longDate(bill.statement_date)}.`);
  if (!flags.length) {
    lines.push(`I'd like a fully itemized bill so I can check it against my insurer's statement for claim ${eob.claim_number || '[claim number]'}.`);
  } else {
    lines.push(`I compared the bill to my insurance statement, claim ${eob.claim_number || '[claim number]'}, and I'm disputing ${flags.length === 1 ? 'one item' : `${flags.length} items`}.`);
    flags.forEach((f, i) => {
      const ev = f.evidence || {};
      const l = lineByNo(bill, (ev.bill_lines || [])[(ev.bill_lines || []).length - 1]) || {};
      let say;
      switch (f.type) {
        case 'duplicate_charge': {
          const d = f.details || {};
          const first = lineByNo(bill, ev.bill_lines[0]) || {};
          if (d.mode === 'units') say = `the ${plainName(first)} on ${longDate(first.date)}, line ${first.line_no}. I was billed for ${fmtUnits(d.bill_units)}, but my insurer processed ${fmtUnits(d.eob_units)}. That's ${money(f.amount)} extra.`;
          else say = `line ${l.line_no}, a duplicate ${plainName(l)} on ${longDate(l.date)} for ${money(f.amount)}. It's the same as line ${d.first_line || ev.bill_lines[0]}, and my insurer only has it ${d.eob_units > 1 ? `${d.eob_units} times` : 'once'}.`;
          break;
        }
        case 'not_submitted_to_insurance': say = `line ${l.line_no}, the ${plainName(l)} on ${longDate(l.date)} for ${money(f.amount)}. It isn't on my insurance statement. Can you send it to my insurance?`; break;
        case 'charge_mismatch': say = `line ${l.line_no}, the ${plainName(l)}. It's ${money(f.amount)} higher on my bill than what you billed my insurer.`; break;
        case 'missing_insurance_payment': say = `a missing insurance payment. ${eob.insurer || 'My insurer'} paid on this claim, but ${money(f.amount)} of it isn't on my bill.`; break;
        case 'adjustment_missing': say = `the in-network discount. ${money(f.amount)} of the contractual adjustment is missing.`; break;
        case 'surprise_bill_nsa': say = `a surprise bill. This was emergency care, so under the No Surprises Act I should only pay in-network cost sharing. That's ${money(f.amount)} too much.`; break;
        default: say = `a balance of ${money(f.amount)} that my insurance statement doesn't explain.`;
      }
      lines.push(`${ordinal(i)}, ${say}`);
    });
    lines.push(`My insurance statement says I owe ${money(s.likely_owe)}, not ${money(s.amount_due)}.`);
  }
  lines.push('Can you send me a corrected, itemized bill?');
  lines.push('Can you put my account on hold so it does not go to collections while this is reviewed?');
  lines.push('What are the next steps, and when should I hear back?');
  lines.push("Can I get your name and a reference number for this call?");
  return lines.join('\n');
}

module.exports = { buildLetter, buildFollowUpLetter, buildCallScript, longDate };
