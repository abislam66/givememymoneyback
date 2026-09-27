// Name-only sign-in, shared by the start page and the dashboard.
// Entering a name creates a Supabase anonymous account for this browser (the name is saved on it).
// The page sends that account's token to our server, which saves analyses and disputes with it.
// "Try an example" uses a random guest id instead: nothing is saved, and it ends with the tab.
// No passwords, no email, and no library: just Supabase's small auth REST API.

(() => {
  'use strict';

  const KEY = 'secondlook-session';
  const GUEST = 'secondlook-guest';
  let cfg = null;

  const read = (store, k) => { try { return JSON.parse(store.getItem(k)); } catch (e) { return null; } };
  const write = (store, k, v) => { try { if (v === null) store.removeItem(k); else store.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

  async function config() {
    if (cfg) return cfg;
    try {
      const res = await fetch('/api/config');
      cfg = res.ok ? await res.json() : { accounts: false };
    } catch (e) { cfg = { accounts: false }; }
    return cfg;
  }

  async function authCall(path, body, token) {
    const c = await config();
    if (!c.accounts) throw new Error('Saving is not set up on this server. You can still try an example.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${c.supabase_url}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: c.supabase_anon_key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((data && (data.msg || data.error_description || data.message)) || `Sign-in failed (error ${res.status}).`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error("We couldn't reach the sign-in service. Check your internet and try again.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function keep(data, name) {
    const s = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: { id: data.user.id, name: name || (data.user.user_metadata && data.user.user_metadata.display_name) || 'Friend' },
    };
    write(localStorage, KEY, s);
    return s;
  }

  const current = () => read(localStorage, KEY);

  async function signIn(name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) throw new Error('Type your name first.');
    const data = await authCall('signup', { data: { display_name: clean } });
    write(sessionStorage, GUEST, null);
    return keep(data, clean);
  }

  // Tokens last an hour; refresh a minute early. If the account is gone, sign out locally.
  let refreshing = null;
  async function fresh() {
    const s = current();
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s;
    if (!refreshing) {
      refreshing = authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
        .then((data) => keep(data, s.user.name))
        .catch((e) => { if (e.status === 400 || e.status === 401) write(localStorage, KEY, null); return null; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function signOut() {
    const s = current();
    write(localStorage, KEY, null);
    if (s) { try { await authCall('logout', {}, s.access_token); } catch (e) { /* already signed out */ } }
  }

  function startGuest() {
    let id = read(sessionStorage, GUEST);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `g${Date.now()}${Math.random().toString(16).slice(2)}`);
      write(sessionStorage, GUEST, id);
    }
    return id;
  }

  // Headers for our own API: the account token, or the guest id, or nothing (public).
  async function headers() {
    const s = await fresh();
    if (s) return { Authorization: `Bearer ${s.access_token}` };
    const g = read(sessionStorage, GUEST);
    return g ? { 'X-SecondLook-Guest': g } : {};
  }

  window.SecondLookAuth = { config, current, fresh, signIn, signOut, startGuest, headers, isGuest: () => !current() && Boolean(read(sessionStorage, GUEST)) };
})();
