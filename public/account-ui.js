// Your account on the dashboard: name + Sign out in the top bar, and "My analyses" (open or delete a saved result).
// Saving happens on the server with your sign-in token (src/accounts.js). People viewing an example without an
// account see the same page, but nothing is saved for them. Uploaded files are not stored; only the confirmed numbers
// and the rules' results are saved.

(() => {
  'use strict';

  const SL = window.SecondLook;
  const A = window.SecondLookAuth;
  if (!SL || !A) return;
  const { state, api, money, esc, announce, setMsg, shortDate } = SL;
  const $ = (sel) => document.querySelector(sel);

  const me = A.current();
  const signedIn = Boolean(me);
  let items = [];

  const niceTitle = (t) => String(t || '').replace(/(\d{4}-\d{2}-\d{2})/, (d) => shortDate(d));
  const SOURCE = { upload: 'Your papers', manual: 'Typed in', sample: 'Example (fictional)' };
  const STATUS = { draft: 'Dispute started', sent: 'Letter sent', follow_up_due: 'Follow-up due', resolved: 'Resolved' };

  // ---------- top bar ----------
  function renderAccount(confirming) {
    const box = $('#account');
    if (!box) return;
    if (!signedIn) {
      box.className = 'account guest';
      box.innerHTML = `<span class="avatar" aria-hidden="true">?</span>
        <span class="acct-text"><span class="acct-name">Guest</span><span class="acct-sub">Nothing is saved</span></span>
        <a class="chip" href="/">Sign in to save</a>`;
      return;
    }
    const name = me.user.name || 'Friend';
    box.className = 'account';
    if (confirming) {
      box.innerHTML = `<span class="acct-text"><span class="acct-name">Sign out?</span><span class="acct-sub">Your saved analyses can't be opened again after this.</span></span>
        <button type="button" class="chip" id="btn-signout-yes">Yes, sign out</button>
        <button type="button" class="chip" id="btn-signout-no">Stay signed in</button>`;
      $('#btn-signout-no').focus();
      return;
    }
    box.innerHTML = `<span class="avatar" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <span class="acct-text"><span class="acct-name">${esc(name)}</span><span class="acct-sub">Signed in</span></span>
      <button type="button" class="chip" id="btn-signout">Sign out</button>`;
  }

  $('#account').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'btn-signout') renderAccount(true);
    else if (b.id === 'btn-signout-no') { renderAccount(false); $('#btn-signout').focus(); }
    else if (b.id === 'btn-signout-yes') {
      b.disabled = true;
      await A.signOut();
      location.replace('/');
    }
  });

  // ---------- My analyses ----------
  function statusText(a) {
    if (a.confirmed_savings > 0) return `✓ Saved ${money(a.confirmed_savings)}`;
    if (a.dispute_status) return STATUS[a.dispute_status] || a.dispute_status;
    return a.findings ? `Potential savings ${money(a.potential_savings)}` : '✓ No problems found';
  }

  function renderList() {
    const box = $('#mine-list');
    const badge = $('#sn-mine');
    if (!signedIn) {
      $('#mine-sub').textContent = "You're not signed in, so nothing is saved.";
      box.innerHTML = '<p class="hint">Enter your name on the start page to check your own bill and save your analyses and disputes here.</p><div class="row"><a class="btn" href="/">Enter my name</a></div>';
      if (badge) badge.textContent = '';
      return;
    }
    if (badge) badge.textContent = items.length ? `${items.length} saved` : '';
    if (!items.length) {
      box.innerHTML = '<p class="hint">Nothing saved yet. When you analyze your own bill (or track a dispute on an example), it shows up here.</p>';
      return;
    }
    box.innerHTML = `<ol class="mine-items">${items.map((a) => {
      const open = state.analysisId === a.id;
      return `<li class="mine-item${open ? ' is-open' : ''}">
        <div class="mine-main">
          <p class="mine-title">${esc(niceTitle(a.title))}${open ? ' <span class="mine-now">Open now</span>' : ''}</p>
          <p class="mine-meta">${esc(SOURCE[a.source] || 'Saved')} · saved ${esc(shortDate(String(a.created_at).slice(0, 10)))}</p>
        </div>
        <dl class="mine-nums">
          <div><dt>Bill says</dt><dd>${money(a.amount_due)}</dd></div>
          <div><dt>Likely owe</dt><dd>${money(a.likely_owe)}</dd></div>
          <div><dt>Problems</dt><dd>${a.findings}</dd></div>
          <div><dt>Status</dt><dd>${esc(statusText(a))}</dd></div>
        </dl>
        <div class="mine-actions">
          <button type="button" class="btn small" data-open="${a.id}">Open<span class="sr-only"> ${esc(niceTitle(a.title))}</span></button>
          <button type="button" class="btn small ghost" data-del="${a.id}">Delete<span class="sr-only"> ${esc(niceTitle(a.title))}</span></button>
        </div>
      </li>`;
    }).join('')}</ol>`;
  }

  async function refresh() {
    if (!signedIn) { renderList(); return; }
    try {
      items = await api('/api/analyses');
      if ($('#mine-msg').classList.contains('err')) setMsg($('#mine-msg'), '');
    } catch (e) {
      setMsg($('#mine-msg'), e.message, 'err');
    }
    renderList();
  }

  async function openAnalysis(id) {
    setMsg($('#mine-msg'), 'Opening…');
    try {
      const a = await api(`/api/analyses/${id}`);
      await SL.useDocuments({ bill: a.bill, eob: a.eob, title: niceTitle(a.title), analysisId: a.id });
      setMsg($('#mine-msg'), '');
      renderList();
      $('#step-results').scrollIntoView({ block: 'start' });
      const h = $('#result-h');
      announce(`Opened ${niceTitle(a.title)}. ${h ? h.textContent : ''}`);
    } catch (e) {
      setMsg($('#mine-msg'), e.message, 'err');
    }
  }

  async function deleteAnalysis(btn) {
    const id = Number(btn.dataset.del);
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Delete for good?';
      setMsg($('#mine-msg'), 'Press "Delete for good?" again to delete this analysis and its dispute.');
      return;
    }
    btn.disabled = true;
    try {
      await api(`/api/analyses/${id}`, null, { method: 'DELETE' });
      if (state.analysisId === id) state.analysisId = null;
      setMsg($('#mine-msg'), 'Deleted.', 'good');
      announce('Deleted.');
      await refresh();
      if (window.SecondLookRefreshFamily) window.SecondLookRefreshFamily();
    } catch (e) {
      btn.disabled = false;
      setMsg($('#mine-msg'), e.message, 'err');
    }
  }

  $('#mine-list').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.open) openAnalysis(Number(b.dataset.open));
    else if (b.dataset.del) deleteAnalysis(b);
  });

  // Called by the upload review after "Confirm & Analyze". Returns the saved row, { error }, or null for guests.
  async function save({ bill, eob, source, id }) {
    if (!signedIn) return null;
    try {
      const row = id ? await api(`/api/analyses/${id}`, { bill, eob, source }, { method: 'PUT' }) : await api('/api/analyses', { bill, eob, source });
      state.analysisId = row.id;
      if (typeof window.SecondLookAfterRender === 'function') window.SecondLookAfterRender(state);
      refresh();
      return row;
    } catch (e) {
      return { error: `We couldn't save it to My analyses: ${e.message}` };
    }
  }

  window.SecondLookAccount = { save, refresh, signedIn };
  window.SecondLookRefreshAnalyses = refresh;

  renderAccount(false);
  refresh();
})();
