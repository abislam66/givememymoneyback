// Dispute tracker and call practice UI. Uses the helpers app.js exposes on window.SecondLook.
// All amounts shown here come from the server's dispute record; nothing is computed from AI text.

(() => {
  'use strict';

  const SL = window.SecondLook;
  if (!SL) return;
  const { state, api, money, esc, speak, stopSpeaking, announce, setMsg, shortDate } = SL;
  const $ = (sel) => document.querySelector(sel);

  const disputes = new Map(); // id -> record
  let uploadDisputeId = null;
  let lastKey = null;

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function currentDispute() {
    if (state.analysisId) {
      const saved = [...disputes.values()].filter((d) => d.analysis_id === state.analysisId);
      return saved.find((d) => d.status !== 'resolved') || saved[saved.length - 1] || null;
    }
    if (!state.caseId) return uploadDisputeId ? disputes.get(uploadDisputeId) : null;
    const mine = [...disputes.values()].filter((d) => d.case_id === state.caseId);
    return mine.find((d) => d.status !== 'resolved') || mine[mine.length - 1] || null;
  }

  // ---------- dispute tracker ----------
  const STEPS = [
    { key: 'draft', name: 'Draft' },
    { key: 'sent', name: 'Letter sent' },
    { key: 'follow_up_due', name: 'Follow-up due' },
    { key: 'resolved', name: 'Resolved' },
  ];

  function stepper(d) {
    const at = STEPS.findIndex((s) => s.key === d.status);
    return `<ol class="steps" aria-label="Dispute progress">${STEPS.map((s, i) => {
      const done = i < at || d.status === 'resolved';
      const now = i === at;
      const label = now ? (d.status === 'resolved' ? 'Done' : 'Now') : (done ? 'Done' : 'Not yet');
      return `<li class="${done ? 'done' : ''}"${now ? ' aria-current="step"' : ''}><span class="step-name">${i + 1}. ${esc(s.name)}</span><span class="step-state">${now && d.status !== 'resolved' ? '▶ ' : (done ? '✓ ' : '')}${label}</span></li>`;
    }).join('')}</ol>`;
  }

  // Once a dispute is resolved, the summary card up top shows the confirmed amount next to the potential one.
  function updateHeroTile(d) {
    const old = document.getElementById('tile-confirmed');
    if (old) old.remove();
    if (!d || d.status !== 'resolved') return;
    document.getElementById('tiles').insertAdjacentHTML('beforeend',
      `<div class="tile saved" id="tile-confirmed"><span class="k">Confirmed savings</span><span class="v">${money(d.confirmed_savings)}</span><span class="s">Saved. Dispute resolved.</span></div>`);
  }

  function renderDispute() {
    const box = $('#dispute-box');
    const d = currentDispute();
    updateHeroTile(d);
    const r = state.result;
    if (!r) { box.innerHTML = ''; return; }

    if (!d) {
      box.innerHTML = r.flags.length
        ? `<p>We found ${r.flags.length} ${r.flags.length === 1 ? 'problem' : 'problems'} worth disputing. Tracking starts a record with the verified findings and your letter.</p>
           <div class="row"><button type="button" id="btn-track" class="btn">Track this dispute</button></div>`
        : '<p>There is nothing to dispute on this bill. It matches your insurer\'s statement.</p>';
      return;
    }

    const saved = d.status === 'resolved';
    const facts = [
      ['Who', d.profile_name || 'You'], ['Provider', d.provider], ['Account', d.account_number], ['Claim', d.claim_number],
      ['Bill said', money(d.amount_due)], ['Your insurer says you owe', money(d.likely_owe)], ['Amount disputed', money(d.disputed_amount)],
      ['Findings', String(d.flags.length)],
    ];
    if (d.sent_date) facts.push(['Letter sent', shortDate(d.sent_date)]);
    if (d.follow_up_date) facts.push(['Follow up by', shortDate(d.follow_up_date)]);
    if (d.sent_date) facts.push(["Today (simulated)", shortDate(d.today)]);

    const parts = [];
    parts.push(stepper(d));
    if (saved) {
      parts.push(`<p class="saved-banner" tabindex="-1">Saved ${money(d.confirmed_savings)}</p>
        <p>The provider corrected the balance from ${money(d.amount_due)} to ${money(d.resolved_amount)} on ${esc(shortDate(d.resolved_date))}.</p>`);
    }
    parts.push(`<div class="savings">
      <div class="saving potential"><span class="k">Potential savings</span><span class="v">${money(d.potential_savings)}</span><span class="s">${saved ? 'What the checks found. Shown for reference, never added to savings.' : 'Found by the checks. Potential, not yet saved.'}</span></div>
      <div class="saving confirmed${saved ? ' is-saved' : ''}"><span class="k">Confirmed savings</span><span class="v">${money(d.confirmed_savings)}</span><span class="s">${saved ? 'Saved. The provider lowered your bill.' : 'Counts only after the dispute is resolved.'}</span></div>
    </div>`);
    parts.push(`<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`);

    if (d.status === 'draft') {
      parts.push(`<div class="sub-panel"><h4>Next: send your letter</h4>
        <p>Mail or email the dispute letter above to the billing office. Then mark it as sent, so we know when to follow up.</p>
        <div class="inline-form">
          <div class="field"><label for="sent-date">Date you sent it</label><input type="date" id="sent-date" value="${todayIso()}"></div>
          <button type="button" id="btn-sent" class="btn">Mark as sent</button>
        </div></div>`);
    }
    if (d.status === 'sent') {
      parts.push(`<div class="sub-panel"><h4>Waiting for an answer</h4>
        <p>Most billing offices answer within 30 days. If you don't hear back by ${esc(shortDate(d.follow_up_date))}, GiveMeMyMoneyBack drafts a follow-up.</p>
        <div class="row"><button type="button" id="btn-advance" class="btn ghost">Simulate 30 days passing</button></div></div>`);
    }
    if (d.status === 'follow_up_due' || (saved && d.follow_up_letter)) {
      parts.push(`<div class="sub-panel"><h4>No answer after 30 days: your follow-up letter</h4>
        <p class="hint">${d.follow_up_source === 'gemini' ? 'Wording polished by Gemini. Every number, date and code was checked against your original findings.' : 'Built from your verified findings only.'}</p>
        <label for="followup-text" class="sr-only">Follow-up letter</label>
        <textarea id="followup-text" class="doc-text" rows="14">${esc(d.follow_up_letter || '')}</textarea>
        <div class="row"><button type="button" id="btn-copy-followup" class="btn ghost">Copy follow-up letter</button></div>
        <h4>If there is still no answer</h4>
        <ol class="escalation">${(d.escalation || []).map((e) => `<li><b>${esc(e.step)}</b>${esc(e.detail)}</li>`).join('')}</ol></div>`);
    }
    if (d.status === 'sent' || d.status === 'follow_up_due') {
      parts.push(`<div class="sub-panel"><h4>Got an answer?</h4>
        <p>Enter the amount the provider now says you owe. We'll count the difference as saved.</p>
        <div class="inline-form">
          <div class="field"><label for="resolve-amount">New amount you owe ($)</label><input type="number" id="resolve-amount" min="0" step="0.01" value="${d.likely_owe}"></div>
          <button type="button" id="btn-resolve" class="btn">Resolve dispute</button>
        </div></div>`);
    }
    parts.push(`<details><summary>Dispute history</summary><ul class="history">${d.history.map((h) => `<li>${esc(shortDate(h.date))}: ${esc(h.note)}</li>`).join('')}</ul></details>`);
    box.innerHTML = parts.join('');
  }

  async function act(fn, focusSel, doneText) {
    const msg = $('#dispute-msg');
    setMsg(msg, 'Working…');
    try {
      const d = await fn();
      disputes.set(d.id, d);
      if (!d.case_id) uploadDisputeId = d.id;
      if (!d.case_id && d.analysis_id) state.analysisId = d.analysis_id;
      renderDispute();
      if (window.SecondLookRefreshFamily) window.SecondLookRefreshFamily();
      if (window.SecondLookRefreshAnalyses) window.SecondLookRefreshAnalyses();
      setMsg(msg, doneText(d), 'good');
      announce(doneText(d));
      const f = focusSel && $(focusSel);
      if (f) f.focus();
    } catch (e) {
      setMsg(msg, e.message, 'err');
    }
  }

  function onDisputeClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const d = currentDispute();
    if (b.id === 'btn-track') {
      act(async () => {
        const out = await api('/api/disputes', { case_id: state.caseId, analysis_id: state.analysisId, profile: state.profile, bill: state.bill, eob: state.eob });
        return out.dispute;
      }, '#btn-sent', (x) => `Tracking dispute ${x.id} for ${money(x.disputed_amount)}.`);
    } else if (b.id === 'btn-sent' && d) {
      act(() => api(`/api/disputes/${d.id}/send`, { date: $('#sent-date').value }), '#btn-advance', (x) => `Marked as sent on ${shortDate(x.sent_date)}. Follow up by ${shortDate(x.follow_up_date)}.`);
    } else if (b.id === 'btn-advance' && d) {
      b.disabled = true;
      act(() => api(`/api/disputes/${d.id}/advance`, {}), '#followup-text', () => '30 days passed with no answer. Your follow-up letter is ready.');
    } else if (b.id === 'btn-resolve' && d) {
      act(() => api(`/api/disputes/${d.id}/resolve`, { amount: $('#resolve-amount').value }), '#dispute-section .saved-banner', (x) => `Resolved. Saved ${money(x.confirmed_savings)}.`);
    } else if (b.id === 'btn-copy-followup') {
      const ta = $('#followup-text');
      navigator.clipboard.writeText(ta.value)
        .then(() => setMsg($('#dispute-msg'), 'Follow-up letter copied.', 'good'))
        .catch(() => { ta.focus(); ta.select(); setMsg($('#dispute-msg'), 'The letter is selected. Press Ctrl+C (or Cmd+C) to copy it.'); });
    }
  }

  // ---------- call practice ----------
  // The main page replaced this with Ask GiveMeMyMoneyBack; /classic/ still has it. Everything below is a no-op without it.
  const hasPractice = Boolean(document.getElementById('btn-practice-start'));
  let session = null;

  function resetPractice() {
    session = null;
    if (!hasPractice) return;
    $('#transcript').innerHTML = '';
    $('#checklist').innerHTML = '';
    $('#practice-form').hidden = true;
    setMsg($('#practice-msg'), '');
    setMsg($('#turn-count'), '');
    setMsg($('#practice-mode'), '');
  }

  function addLine(role, text) {
    const li = document.createElement('li');
    li.className = role;
    li.innerHTML = `<span class="who">${role === 'rep' ? 'Jordan, billing rep' : 'You'}</span><span>${esc(text)}</span>`;
    $('#transcript').appendChild(li);
    if (role === 'rep' && $('#practice-voice').checked) speak(text);
  }

  function updateTurns() {
    if (!session) return;
    setMsg($('#turn-count'), session.done ? 'The rep ended the call. Press "Finish and score my call".' : `Rep turn ${session.turn} of ${session.max_turns}`);
  }

  async function startPractice() {
    stopSpeaking();
    resetPractice();
    const msg = $('#practice-msg');
    try {
      const s = await api('/api/practice/start', { bill: state.bill, eob: state.eob, case_id: state.caseId });
      session = { id: s.id, turn: s.turn, max_turns: s.max_turns, done: false };
      setMsg($('#practice-mode'), s.mode === 'gemini' ? 'AI rep (Gemini), limited to your verified findings.' : 'Scripted rep (no AI key needed).');
      addLine('rep', s.rep);
      $('#practice-form').hidden = false;
      $('#btn-practice-say').disabled = false;
      $('#practice-input').disabled = false;
      $('#practice-input').focus();
      updateTurns();
    } catch (e) {
      setMsg(msg, e.message, 'err');
    }
  }

  async function sayIt(e) {
    e.preventDefault();
    if (!session) return;
    const input = $('#practice-input');
    const text = input.value.trim();
    if (!text) { setMsg($('#practice-msg'), 'Type what you would say first.', 'err'); return; }
    addLine('you', text);
    input.value = '';
    $('#btn-practice-say').disabled = true;
    setMsg($('#practice-msg'), 'The rep is answering…');
    try {
      const r = await api(`/api/practice/${session.id}/reply`, { text }, { timeout: 30000 });
      session.turn = r.turn;
      session.done = r.done;
      addLine('rep', r.rep);
      setMsg($('#practice-msg'), '');
      if (r.done) {
        input.disabled = true;
        $('#btn-practice-finish').focus();
      } else {
        $('#btn-practice-say').disabled = false;
        input.focus();
      }
      updateTurns();
    } catch (err) {
      $('#btn-practice-say').disabled = false;
      setMsg($('#practice-msg'), err.message, 'err');
    }
  }

  async function finishPractice() {
    if (!session) return;
    try {
      const r = await api(`/api/practice/${session.id}/finish`, {});
      session.done = true;
      $('#practice-input').disabled = true;
      $('#btn-practice-say').disabled = true;
      $('#checklist').innerHTML = `<h4 tabindex="-1" id="checklist-h">Your call checklist: ${r.got} of ${r.total}</h4>
        <ul>${r.checklist.map((i) => `<li>
          <span class="mark ${i.ok ? 'yes' : 'no'}">${i.ok ? '✓ Done' : '✗ Missed'}</span><span>${esc(i.item)}</span>
          ${i.ok ? '' : `<span class="tip">Tip: ${esc(i.tip)}</span>`}</li>`).join('')}</ul>
        <p class="hint">Scored by fixed rules that look for what you said, not by AI.</p>`;
      $('#checklist-h').focus();
      setMsg($('#turn-count'), '');
    } catch (e) {
      setMsg($('#practice-msg'), e.message, 'err');
    }
  }

  // ---------- hooks ----------
  window.SecondLookAfterRender = () => {
    const key = state.caseId || (state.analysisId ? `saved-${state.analysisId}` : 'upload');
    if (key !== lastKey) {
      lastKey = key;
      resetPractice();
      setMsg($('#dispute-msg'), '');
    }
    renderDispute();
  };
  window.SecondLookDisputes = () => [...disputes.values()];

  async function init() {
    try {
      (await api('/api/disputes')).forEach((d) => disputes.set(d.id, d));
    } catch (e) { /* server may be starting; fine */ }
    if (state.result) renderDispute();
    $('#dispute-box').addEventListener('click', onDisputeClick);
    if (hasPractice) {
      $('#btn-practice-start').addEventListener('click', startPractice);
      $('#practice-form').addEventListener('submit', sayIt);
      $('#practice-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) sayIt(e);
      });
      $('#btn-practice-finish').addEventListener('click', finishPractice);
    }
  }

  init();
})();
