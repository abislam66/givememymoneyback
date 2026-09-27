// Spoken-language option: translate text that is about to be read aloud into Spanish.
// Presentation only: the rules, the results and the documents stay in English. A translation is used only if
// every dollar amount, number, date, code, ID and name in the English text comes through exactly and nothing
// new is added; otherwise the English is kept.
const { generate, hasGemini } = require('./gemini');

const LANGS = { es: 'Spanish' };
// Month words only in dates ("Sep 6", "September 6"), so the verb "may" isn't mistaken for a month.
const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b(?=\.?\s+\d)/gi;
const cache = new Map(); // `${lang}|${text}` -> translated text (in memory; the same answer isn't translated twice)

const nums = (s) => (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => t.replace(/,/g, '')).sort();
// Exact tokens that must survive untouched: money, codes/IDs/dates with digits, and month words.
const exact = (s) => [...(s.match(/\$\s?\d[\d,]*(?:\.\d+)?|[A-Za-z0-9]*\d[A-Za-z0-9./-]*/g) || []), ...(s.match(MONTH_RE) || [])];

// Returns null when the translation is safe, or a short reason when it must be rejected.
function problem(original, translated, keep = []) {
  if (!translated || !translated.trim()) return 'empty';
  const a = nums(original); const b = nums(translated);
  if (a.join('|') !== b.join('|')) return 'numbers changed';
  const missing = exact(original).find((t) => !translated.includes(t.replace(/\.$/, '')));
  if (missing) return `"${missing}" changed`;
  const name = keep.find((k) => k && original.includes(k) && !translated.includes(k));
  if (name) return `"${name}" changed`;
  return null;
}

// -> { text, lang, translated: bool, note }
async function forVoice(text, lang, keep = []) {
  if (!LANGS[lang]) return { text, lang: 'en', translated: false };
  const key = `${lang}|${text}`;
  if (cache.has(key)) return { text: cache.get(key), lang, translated: true };
  if (!hasGemini()) return { text, lang: 'en', translated: false, note: 'no-translator' };
  const system = `You translate short explanations about a medical bill from English into ${LANGS[lang]} so they can be read aloud to a patient. `
    + 'Use simple, everyday words. Translate the meaning only; do not add, remove, soften or change any fact. '
    + 'Copy these EXACTLY as written in the English, character for character: every dollar amount (like $1,240.00), every number, '
    + 'every date (keep English month names and digits), every claim number, account number, procedure code and ID, '
    + 'and every name of a person, hospital, provider or insurance company. Use Western digits 0-9 only. '
    + 'Reply with the translation only.';
  const keepLine = keep.filter(Boolean).length ? `\nNames that must stay exactly the same: ${keep.filter(Boolean).join('; ')}\n` : '';
  const out = await generate({ system, parts: [{ text: `${keepLine}\nEnglish:\n${text}` }], temperature: 0 });
  const why = problem(text, out || '', keep);
  if (why) {
    console.warn(`[translate] ${LANGS[lang]} rejected (${why}); keeping English`);
    return { text, lang: 'en', translated: false, note: 'rejected' };
  }
  const clean = out.trim();
  if (cache.size > 300) cache.clear();
  cache.set(key, clean);
  return { text: clean, lang, translated: true };
}

module.exports = { forVoice, problem, LANGS };
