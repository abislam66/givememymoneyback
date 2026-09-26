// Ask SecondLook: deterministic answers built only from the current bill, EOB and rules result.
// Runs on the server (src/ask.js) and in the browser (served as /askfacts.js), so the suggested
// questions and the Alt+R summary work offline and in demo mode. It never creates findings or amounts.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SecondLookAsk = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const r2 = (x) => Math.round(x * 100) / 100;
  function money(n) {
    const v = Math.abs(r2(Number(n) || 0));
    const s = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (Number(n) < -0.004 ? 'minus $' : '$') + s;
  }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function longDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : (iso || 'an unknown date');
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const clean = (t) => String(t || '').replace(/−\$/g, 'minus $');

  const SUGGESTED = [
    { id: 'flagged', question: 'Why was this charge flagged?' },
    { id: 'owe', question: 'How did you calculate what I likely owe?' },
    { id: 'ask', question: 'What should I ask the billing department?' },
    { id: 'eob', question: 'Explain my EOB simply.' },
  ];

  // Maps a typed question to one of the suggested answers when it clearly asks the same thing.
  function intentOf(question) {
    const q = String(question || '').toLowerCase();
    if (/\b(flag|flagged|wrong|error|mistake|problem|issue|duplicate|twice|missing|not applied|overcharg|why .*(charge|payment))/.test(q)) return 'flagged';
    if (/\b(owe|calculat|math|how much|likely|total)/.test(q)) return 'owe';
    if (/\b(ask|say|call|billing (department|office)|what should i|dispute)/.test(q)) return 'ask';
    if (/\b(eob|explanation of benefits|insurer|insurance statement|allowed|explain)/.test(q)) return 'eob';
    return null;
  }

  function flagged(result) {
    const flags = result.flags || [];
    if (!flags.length) return "Nothing was flagged. Every line on your bill matches your insurer's statement, and the totals add up.";
    const lines = flags.map((f) => `• ${f.title} (${money(f.amount)}): ${f.explanation}`);
    return [`We flagged ${plural(flags.length, 'problem')}. Each one comes from a fixed rule that compares your bill with your insurer's statement:`, ...lines].join('\n');
  }

  function owe(result) {
    const s = result.summary || {};
    const steps = (result.math || []).map((m) => `• ${m.label}: ${money(m.amount)}`);
    const parts = ['Here is the math, step by step:', ...steps, `So you likely owe ${money(s.likely_owe)} for this visit.`];
    if (s.previous_balance > 0) parts.push(`Your bill also carries ${money(s.previous_balance)} from an earlier bill. We did not check that part.`);
    if (s.pending_amount > 0) parts.push(`${money(s.pending_amount)} should go to your insurer first before you pay it.`);
    (result.notes || []).forEach((n) => parts.push(clean(n)));
    return parts.join('\n');
  }

  function ask(result) {
    const flags = result.flags || [];
    if (!flags.length) return 'Your bill matches your insurer\'s statement, so there is nothing to dispute. You can still ask the billing office for an itemized bill.';
    return [
      'When you call or write to the billing office, ask:',
      ...flags.map((f) => `• ${f.what_to_ask}`),
      '• Can you send me a corrected, itemized bill?',
      '• Can you pause my account while you review this, so it does not go to collections?',
      'Write down the name of the person you talk to and the date.',
    ].join('\n');
  }

  function eobText(eob) {
    const e = eob || {};
    const t = e.totals || {};
    const parts = [`Your EOB (explanation of benefits) is from ${e.insurer || 'your insurer'}. It is not a bill. It shows what your plan did with each service.`];
    if (e.network) parts.push(e.network === 'in-network' ? 'The provider is in your network, so your plan\'s discounted prices apply.' : `The provider is ${e.network}.`);
    (e.lines || []).forEach((l) => {
      const what = `${l.description || `Service ${l.code}`} on ${longDate(l.date)}`;
      if (Number(l.allowed) === 0 && Number(l.insurer_paid) === 0) {
        parts.push(`• ${what}: billed ${money(l.billed)}. Your plan did not cover it, so your share is ${money(l.patient_resp)}.`);
      } else {
        parts.push(`• ${what}: billed ${money(l.billed)}. Your plan allows ${money(l.allowed)}. Your insurer paid ${money(l.insurer_paid)}, and your share is ${money(l.patient_resp)}.`);
      }
    });
    if (t.billed !== undefined) parts.push(`In total: billed ${money(t.billed)}, allowed ${money(t.allowed)}, insurer paid ${money(t.insurer_paid)}, your share ${money(t.patient_resp)}.`);
    return parts.join('\n');
  }

  function answer(intent, result, bill, eob) {
    if (!result) return null;
    if (intent === 'flagged') return flagged(result);
    if (intent === 'owe') return owe(result);
    if (intent === 'ask') return ask(result);
    if (intent === 'eob') return eobText(eob);
    return null;
  }

  // Everything the assistant is allowed to use. Gemini sees this; its reply must not add any number or month.
  function factSheet(result, bill, eob) {
    const b = bill || {};
    const s = (result && result.summary) || {};
    const parts = [];
    parts.push(`Provider: ${(b.provider && b.provider.name) || 'unknown'}. Patient: ${(b.patient && b.patient.name) || 'unknown'}. Account: ${b.account_number || 'unknown'}.`);
    parts.push('Bill lines:');
    (b.lines || []).forEach((l, i) => parts.push(`  Line ${i + 1}: ${l.description || ''}, code ${l.code}, ${longDate(l.date)}, ${plural(l.units || 1, 'unit')}, charge ${money(l.charge)}.`));
    parts.push(`Bill amount due: ${money(s.amount_due)}.`);
    parts.push(eobText(eob));
    parts.push(`Claim number: ${(eob && eob.claim_number) || 'unknown'}.`);
    parts.push('Findings from the rules (the only problems that exist):');
    parts.push(flagged(result));
    parts.push(owe(result));
    parts.push(`Potential savings (not yet saved): ${money(s.potential_savings)}.`);
    parts.push(ask(result));
    return parts.join('\n');
  }

  // Alt+R: only the vital numbers and one short line per problem.
  function vitalSummary(result) {
    if (!result || !result.summary) return '';
    const s = result.summary;
    const flags = result.flags || [];
    const parts = [`The bill says ${money(s.amount_due)}. You likely owe ${money(s.likely_owe)}.`];
    if (!flags.length) parts.push('We found no problems.');
    else {
      parts.push(`We found ${plural(flags.length, 'problem')}.`);
      flags.forEach((f) => parts.push(`${f.title}: ${money(f.amount)}.`));
      parts.push(`Potential savings: ${money(s.potential_savings)}. This is not saved yet.`);
    }
    return parts.join(' ');
  }

  const NOT_SUPPORTED = "I can't find that in your bill, your insurance statement, or our results, so I can't answer it. Try one of the suggested questions, or ask the billing office.";

  return { SUGGESTED, intentOf, answer, factSheet, vitalSummary, money, NOT_SUPPORTED };
}));
