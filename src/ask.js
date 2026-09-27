// Ask GiveMeMyMoneyBack (server side). Explains the current result; never creates findings or changes amounts.
// Suggested questions get the deterministic answers from src/askfacts.js (Gemini may reword them, and the
// rewrite is kept only if every number and month still matches). Free-form questions go to Gemini with the
// fact sheet; a reply that adds any number or month not in the fact sheet is dropped.

const { normalize, check } = require('./rules');
const { hasGemini, generate, sameFacts, polish } = require('./gemini');
const A = require('./askfacts');

const MAX_Q = 500;

async function answer({ question, intent, history = [], bill, eob, noAI = false }) {
  const q = String(question || '').trim().slice(0, MAX_Q);
  if (!q && !intent) return { text: 'Type a question first.', source: 'template' };
  const { bill: b, eob: e } = normalize(bill, eob);
  const result = check(b, e);
  const kind = intent || A.intentOf(q);

  // Suggested (or clearly matching) questions: deterministic answer, optionally reworded.
  if (kind) {
    const base = A.answer(kind, result, b, e);
    if (noAI || !hasGemini()) return { text: base, source: 'template', intent: kind };
    const out = await polish(base, {
      instruction: 'Rewrite this answer for a worried patient in plain, friendly English. Keep every bullet and every number. Keep it short.',
    });
    return { text: out.text, source: out.source, intent: kind };
  }

  // Anything else needs Gemini, grounded in the fact sheet.
  if (noAI || !hasGemini()) return { text: A.NOT_SUPPORTED, source: 'template' };
  const sheet = A.factSheet(result, b, e);
  const recent = (Array.isArray(history) ? history : []).slice(-6)
    .map((h) => `${h.role === 'user' ? 'Patient' : 'GiveMeMyMoneyBack'}: ${String(h.text || '').slice(0, 600)}`).join('\n');
  const system = 'You are GiveMeMyMoneyBack, helping a patient understand one medical bill and their insurer\'s explanation of benefits (EOB). '
    + 'Answer ONLY from the FACTS below. Never create new billing problems, never change or compute new amounts, and never overrule the findings. '
    + 'If the FACTS do not answer the question, reply exactly: NOT_IN_DOCUMENTS. '
    + 'Plain English, about a 6th-grade reading level, at most 5 short sentences. No medical or legal advice.';
  const prompt = `FACTS:\n${sheet}\n\n${recent ? `Conversation so far:\n${recent}\n\n` : ''}Patient's question: ${q}`;
  const out = await generate({ system, parts: [{ text: prompt }], temperature: 0.2, maxOutputTokens: 400 });
  if (!out || /NOT_IN_DOCUMENTS/.test(out)) return { text: A.NOT_SUPPORTED, source: 'template' };
  if (!sameFacts(out, sheet)) {
    console.warn('[ask] answer added facts not in the documents; dropped');
    return { text: A.NOT_SUPPORTED, source: 'template' };
  }
  return { text: out.trim(), source: 'gemini' };
}

module.exports = { answer };
