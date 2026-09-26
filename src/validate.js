// Consistency checks for extracted (or hand-typed) bills and EOBs, run BEFORE the rules engine.
// They don't decide what's an error on the bill; they catch reading mistakes ("these numbers don't add up
// the way the document says they should") so the person can fix them on the review screen.
// Shared by the server (src/extract.js), scripts/score-extraction.js and the browser (served as /validate.js).
//
// Each issue: { message, fields: ['bill.lines.2.charge', 'eob.totals.allowed', ...] }
// Field paths: bill.<header>, bill.lines.<i>.<field>, bill.adjustments_total, bill.insurance_payments_total,
// bill.patient_payments_total, bill.previous_balance, bill.amount_due, bill.printed_total_charges,
// eob.<header>, eob.lines.<i>.<field>, eob.totals.<field>

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SecondLookValidate = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const TOL = 0.5;
  const r2 = (x) => Math.round(x * 100) / 100;
  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };
  const sum = (arr, f) => r2((arr || []).reduce((t, x) => t + (num(f(x)) || 0), 0));
  const usd = (n) => `${n < 0 ? '−' : ''}$${Math.abs(r2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
  const isCode = (s) => /^[A-Z0-9]{4,5}$/i.test(String(s || '').trim());

  function lineIssues(lines, side, moneyFields) {
    const issues = [];
    (lines || []).forEach((l, i) => {
      const n = i + 1;
      const label = side === 'bill' ? `Bill line ${n}` : `EOB line ${n}`;
      if (!isDate(l.date)) issues.push({ message: `${label}: the date is missing or not a real date.`, fields: [`${side}.lines.${i}.date`] });
      if (!isCode(l.code)) issues.push({ message: `${label}: the service code should be 5 letters or numbers (like 73610).`, fields: [`${side}.lines.${i}.code`] });
      const u = num(l.units === undefined || l.units === '' ? 1 : l.units);
      if (!(u > 0)) issues.push({ message: `${label}: units should be 1 or more.`, fields: [`${side}.lines.${i}.units`] });
      moneyFields.forEach((f) => {
        const v = num(l[f]);
        if (!Number.isFinite(v) || v < 0) issues.push({ message: `${label}: "${f.replace('_', ' ')}" is missing or not a number.`, fields: [`${side}.lines.${i}.${f}`] });
      });
    });
    return issues;
  }

  function checkBill(bill) {
    const b = bill || {};
    const lines = b.lines || [];
    const issues = [];
    if (!lines.length) issues.push({ message: 'The bill has no service lines. Add at least one.', fields: ['bill.lines'] });
    issues.push(...lineIssues(lines, 'bill', ['charge']));

    const charges = sum(lines, (l) => l.charge);
    const printed = num(b.printed_total_charges);
    if (Number.isFinite(printed) && printed > 0 && Math.abs(printed - charges) > TOL) {
      issues.push({
        message: `The line charges add up to ${usd(charges)}, but the bill prints total charges of ${usd(printed)}. A line may be missing or misread.`,
        fields: ['bill.printed_total_charges', ...lines.map((_, i) => `bill.lines.${i}.charge`)],
      });
    }
    const adj = sum(b.adjustments, (a) => a.amount);
    const ins = sum(b.insurance_payments, (p) => p.amount);
    const pp = sum(b.patient_payments, (p) => p.amount);
    const prev = num(b.previous_balance) || 0;
    const due = num(b.amount_due);
    if (!Number.isFinite(due)) {
      issues.push({ message: 'The amount due is missing.', fields: ['bill.amount_due'] });
    } else {
      const expected = r2(charges - adj - ins - pp + prev);
      if (Math.abs(expected - due) > TOL) {
        issues.push({
          message: `Charges ${usd(charges)} minus adjustments ${usd(adj)}, insurance payments ${usd(ins)} and your payments ${usd(pp)}${prev ? `, plus previous balance ${usd(prev)}` : ''} = ${usd(expected)}, but the bill says ${usd(due)} is due. Please check these numbers.`,
          fields: ['bill.amount_due', 'bill.adjustments_total', 'bill.insurance_payments_total', 'bill.patient_payments_total', 'bill.previous_balance'],
        });
      }
    }
    return issues;
  }

  function checkEob(eob) {
    const e = eob || {};
    const lines = e.lines || [];
    const issues = [];
    if (!lines.length) issues.push({ message: 'The EOB has no service lines. Add at least one.', fields: ['eob.lines'] });
    issues.push(...lineIssues(lines, 'eob', ['billed', 'allowed', 'insurer_paid', 'patient_resp']));
    if (!['in-network', 'out-of-network'].includes(e.network)) issues.push({ message: 'Choose whether the provider was in network or out of network.', fields: ['eob.network'] });
    if (!['emergency', 'office', 'imaging', 'lab', 'therapy'].includes(e.service_type)) issues.push({ message: 'Choose the type of care.', fields: ['eob.service_type'] });

    lines.forEach((l, i) => {
      const billed = num(l.billed); const allowed = num(l.allowed); const paid = num(l.insurer_paid); const resp = num(l.patient_resp);
      if (![billed, allowed, paid, resp].every(Number.isFinite)) return;
      if (allowed - billed > TOL) issues.push({ message: `EOB line ${i + 1}: the allowed amount (${usd(allowed)}) is more than the billed amount (${usd(billed)}).`, fields: [`eob.lines.${i}.allowed`, `eob.lines.${i}.billed`] });
      const denied = allowed === 0 && paid === 0;
      if (!denied && Math.abs(r2(paid + resp) - allowed) > TOL) {
        issues.push({ message: `EOB line ${i + 1}: insurer paid ${usd(paid)} + your share ${usd(resp)} should equal the allowed ${usd(allowed)}.`, fields: [`eob.lines.${i}.allowed`, `eob.lines.${i}.insurer_paid`, `eob.lines.${i}.patient_resp`] });
      }
    });

    const t = e.totals || {};
    const names = { billed: 'billed', allowed: 'allowed', insurer_paid: 'insurer paid', patient_resp: 'patient responsibility' };
    Object.keys(names).forEach((k) => {
      const printed = num(t[k]);
      const s = sum(lines, (l) => l[k]);
      if (!Number.isFinite(printed)) {
        issues.push({ message: `The EOB total for ${names[k]} is missing.`, fields: [`eob.totals.${k}`] });
      } else if (Math.abs(printed - s) > TOL) {
        issues.push({ message: `The EOB lines add up to ${usd(s)} ${names[k]}, but the total says ${usd(printed)}. A line may be missing or misread.`, fields: [`eob.totals.${k}`, ...lines.map((_, i) => `eob.lines.${i}.${k}`)] });
      }
    });
    return issues;
  }

  // Do the two documents look like the same visit?
  function checkPair(bill, eob) {
    const b = (bill && bill.lines) || [];
    const e = (eob && eob.lines) || [];
    if (!b.length || !e.length) return [];
    const codes = new Set(e.map((l) => String(l.code || '').trim()));
    if (!b.some((l) => codes.has(String(l.code || '').trim()))) {
      return [{ message: "The bill and the EOB don't share any service codes. Check that they are for the same visit, and that the codes were read correctly.", fields: [...b.map((_, i) => `bill.lines.${i}.code`), ...e.map((_, i) => `eob.lines.${i}.code`)] }];
    }
    const dates = new Set(e.map((l) => l.date));
    if (!b.some((l) => dates.has(l.date))) {
      return [{ message: "None of the service dates on the bill match the EOB. Check the dates.", fields: [...b.map((_, i) => `bill.lines.${i}.date`), ...e.map((_, i) => `eob.lines.${i}.date`)] }];
    }
    return [];
  }

  function checkAll(bill, eob) {
    return [...checkBill(bill), ...checkEob(eob), ...checkPair(bill, eob)];
  }

  return { checkBill, checkEob, checkPair, checkAll };
}));
