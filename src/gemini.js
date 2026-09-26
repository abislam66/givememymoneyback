// Shared Gemini REST helper. Every call has a 20-second timeout.
// generate()/chat() return text, or null on any failure, so callers fall back to their templates.
// generateDetailed() also says *why* it failed, with a message that names the configured model.
// The API key goes in a header (never in a URL) and is scrubbed from anything we log.

const TIMEOUT_MS = 20000;
const DEFAULT_MODEL = 'gemini-2.5-flash';

function config() {
  return {
    key: (process.env.GEMINI_API_KEY || '').trim(),
    // GEMINI_MODEL decides which model reads documents and writes text. We never switch models on our own.
    model: (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim(),
  };
}

function hasGemini() { return Boolean(config().key); }

let lastError = null; // most recent configuration-type error, for /api/status

// Remove the key from any text before it is logged or shown.
function scrub(text) {
  const { key } = config();
  let s = String(text === undefined || text === null ? '' : text);
  if (key) s = s.split(key).join('[GEMINI_API_KEY]');
  return s.replace(/key=[A-Za-z0-9_-]{20,}/g, 'key=[hidden]').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[hidden key]');
}

// Turn an HTTP failure into a kind + a clear developer-facing message naming the configured model.
function classify(status, bodyText, model) {
  let apiStatus = '';
  let apiMsg = '';
  try {
    const j = JSON.parse(bodyText);
    apiStatus = (j.error && j.error.status) || '';
    apiMsg = (j.error && j.error.message) || '';
  } catch (e) { apiMsg = bodyText || ''; }
  const detail = scrub(apiMsg).slice(0, 200);
  const m = `"${model}"`;
  const lower = `${apiStatus} ${apiMsg}`.toLowerCase();

  if (status === 400 && /api key not valid|api_key_invalid|invalid api key/.test(lower)) {
    return { kind: 'bad_key', message: 'The Gemini API key was rejected. Check GEMINI_API_KEY in .env.', detail };
  }
  if (status === 404 || apiStatus === 'NOT_FOUND' || /is not found|not supported for generatecontent|unknown model/.test(lower)) {
    return { kind: 'model_not_found', message: `Gemini model ${m} was not found or doesn't support this request. Check GEMINI_MODEL in .env and set it to a current multimodal Gemini model that your API key can use.`, detail };
  }
  if (status === 403 || apiStatus === 'PERMISSION_DENIED') {
    return { kind: 'permission', message: `Your Gemini API key doesn't have permission to use model ${m}. Check GEMINI_MODEL in .env, or the key's access in Google AI Studio.`, detail };
  }
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    return { kind: 'rate_limited', message: `Gemini rate limit or quota reached for model ${m}. Wait a minute and try again.`, detail };
  }
  if (status === 503 || apiStatus === 'UNAVAILABLE') {
    return { kind: 'unavailable', message: `Gemini model ${m} is unavailable right now. Try again shortly, and if it keeps failing, check GEMINI_MODEL in .env.`, detail };
  }
  if (status === 400) {
    return { kind: 'bad_request', message: `Gemini model ${m} rejected the request (${detail || 'invalid argument'}). If this model can't read images or PDFs, set GEMINI_MODEL in .env to a multimodal model.`, detail };
  }
  return { kind: 'http', message: `Gemini returned an error (HTTP ${status}) for model ${m}.`, detail };
}

function endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

// Low-level call. Returns { text } or { error: { kind, message, status?, detail? } }. Never throws.
async function call(body) {
  const { key, model } = config();
  if (!key) return { error: { kind: 'no_key', message: 'No Gemini API key is set (GEMINI_API_KEY).' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const err = { status: res.status, ...classify(res.status, bodyText, model) };
      if (['model_not_found', 'permission', 'bad_key', 'unavailable', 'bad_request'].includes(err.kind)) lastError = err.message;
      console.warn(`[gemini] ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
      return { error: err };
    }
    const data = await res.json();
    const cand = (data.candidates || [])[0] || {};
    const out = ((cand.content || {}).parts || []).map((p) => p.text || '').join('').trim();
    if (!out) {
      const why = cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || 'no text';
      const err = { kind: 'empty', message: `Gemini model "${model}" returned no answer (${why}).` };
      console.warn(`[gemini] ${err.message}`);
      return { error: err };
    }
    lastError = null;
    return { text: out };
  } catch (e) {
    const err = e.name === 'AbortError'
      ? { kind: 'timeout', message: `Gemini model "${model}" didn't answer within 20 seconds.` }
      : { kind: 'network', message: `Couldn't reach Gemini: ${scrub(e.message)}.` };
    console.warn(`[gemini] ${err.message}`);
    return { error: err };
  } finally {
    clearTimeout(timer);
  }
}

function buildBody({ system, parts, contents, json, schema, temperature, maxOutputTokens }) {
  const body = {
    contents: contents || [{ role: 'user', parts }],
    generationConfig: {
      temperature, maxOutputTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
      ...(json && schema ? { responseSchema: schema } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

// generateDetailed({ system, parts, json, schema, temperature }) -> { text } | { error }
// parts: Gemini parts, e.g. [{ text }] or [{ inline_data: { mime_type, data } }, { text }]
async function generateDetailed({ system, parts, json = false, schema = null, temperature = 0.4, maxOutputTokens = 2048 }) {
  return call(buildBody({ system, parts, json, schema, temperature, maxOutputTokens }));
}

async function generate(opts) {
  const r = await generateDetailed(opts);
  return r.text || null;
}

// chat({ system, history: [{ role: 'user'|'model', text }] }) -> text | null
async function chat({ system, history, temperature = 0.6, maxOutputTokens = 400 }) {
  const contents = history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
  const r = await call(buildBody({ system, contents, temperature, maxOutputTokens }));
  return r.text || null;
}

// ---------- verification of AI text against the deterministic version ----------
const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

// Numbers ("$1,240.00" -> "1240"), codes and IDs ("CLM-771045213" -> "771045213"), and month names.
function facts(text) {
  const s = String(text || '');
  const nums = (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((t) => {
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? String(n) : t;
  });
  const months = (s.match(MONTH_RE) || []).map((m) => m.toLowerCase());
  return { nums, months };
}

// True if every number, code, date and month in `aiText` also appears in `trustedText`.
function sameFacts(aiText, trustedText) {
  if (!aiText) return false;
  const a = facts(aiText);
  const t = facts(trustedText);
  const nums = new Set(t.nums);
  const months = new Set(t.months);
  return a.nums.every((n) => nums.has(n)) && a.months.every((m) => months.has(m));
}

// Ask Gemini to reword `trustedText`; return the rewrite only if its facts match, else the original.
async function polish(trustedText, { instruction, context = '' } = {}) {
  if (!hasGemini()) return { text: trustedText, source: 'template' };
  const system = 'You rewrite text about a medical bill for a patient. Use plain English at about a 6th-grade reading level. '
    + 'Do not add any new numbers, dates, codes, names or facts. Every number in your answer must appear in the original. '
    + 'Do not decide whether something is an error; the original already says so. Reply with the rewritten text only.';
  const prompt = `${instruction || 'Rewrite this to be friendlier and easier to read. Keep it about the same length.'}\n\n`
    + (context ? `Background (for reference only):\n${context}\n\n` : '')
    + `Original:\n${trustedText}`;
  const out = await generate({ system, parts: [{ text: prompt }], temperature: 0.3 });
  if (out && sameFacts(out, trustedText)) return { text: out, source: 'gemini' };
  if (out) console.warn('[gemini] rewrite changed facts; using the template');
  return { text: trustedText, source: 'template' };
}

module.exports = {
  generate, generateDetailed, chat, hasGemini, sameFacts, polish, config, scrub,
  lastError: () => lastError, DEFAULT_MODEL, classify,
};
