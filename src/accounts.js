// Who is asking, and where their data lives.
// - Signed in (a name on the landing page): a Supabase anonymous account. The page sends its access token;
//   we check it with Supabase and read/write rows *with that token*, so row-level security keeps every
//   user's analyses and disputes private. The service role key is never used.
// - Guest ("Try an example"): a random id per browser tab. Kept in server memory only, never saved.
// - No header (the /classic/ page): the shared in-memory store, as before.
// Uploaded files never come here; only the numbers the person confirmed and the rules' results.

// Accept the project URL as Supabase shows it in different places: with or without /rest/v1 or /auth/v1.
const URL_ = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, '');
const KEY = () => process.env.SUPABASE_ANON_KEY || '';
const hasAccounts = () => Boolean(URL_() && KEY());
const TIMEOUT = 10000;

class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function call(path, { method = 'GET', token, body, prefer } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${URL_()}${path}`, {
      method,
      headers: {
        apikey: KEY(),
        Authorization: `Bearer ${token || KEY()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 401 || res.status === 403) throw new AccountError('Your sign-in has expired. Please go back to the start page and enter your name again.', 401);
    if (!res.ok) {
      console.warn(`[accounts] ${method} ${path.split('?')[0]} -> ${res.status} ${(data && (data.message || data.msg)) || ''}`);
      throw new AccountError("We couldn't reach your saved analyses right now. Please try again.", 503);
    }
    return data;
  } catch (e) {
    if (e instanceof AccountError) throw e;
    console.warn('[accounts]', e.name === 'AbortError' ? 'timed out' : e.message);
    throw new AccountError("We couldn't reach your saved analyses right now. Please try again.", 503);
  } finally {
    clearTimeout(timer);
  }
}

// Token -> user, cached briefly so every request doesn't ask Supabase again.
const seen = new Map();
async function userFor(token) {
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const u = await call('/auth/v1/user', { token });
  const user = { id: u.id, name: String((u.user_metadata && u.user_metadata.display_name) || '').slice(0, 60) };
  if (seen.size > 500) seen.clear();
  seen.set(token, { user, until: Date.now() + 5 * 60 * 1000 });
  return user;
}

// Returns { kind: 'user'|'guest'|'public', owner, token?, user? }.
async function whoIs(req) {
  const auth = req.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (m) {
    if (!hasAccounts()) throw new AccountError('Saving is not set up on this server.', 503);
    const user = await userFor(m[1]);
    return { kind: 'user', owner: `user:${user.id}`, token: m[1], user };
  }
  const guest = req.get('X-SecondLook-Guest') || '';
  if (/^[A-Za-z0-9-]{8,64}$/.test(guest)) return { kind: 'guest', owner: `guest:${guest}` };
  return { kind: 'public', owner: 'public' };
}

// ---------- analyses ----------
const SUMMARY_COLS = 'id,title,source,amount_due,likely_owe,potential_savings,created_at';

function analysisRow({ title, source, bill, eob, result }) {
  const s = result.summary;
  return { title, source, bill, eob, result: { flags: result.flags, math: result.math, summary: s, notes: result.notes },
    amount_due: s.amount_due, likely_owe: s.likely_owe, potential_savings: s.potential_savings };
}

async function listAnalyses(who) {
  const rows = await call(`/rest/v1/analyses?select=${SUMMARY_COLS},result->flags&order=created_at.desc&limit=100`, { token: who.token });
  return rows.map((r) => ({ id: r.id, title: r.title, source: r.source, amount_due: Number(r.amount_due), likely_owe: Number(r.likely_owe),
    potential_savings: Number(r.potential_savings), findings: Array.isArray(r.flags) ? r.flags.length : 0, created_at: r.created_at }));
}

async function getAnalysis(who, id) {
  const rows = await call(`/rest/v1/analyses?select=*&id=eq.${Number(id)}`, { token: who.token });
  if (!rows.length) throw new AccountError("We couldn't find that saved analysis.", 404);
  return rows[0];
}

async function saveAnalysis(who, fields) {
  const rows = await call(`/rest/v1/analyses?select=${SUMMARY_COLS}`, { method: 'POST', token: who.token, body: analysisRow(fields), prefer: 'return=representation' });
  return rows[0];
}

async function updateAnalysis(who, id, fields) {
  const rows = await call(`/rest/v1/analyses?id=eq.${Number(id)}&select=${SUMMARY_COLS}`, { method: 'PATCH', token: who.token, body: analysisRow(fields), prefer: 'return=representation' });
  if (!rows.length) throw new AccountError("We couldn't find that saved analysis.", 404);
  return rows[0];
}

async function deleteAnalysis(who, id) {
  await call(`/rest/v1/analyses?id=eq.${Number(id)}`, { method: 'DELETE', token: who.token }); // disputes go with it (on delete cascade)
}

// ---------- disputes ----------
// The dispute record lives in src/disputes.js while a request runs. For signed-in users it is saved here after
// every change and re-read from the database on every request, so several server copies (serverless hosting)
// or a restart never act on an old copy.

const dbId = (disputeId) => Number(String(disputeId).replace(/^S/, ''));

async function loadDisputes(who, adopt, forgetOwner) {
  const rows = await call('/rest/v1/disputes?select=id,analysis_id,data&order=id.asc', { token: who.token });
  forgetOwner(who.owner);
  rows.forEach((r) => adopt({ ...r.data, id: `S${r.id}`, analysis_id: r.analysis_id, owner: who.owner }));
}

function disputeRow(d) {
  const { owner, ...data } = d; // eslint-disable-line no-unused-vars
  return { status: d.status, potential_savings: d.potential_savings, confirmed_savings: d.confirmed_savings,
    resolved_amount: d.resolved_amount, data, updated_at: new Date().toISOString() };
}

async function insertDispute(who, analysisId, d) {
  const rows = await call('/rest/v1/disputes?select=id', { method: 'POST', token: who.token, prefer: 'return=representation',
    body: { analysis_id: analysisId, ...disputeRow(d) } });
  return `S${rows[0].id}`;
}

async function saveDispute(who, d) {
  await call(`/rest/v1/disputes?id=eq.${dbId(d.id)}`, { method: 'PATCH', token: who.token, body: disputeRow(d) });
}

module.exports = {
  hasAccounts, whoIs, AccountError,
  listAnalyses, getAnalysis, saveAnalysis, updateAnalysis, deleteAnalysis,
  loadDisputes, insertDispute, saveDispute,
  config: () => (hasAccounts() ? { accounts: true, supabase_url: URL_(), supabase_anon_key: KEY() } : { accounts: false }),
};
