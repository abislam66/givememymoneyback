// Ask SecondLook (browser side): suggested questions, a small chat, a speaker for each answer, and Alt+R.
// Answers come from /api/ask (grounded in the current bill, EOB and rules result). If the server can't be
// reached, suggested questions still get the same deterministic answers from /askfacts.js.
// Voice: ElevenLabs through the server (/api/tts, key stays server-side); the browser voice is the fallback.

(() => {
  'use strict';

  const SL = window.SecondLook;
  const A = window.SecondLookAsk;
  if (!SL || !A || !document.getElementById('ask-section')) return;
  const { state, api, esc, announce, setMsg, stopSpeaking } = SL;
  const $ = (sel) => document.querySelector(sel);

  // ---------- voice player (one at a time) ----------
  const RATES = [0.75, 1, 1.25];
  const player = { owner: null, text: '', rate: 1, mode: null, audio: null, playing: false, paused: false, loading: false, seq: 0, cache: new Map() };

  function render() {
    document.querySelectorAll('.speaker').forEach((box) => {
      const mine = player.owner === box.dataset.owner;
      const on = mine && player.playing && !player.paused;
      const play = box.querySelector('[data-act="toggle"]');
      play.textContent = on ? 'Pause' : (mine && player.loading ? 'Loading…' : 'Play');
      play.setAttribute('aria-pressed', String(on));
      box.querySelector('[data-act="stop"]').disabled = !mine || (!player.playing && !player.paused);
      box.querySelectorAll('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === (mine ? player.rate : Number(box.dataset.rate || 1)))));
    });
    const st = $('#hear-status');
    if (st) st.textContent = player.owner === 'summary' && (player.playing || player.paused) ? (player.paused ? 'Paused.' : 'Playing the summary. Press Alt + R again to stop.') : '';
  }

  function stop() {
    player.seq += 1;
    if (player.audio) { player.audio.onended = null; player.audio.pause(); }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    player.owner = null; player.playing = false; player.paused = false; player.loading = false;
    render();
  }

  function done(seq) {
    if (seq !== player.seq) return;
    player.playing = false; player.paused = false; player.loading = false;
    render();
  }

  function speakBrowser(text, seq) {
    if (!('speechSynthesis' in window)) { done(seq); setMsg($('#ask-msg'), "Your browser can't read text aloud.", 'err'); return; }
    player.mode = 'browser';
    const u = new SpeechSynthesisUtterance(text.replace(/[•\[\]]/g, ''));
    u.rate = player.rate;
    u.onend = () => done(seq);
    u.onerror = () => done(seq);
    window.speechSynthesis.speak(u);
  }

  async function play(text, owner, rate) {
    stop();
    stopSpeaking(); // the letter / call-script voice in app.js
    const seq = player.seq;
    Object.assign(player, { owner, text, rate: rate || 1, playing: true, paused: false, loading: true });
    render();
    if (!state.demo) {
      try {
        let url = player.cache.get(text);
        if (!url) {
          const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
          if (res.ok) { url = URL.createObjectURL(await res.blob()); player.cache.set(text, url); }
        }
        if (seq !== player.seq) return;
        if (url) {
          player.mode = 'eleven';
          player.audio = new Audio(url);
          player.audio.playbackRate = player.rate;
          player.audio.onended = () => done(seq);
          player.loading = false;
          await player.audio.play();
          render();
          return;
        }
      } catch (e) { /* browser voice below */ }
    }
    if (seq !== player.seq) return;
    player.loading = false;
    render();
    speakBrowser(text, seq);
  }

  function toggle(text, owner, rate) {
    if (player.owner !== owner || (!player.playing && !player.paused)) return play(text, owner, rate);
    if (player.loading) return stop();
    if (player.paused) {
      player.paused = false;
      if (player.mode === 'eleven' && player.audio) player.audio.play();
      else if (window.speechSynthesis) window.speechSynthesis.resume();
    } else {
      player.paused = true;
      if (player.mode === 'eleven' && player.audio) player.audio.pause();
      else if (window.speechSynthesis) window.speechSynthesis.pause();
    }
    render();
    return null;
  }

  function setRate(owner, rate, box) {
    box.dataset.rate = String(rate);
    if (player.owner !== owner) { render(); return; }
    player.rate = rate;
    if (player.mode === 'eleven' && player.audio) player.audio.playbackRate = rate;
    else if (player.playing && !player.paused) { const t = player.text; play(t, owner, rate); return; }
    render();
  }

  // The letter / call-script buttons in app.js use their own voice; stop this one when they start.
  ['#btn-read-results', '#btn-play-script'].forEach((sel) => { const b = $(sel); if (b) b.addEventListener('click', stop, true); });

  // ---------- chat ----------
  let history = [];
  let answerNo = 0;
  let busy = false;

  function speakerHtml(owner) {
    return `<div class="speaker" data-owner="${owner}" data-rate="1" role="group" aria-label="Listen to this answer">
      <button type="button" class="btn small" data-act="toggle" aria-pressed="false">Play</button>
      <button type="button" class="btn small ghost" data-act="replay">Replay</button>
      <button type="button" class="btn small ghost" data-act="stop" disabled>Stop</button>
      <span class="speed" role="group" aria-label="Speed">${RATES.map((r) => `<button type="button" class="chip small" data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`).join('')}</span>
    </div>`;
  }

  function addBubble(role, html, extraClass = '') {
    const li = document.createElement('li');
    li.className = `ask-msg ${role}${extraClass ? ` ${extraClass}` : ''}`;
    li.innerHTML = `<span class="who">${role === 'user' ? 'You' : 'SecondLook'}</span>${html}`;
    $('#ask-log').appendChild(li);
    return li;
  }

  const bodyHtml = (text) => `<div class="ask-text">${esc(text).replace(/\n/g, '<br>')}</div>`;

  async function ask(question, intent) {
    if (busy) return;
    if (!state.result) { setMsg($('#ask-msg'), 'Load a bill first.', 'err'); return; }
    const q = String(question || '').trim();
    if (!q) { setMsg($('#ask-msg'), 'Type a question first.', 'err'); return; }
    busy = true;
    setMsg($('#ask-msg'), '');
    addBubble('user', bodyHtml(q));
    const pending = addBubble('bot', '<div class="ask-text">Looking at your documents…</div>', 'pending');
    let out;
    try {
      out = await api('/api/ask', { question: q, intent: intent || null, history, bill: state.bill, eob: state.eob }, { timeout: 25000 });
    } catch (e) {
      const kind = intent || A.intentOf(q);
      const text = kind ? A.answer(kind, state.result, state.bill, state.eob) : "I couldn't reach the server, so I can only answer the suggested questions right now.";
      out = { text, source: 'template' };
    }
    const owner = `answer-${++answerNo}`;
    const note = out.source === 'gemini' ? 'Worded by Gemini from your documents; every number was checked against your results.' : 'From your documents and the rules. No AI used.';
    pending.classList.remove('pending');
    pending.innerHTML = `<span class="who">SecondLook</span>${bodyHtml(out.text)}<p class="ask-src">${note}</p>${speakerHtml(owner)}`;
    pending.querySelector('.speaker').dataset.text = out.text;
    history.push({ role: 'user', text: q }, { role: 'model', text: out.text });
    history = history.slice(-8);
    announce(`SecondLook answered: ${out.text}`);
    busy = false;
  }

  function onLogClick(e) {
    const btn = e.target.closest('button');
    const box = btn && btn.closest('.speaker');
    if (!box) return;
    const { owner, text } = box.dataset;
    const rate = Number(box.dataset.rate || 1);
    if (btn.dataset.rate) setRate(owner, Number(btn.dataset.rate), box);
    else if (btn.dataset.act === 'toggle') toggle(text, owner, rate);
    else if (btn.dataset.act === 'replay') play(text, owner, rate);
    else if (btn.dataset.act === 'stop') stop();
  }

  function resetChat() {
    stop();
    history = [];
    $('#ask-log').innerHTML = '';
    setMsg($('#ask-msg'), '');
  }

  // ---------- Alt+R: hear only the vital results summary ----------
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.code !== 'KeyR') return;
    if (typing(e.target) || !state.result) return;
    e.preventDefault();
    if (player.owner === 'summary' && (player.playing || player.paused)) { stop(); announce('Stopped.'); return; }
    announce('Reading the summary.');
    play(A.vitalSummary(state.result), 'summary', 1);
  });

  // ---------- wire up ----------
  $('#ask-suggestions').innerHTML = A.SUGGESTED.map((s) => `<button type="button" class="chip" data-intent="${s.id}">${esc(s.question)}</button>`).join('');
  $('#ask-suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-intent]');
    if (b) ask(b.textContent, b.dataset.intent);
  });
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#ask-input');
    const q = input.value;
    input.value = '';
    ask(q, null);
  });
  $('#ask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask-form').requestSubmit(); }
  });
  $('#ask-log').addEventListener('click', onLogClick);

  // A new result (another bill, an upload, or break-it) starts a fresh conversation.
  let lastResult = state.result;
  const tiles = $('#tiles');
  if (tiles) new MutationObserver(() => { if (state.result !== lastResult) { lastResult = state.result; resetChat(); } }).observe(tiles, { childList: true });
})();
