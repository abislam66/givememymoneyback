// SecondLook front end. Plain JS, no framework.
// The server's rules engine decides every finding; this file only shows them.

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    cases: [],
    caseId: null,
    title: '',
    profile: null,
    original: null, // { bill, eob } as loaded, for "Reset"
    bill: null,
    eob: null,
    result: null,
    breakIt: false,
    status: { gemini: false, elevenlabs: false },
    demo: false,
    analysisId: null, // the saved analysis on screen (signed-in users), if any
  };

  // ---------- small helpers ----------
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const round2 = (x) => Math.round(x * 100) / 100;
  const sum = (arr, f) => round2((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0));

  function money(n) {
    const v = Math.abs(round2(Number(n) || 0));
    const s = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (Number(n) < -0.004 ? '−$' : '$') + s;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : (iso || 'no date');
  }
  const term = (label, key) => `<button type="button" class="term" data-term="${esc(key || label)}">${esc(label)}</button>`;
  const codeTerm = (code) => (code ? `<button type="button" class="term code-btn" data-term="${esc(code)}" aria-label="What is code ${esc(code)}?">${esc(code)}</button>` : '<span>no code</span>');

  function pref(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(`secondlook-${key}`);
      localStorage.setItem(`secondlook-${key}`, value);
    } catch (e) { /* storage blocked: fine */ }
    return null;
  }

  function announce(text) {
    const el = $('#sr-announce');
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 50);
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = `msg${kind ? ` ${kind}` : ''}`;
  }

  async function api(path, body, { timeout = 30000, method } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      // Who is asking: a signed-in token, a demo guest id, or nothing (public/auth.js).
      const who = window.SecondLookAuth ? await window.SecondLookAuth.headers() : {};
      const res = await fetch(path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.demo ? { 'X-SecondLook-Demo': '1' } : {}), ...who },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Something went wrong (error ${res.status}). Please try again.`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('That took too long. Please check your connection and try again.');
      if (e instanceof TypeError) throw new Error("We couldn't reach the SecondLook server. Is it running?");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Keep keyboard focus on the same control across a re-render.
  function keepFocus(fn) {
    const id = document.activeElement && document.activeElement.id;
    fn();
    if (id) {
      const el = document.getElementById(id);
      if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    }
  }

  // ---------- display settings ----------
  function initSettings() {
    const large = pref('large') === '1';
    document.documentElement.classList.toggle('large', large);
    $('#btn-large').setAttribute('aria-pressed', String(large));
    $('#btn-large').addEventListener('click', () => {
      const on = !document.documentElement.classList.contains('large');
      document.documentElement.classList.toggle('large', on);
      $('#btn-large').setAttribute('aria-pressed', String(on));
      pref('large', on ? '1' : '0');
      requestAnimationFrame(drawConnectors);
    });

    // Light by default, whatever the OS uses; dark mode only through the toggle.
    const saved = pref('theme');
    const applyTheme = (t) => {
      document.documentElement.setAttribute('data-theme', t);
      $('#btn-theme').setAttribute('aria-pressed', String(t === 'dark'));
    };
    applyTheme(saved === 'dark' ? 'dark' : 'light');
    $('#btn-theme').addEventListener('click', () => {
      const dark = $('#btn-theme').getAttribute('aria-pressed') !== 'true';
      applyTheme(dark ? 'dark' : 'light');
      pref('theme', dark ? 'dark' : 'light');
    });
  }

  // ---------- loading cases ----------
  // Three fictional example bills are offered to people. The other test cases stay in the test sets and scoreboards.
  const EXAMPLES = ['case-01', 'case-11', 'case-02'];

  async function loadCaseList() {
    state.cases = await api('/api/cases');
    fillCaseSelect();
  }

  // Fill the dropdown, optionally with one family member's claims only.
  function fillCaseSelect(profileId) {
    const sel = $('#case-select');
    const shown = EXAMPLES.map((id) => state.cases.find((c) => c.id === id)).filter(Boolean)
      .filter((c) => !profileId || (c.profile && c.profile.id === profileId));
    sel.innerHTML = '<option value="">Choose an example…</option>';
    shown.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.title} (fictional)`;
      sel.appendChild(o);
    });
    if (state.caseId && sel.querySelector(`option[value="${state.caseId}"]`)) sel.value = state.caseId;
  }

  async function loadCase(id) {
    const c = await api(`/api/cases/${encodeURIComponent(id)}`);
    state.caseId = c.id;
    state.analysisId = null;
    state.title = c.title;
    state.profile = c.profile;
    state.original = { bill: clone(c.bill), eob: clone(c.eob) };
    state.bill = clone(c.bill);
    state.eob = clone(c.eob);
    $('#case-select').value = c.id;
    await runCheck();
  }

  const DEMO = window.SECONDLOOK_DEMO || null;
  // True when demo mode is on and the unedited hero case is showing, so bundled answers apply.
  function demoHero() {
    return Boolean(state.demo && DEMO && state.caseId === DEMO.case.id
      && JSON.stringify(state.bill) === JSON.stringify(DEMO.case.bill) && JSON.stringify(state.eob) === JSON.stringify(DEMO.case.eob));
  }

  async function runCheck() {
    state.result = demoHero() ? clone(DEMO.result) : await api('/api/check', { bill: state.bill, eob: state.eob });
    renderAll();
  }

  // Demo mode: show Maya's bill from the bundled data. No network request is needed.
  function loadDemoHero() {
    const c = DEMO.case;
    state.caseId = c.id;
    state.analysisId = null;
    state.title = c.title;
    state.profile = c.profile;
    state.original = { bill: clone(c.bill), eob: clone(c.eob) };
    state.bill = clone(c.bill);
    state.eob = clone(c.eob);
    state.result = clone(DEMO.result);
    if ($('#case-select').querySelector(`option[value="${c.id}"]`)) $('#case-select').value = c.id;
    if (state.breakIt) setBreakIt(false);
    renderAll();
  }

  // Offline fallback only: if the server can't be reached, show the saved example (Maya's fictional bill)
  // with no outside services. There is no button for this; it is not a separate mode for people to pick.
  function setDemo(on) {
    state.demo = on && Boolean(DEMO);
    $('#demo-note').hidden = !state.demo;
    stopSpeaking();
    if (state.demo) {
      loadDemoHero();
      renderScoreboard(DEMO.scoreboard);
    }
  }

  // Nothing checked yet (a signed-in person who hasn't uploaded or opened anything): show the empty states.
  function renderEmpty() {
    document.body.classList.add('no-result');
    $('#result-h').textContent = 'No bill checked yet.';
    $('#reviewing').textContent = 'Upload your bill and EOB, open a saved analysis, or try an example.';
    if (typeof window.SecondLookAfterRender === 'function') window.SecondLookAfterRender(state);
  }

  // ---------- render ----------
  function renderAll() {
    document.body.classList.toggle('no-result', !state.result);
    keepFocus(() => {
      renderHero();
      renderMath();
      renderFindings();
      renderRecon();
      renderLetter();
    });
    requestAnimationFrame(drawConnectors);
    if (typeof window.SecondLookAfterRender === 'function') window.SecondLookAfterRender(state);
  }

  const svg = (d, cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON = {
    check: svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 9.8', 'vv-icon'),
    down: svg('M12 5v14M6 13l6 6 6-6', 'i'),
    alert: svg('M12 3 2.5 20h19L12 3zM12 10v4M12 17.2v.1', 'i'),
    clock: svg('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', 'i'),
  };

  // Counts the big number down from the billed amount to what you likely owe, once per new result.
  // Decorative (the element is inside an aria-hidden card); the final text is always the exact amount.
  // The hero can be re-rendered mid-count (same result); the count then carries on in the new element.
  const COUNT_MS = 1100;
  let count = null;
  const countText = (c, now) => {
    const t = Math.min(1, (now - c.start) / COUNT_MS);
    return t < 1 ? money(Math.round(c.from - (c.from - c.to) * (1 - Math.pow(1 - t, 3)))) : money(c.to);
  };
  function countDown(el, key) {
    if (!el) return;
    if (count && count.key === key) {
      count.el = el;
      if (count.running) el.textContent = countText(count, performance.now());
      return;
    }
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    count = { key, el, from, to, start: performance.now(), running: !reduce && from > to };
    if (!count.running) return;
    const c = count;
    const tick = (now) => {
      if (count !== c) return;
      c.el.textContent = countText(c, now);
      if (now - c.start < COUNT_MS) requestAnimationFrame(tick);
      else c.running = false;
    };
    el.textContent = money(from);
    requestAnimationFrame(tick);
  }

  function renderHero() {
    const r = state.result;
    const s = r.summary;
    const who = state.profile ? `${state.profile.name} (${state.profile.relation})` : ((state.bill.patient && state.bill.patient.name) || 'Your upload');
    $('#reviewing').textContent = `Reviewing: ${who} · ${(state.bill.provider && state.bill.provider.name) || 'Provider'} · Claim ${state.eob.claim_number || 'unknown'}`;

    const clean = r.flags.length === 0;
    const carried = s.previous_balance > 0
      ? ` for this visit, plus <strong>${money(s.previous_balance)}</strong> carried over from an earlier bill that we didn't check`
      : '';
    $('#result-h').innerHTML = clean
      ? `The bill says <strong>${money(s.amount_due)}</strong>. That matches your insurer's statement. You likely owe <strong class="owe">${money(s.likely_owe)}</strong>${carried}.`
      : `The bill says <strong>${money(s.amount_due)}</strong>. Based on your insurer's statement, you likely owe <strong class="owe">${money(s.likely_owe)}</strong>${carried}.`;

    // Big "bill says → you likely owe" card. Visual only (aria-hidden); #result-h carries the same facts
    // for screen readers, and the full math sits behind "View the math".
    const lower = s.likely_owe + (s.previous_balance || 0) < s.amount_due;
    const carriedNote = s.previous_balance > 0 ? `<span class="vv-s">plus ${money(s.previous_balance)} carried over from an earlier bill, not checked</span>` : '';
    // Metric cards (dashboard style): Bill says, Likely owe. The problem count and savings follow in #tiles.
    $('#verdict-visual').innerHTML = `<div class="tile metric metric-bill">
        <span class="k">Bill says</span>
        <span class="v"><span class="vv-was${lower ? ' struck' : ''}">${money(s.amount_due)}</span></span>
        <span class="s">Amount due on the statement</span>
      </div>
      <div class="tile metric metric-owe${clean ? ' vv-clean' : ''}">
        <span class="k">Likely owe</span>
        <span class="v"><span id="vv-owe" data-from="${clean ? s.likely_owe : s.amount_due}" data-to="${s.likely_owe}">${money(s.likely_owe)}</span></span>
        ${carriedNote || `<span class="s">${clean ? `${ICON.check.replace('vv-icon', 'i')} Matches your insurer` : 'Your share, from your insurer'}</span>`}
      </div>`;
    countDown($('#vv-owe'), `${state.caseId || 'upload'}|${s.amount_due}|${s.likely_owe}`);

    const n = r.flags.length;
    $('#hero-actions').innerHTML = clean
      ? `<a class="btn ghost" href="#find-h">See the details ${ICON.down}</a>`
      : `<a class="btn" href="#find-h">See the ${n} ${n === 1 ? 'problem' : 'problems'} ${ICON.down}</a><a class="btn ghost" href="#step-dispute">Create dispute letter</a>`;

    const tiles = [];
    tiles.push(clean
      ? `<div class="tile problems ok"><span class="k">Problems found</span><span class="v">${ICON.check.replace('vv-icon', 'i')} None</span><span class="s">Every line matches.</span></div>`
      : `<div class="tile problems"><span class="k">Problems found</span><span class="v">${n}</span><span class="s">Each one is explained below.</span></div>`);
    tiles.push(`<div class="tile potential"><span class="k">Potential savings</span><span class="v">${money(s.potential_savings)}</span><span class="s">Potential, not yet saved</span></div>`);
    if (s.previous_balance > 0) {
      tiles.push(`<div class="tile pending"><span class="k">Carried-over balance</span><span class="v">${money(s.previous_balance)}</span><span class="s">From an earlier bill. Not checked here.</span></div>`);
    }
    if (s.pending_amount > 0) {
      tiles.push(`<div class="tile pending"><span class="k">Waiting on insurance</span><span class="v">${money(s.pending_amount)}</span><span class="s">Should go to your insurer first</span></div>`);
    }
    $('#tiles').innerHTML = tiles.join('');
    $('#notes').innerHTML = (r.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  }

  function renderMath() {
    const m = state.result.math;
    $('#math').innerHTML = m.map((step, i) => {
      const cls = i === 0 ? 'first' : (i === m.length - 1 ? 'last' : (step.amount < 0 ? 'minus' : ''));
      return `<li class="${cls}"><span>${esc(step.label)}</span><span class="num">${money(step.amount)}</span></li>`;
    }).join('');
  }

  const TYPE_LABEL = {
    duplicate_charge: 'Duplicate charge',
    missing_insurance_payment: 'Missing insurance payment',
    not_submitted_to_insurance: 'Not sent to insurance',
    adjustment_missing: 'Discount missing',
    charge_mismatch: 'Price differs',
    surprise_bill_nsa: 'No Surprises Act',
    unexplained_difference: 'Unexplained difference',
  };

  function renderFindings() {
    const flags = state.result.flags;
    if (!flags.length) {
      $('#findings').innerHTML = `<li class="no-findings"><b>No errors found.</b> Every bill line matches your insurer's statement, and the totals add up. You can still ask for an ${term('itemized bill')}.</li>`;
      return;
    }
    $('#findings').innerHTML = flags.map((f) => {
      const pending = f.type === 'not_submitted_to_insurance';
      return `<li class="finding${pending ? ' pending-kind' : ''}" id="finding-${esc(f.id)}">
        <div class="finding-top">
          <span class="kind">${pending ? ICON.clock : ICON.alert}${esc(TYPE_LABEL[f.type] || f.type)}</span>
          <span class="amt">${money(f.amount)} ${pending ? 'to send to insurance first' : 'difference'}</span>
        </div>
        <h4>${esc(f.title)}</h4>
        <p>${esc(f.explanation)}</p>
        <p class="ask"><b>What to ask</b>${esc(f.what_to_ask)}</p>
        <div class="row">
          <button type="button" class="btn small ghost" id="show-${esc(f.id)}" data-show="${esc(f.id)}" aria-controls="recon">Show evidence</button>
          <button type="button" class="btn small ghost" id="why-${esc(f.id)}" data-why="${esc(f.id)}">Why?</button>
        </div>
      </li>`;
    }).join('');
  }

  // Status of every bill line and EOB line, from the server's result.
  // One bill line can match several EOB lines (units split across lines), and the reverse.
  function lineStatus() {
    const r = state.result;
    const bill = {};
    const eob = {};
    r.matches.forEach((m) => {
      const kind = m.status === 'ok' ? 'ok' : 'diff';
      const b = bill[m.bill_line_no] || (bill[m.bill_line_no] = { kind, eobs: [] });
      b.eobs.push(m.eob_index);
      if (kind === 'diff') b.kind = 'diff';
      const e = eob[m.eob_index] || (eob[m.eob_index] = { kind, bills: [] });
      e.bills.push(m.bill_line_no);
      if (kind === 'diff') e.kind = 'diff';
    });
    r.unmatched_bill_lines.forEach((u) => {
      if (u.reason === 'extra_units') {
        const b = bill[u.line_no] || (bill[u.line_no] = { kind: 'ok', eobs: [] });
        if (b.kind !== 'diff') b.kind = 'extra';
        b.extra = u.extra_units;
        return;
      }
      const st = { kind: u.reason === 'duplicate' ? 'dup' : 'miss', eobs: [] };
      if (u.reason === 'duplicate') {
        const f = r.flags.find((x) => x.type === 'duplicate_charge' && x.evidence.bill_lines.includes(u.line_no));
        if (f) st.of = (f.details && f.details.first_line) || f.evidence.bill_lines[0];
      }
      bill[u.line_no] = st;
    });
    return { bill, eob };
  }
  const listNos = (nos) => (nos.length === 1 ? String(nos[0]) : `${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]}`);
  const plural = (nos, word) => `${word}${nos.length === 1 ? '' : 's'} ${listNos(nos)}`;
  const unitWord = (n) => `${n} ${Number(n) === 1 ? 'unit' : 'units'}`;

  const BADGE = {
    ok: '<span class="st st-ok"><span aria-hidden="true">✓</span> Matched</span>',
    dup: '<span class="st st-dup"><span aria-hidden="true">×2</span> Duplicate</span>',
    miss: '<span class="st st-miss"><span aria-hidden="true">?</span> Not on insurer statement</span>',
    diff: '<span class="st st-diff"><span aria-hidden="true">≠</span> Price differs</span>',
    extra: '<span class="st st-dup"><span aria-hidden="true">+</span> Extra units</span>',
    none: '<span class="st st-none"><span aria-hidden="true">–</span> Not on bill</span>',
  };

  function renderRecon() {
    const st = lineStatus();
    const b = state.bill;
    const e = state.eob;
    const edit = state.breakIt;
    $('#bill-from').textContent = `${(b.provider && b.provider.name) || ''} · Account ${b.account_number || '?'}`;
    $('#eob-from').textContent = `${e.insurer || ''} · ${e.network || ''}${e.service_type ? ` · ${e.service_type}` : ''}`;

    // ---- bill table ----
    const head = `<caption class="sr-only">Bill lines with their match status</caption><thead><tr>
      <th scope="col">#</th><th scope="col">Service</th><th scope="col" class="r">${term('Units')}</th><th scope="col" class="r">Charge</th>
      ${edit ? '<th scope="col">Change</th>' : ''}<th scope="col">Status</th></tr></thead>`;
    const rows = b.lines.map((l) => {
      const s = st.bill[l.line_no] || { kind: 'miss' };
      const cls = s.kind === 'dup' || s.kind === 'diff' || s.kind === 'extra' ? 'row-bad' : (s.kind === 'miss' ? 'row-miss' : '');
      const eobNos = (s.eobs || []).map((i) => i + 1);
      let label = '';
      if (s.kind === 'ok') label = `Matches insurer ${plural(eobNos, 'line')}`;
      else if (s.kind === 'diff') label = `Price differs from insurer ${plural(eobNos, 'line')}`;
      else if (s.kind === 'extra') label = `${unitWord(s.extra)} more than insurer ${plural(eobNos, 'line')} processed`;
      else if (s.kind === 'dup') label = s.of ? `Repeat of line ${s.of}` : 'Repeat of another line';
      else label = 'No matching insurer line';
      const n = l.line_no;
      const svc = edit
        ? `<div class="edit-grid">
             <span class="svc-name">${esc(l.description)}</span>
             <label class="sr-only" for="ed-code-${n}">Code for line ${n}</label>
             <input class="edit-in edit-code" id="ed-code-${n}" type="text" inputmode="numeric" maxlength="5" data-edit="code" data-line="${n}" value="${esc(l.code)}">
             <label class="sr-only" for="ed-date-${n}">Date for line ${n}</label>
             <input class="edit-in edit-date" id="ed-date-${n}" type="date" data-edit="date" data-line="${n}" value="${esc(l.date)}">
           </div>`
        : `<div class="svc"><span class="svc-name">${esc(l.description)}</span><span class="svc-meta">${codeTerm(l.code)} · ${esc(shortDate(l.date))}</span></div>`;
      const unitsCell = edit
        ? `<label class="sr-only" for="ed-units-${n}">Units for line ${n}</label><input class="edit-in edit-units" id="ed-units-${n}" type="number" step="1" min="1" data-edit="units" data-line="${n}" value="${esc(l.units === undefined ? 1 : l.units)}">`
        : `<span class="num">${esc(l.units === undefined ? 1 : l.units)}</span>`;
      const charge = edit
        ? `<label class="sr-only" for="ed-charge-${n}">Charge for line ${n}</label><input class="edit-in edit-charge" id="ed-charge-${n}" type="number" step="0.01" min="0" data-edit="charge" data-line="${n}" value="${esc(l.charge)}">`
        : `<span class="num">${money(l.charge)}</span>`;
      const actions = edit
        ? `<td><div class="row-actions">
             <button type="button" class="btn small ghost" id="dup-${n}" data-act="dup" data-line="${n}">Duplicate<span class="sr-only"> line ${n}</span></button>
             <button type="button" class="btn small ghost" id="del-${n}" data-act="del" data-line="${n}">Delete<span class="sr-only"> line ${n}</span></button>
           </div></td>`
        : '';
      return `<tr id="bill-row-${n}" class="${cls}" data-kind="${s.kind}">
        <td class="lineno">${n}</td><td>${svc}</td><td class="r">${unitsCell}</td><td class="r">${charge}</td>${actions}
        <td><div class="status-cell">${BADGE[s.kind]}<span class="match-label">${esc(label)}</span></div></td></tr>`;
    }).join('');
    $('#bill-table').innerHTML = `${head}<tbody>${rows || `<tr><td colspan="${edit ? 6 : 5}">No lines.</td></tr>`}</tbody>`;

    // ---- EOB table ----
    const eHead = `<caption class="sr-only">Insurer statement lines</caption><thead><tr>
      <th scope="col">#</th><th scope="col">Service</th><th scope="col" class="r">${term('Units')}</th><th scope="col" class="r">${term('Billed', 'billed amount')}</th>
      <th scope="col" class="r">${term('Allowed', 'allowed amount')}</th><th scope="col" class="r">${term('Insurer paid')}</th>
      <th scope="col" class="r">${term('Your share', 'patient responsibility')}</th></tr></thead>`;
    const eRows = e.lines.map((l, i) => {
      const s = st.eob[i];
      const cls = s && s.kind === 'diff' ? 'row-bad' : '';
      const label = s ? `Matches bill ${plural(s.bills, 'line')}` : 'No matching bill line';
      return `<tr id="eob-row-${i}" class="${cls}">
        <td class="lineno">${i + 1}</td>
        <td><div class="svc"><span class="svc-name">${esc(l.description)}</span><span class="svc-meta">${codeTerm(l.code)} · ${esc(shortDate(l.date))}</span>
          ${s ? `<span class="match-label">${esc(label)}</span>` : BADGE.none}</div></td>
        <td class="r num">${esc(l.units === undefined ? 1 : l.units)}</td><td class="r num">${money(l.billed)}</td><td class="r num">${money(l.allowed)}</td>
        <td class="r num">${money(l.insurer_paid)}</td><td class="r num">${money(l.patient_resp)}</td></tr>`;
    }).join('');
    $('#eob-table').innerHTML = `${eHead}<tbody>${eRows}</tbody>`;

    // ---- totals ----
    const charges = sum(b.lines, (l) => l.charge);
    const adj = sum(b.adjustments, (a) => a.amount);
    const ins = sum(b.insurance_payments, (p) => p.amount);
    const pp = sum(b.patient_payments, (p) => p.amount);
    const bt = [];
    bt.push(`<dt>Total charges</dt><dd>${money(charges)}</dd>`);
    bt.push(`<dt data-sec="adjustments">${term('Contractual adjustment')}</dt><dd data-sec="adjustments">${edit
      ? `<label class="sr-only" for="ed-adj">Contractual adjustment total</label><input class="edit-in" id="ed-adj" type="number" step="0.01" min="0" data-edit="adj" value="${adj}">`
      : money(-adj)}</dd>`);
    bt.push(`<dt data-sec="insurance_payments">${term('Insurance payments', 'insurance payment')}</dt><dd data-sec="insurance_payments">${edit
      ? `<label class="sr-only" for="ed-ins">Insurance payments total</label><input class="edit-in" id="ed-ins" type="number" step="0.01" min="0" data-edit="ins" value="${ins}">`
      : money(-ins)}</dd>`);
    if (pp > 0) bt.push(`<dt>Your payments</dt><dd>${money(-pp)}</dd>`);
    if (Number(b.previous_balance) > 0) bt.push(`<dt data-sec="previous_balance">Previous balance (not checked)</dt><dd data-sec="previous_balance">+${money(b.previous_balance)}</dd>`);
    bt.push(`<dt class="grand" data-sec="amount_due">${term('Amount due')}${edit ? ' (recalculated)' : ''}</dt><dd class="grand" data-sec="amount_due" id="bill-amount-due">${money(b.amount_due)}</dd>`);
    $('#bill-totals').innerHTML = bt.join('');

    const t = e.totals || {};
    $('#eob-totals').innerHTML = [
      `<dt>${term('Billed', 'billed amount')}</dt><dd>${money(t.billed)}</dd>`,
      `<dt>${term('Allowed', 'allowed amount')}</dt><dd>${money(t.allowed)}</dd>`,
      `<dt data-sec="eob_paid">${term('Insurer paid')}</dt><dd data-sec="eob_paid">${money(t.insurer_paid)}</dd>`,
      `<dt class="grand">${term('Patient responsibility')}</dt><dd class="grand">${money(t.patient_resp)}</dd>`,
    ].join('');
  }

  // ---------- connectors ----------
  function drawConnectors() {
    const svg = $('#connectors');
    const recon = $('#recon');
    if (!svg || !state.result || getComputedStyle(svg).display === 'none') { if (svg) svg.innerHTML = ''; return; }
    const box = recon.getBoundingClientRect();
    const billBox = $('.doc-bill .table-scroll').getBoundingClientRect();
    const eobBox = $('.doc-eob .table-scroll').getBoundingClientRect();
    const x1 = billBox.right - box.left;
    const x2 = eobBox.left - box.left;
    const dx = Math.max(20, (x2 - x1) / 2);
    const hlBill = new Set($$('#bill-table tr.hl').map((tr) => tr.id));
    const parts = [];
    for (const m of state.result.matches) {
      const br = document.getElementById(`bill-row-${m.bill_line_no}`);
      const er = document.getElementById(`eob-row-${m.eob_index}`);
      if (!br || !er) continue;
      const a = br.getBoundingClientRect();
      const c = er.getBoundingClientRect();
      const y1 = Math.min(Math.max(a.top + a.height / 2, billBox.top + 4), billBox.bottom - 4) - box.top;
      const y2 = Math.min(Math.max(c.top + c.height / 2, eobBox.top + 4), eobBox.bottom - 4) - box.top;
      const cls = m.status === 'ok' ? 'ok' : 'bad';
      const hl = hlBill.has(br.id) ? ' hl' : '';
      parts.push(`<path class="${cls}${hl}" d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>`);
      parts.push(`<circle class="${cls}" cx="${x1}" cy="${y1}" r="5"/><circle class="${cls}" cx="${x2}" cy="${y2}" r="5"/>`);
    }
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`);
    svg.innerHTML = parts.join('');
  }

  // ---------- "Show me" ----------
  function clearEvidence() {
    $$('.hl').forEach((el) => el.classList.remove('hl'));
    $$('.ev-badge').forEach((el) => el.remove());
  }

  function showEvidence(flagId) {
    const f = state.result.flags.find((x) => x.id === flagId);
    if (!f) return;
    clearEvidence();
    const ev = f.evidence || {};
    const mark = (row) => {
      if (!row) return;
      row.classList.add('hl');
      const cell = row.querySelector('.status-cell') || row.querySelector('.svc');
      if (cell) cell.insertAdjacentHTML('afterbegin', '<span class="ev-badge">Evidence</span>');
    };
    (ev.bill_lines || []).forEach((n) => mark(document.getElementById(`bill-row-${n}`)));
    (ev.eob_lines || []).forEach((i) => mark(document.getElementById(`eob-row-${i}`)));
    (ev.bill_sections || []).forEach((sec) => {
      $$(`[data-sec="${sec}"]`).forEach((el) => el.classList.add('hl'));
      if (sec === 'insurance_payments') $$('[data-sec="eob_paid"]').forEach((el) => el.classList.add('hl'));
    });
    // The comparison lives in a collapsible section; open it before measuring and scrolling.
    const details = $('#recon-details');
    if (details && !details.open) details.open = true;
    drawConnectors();
    $('#recon-section').scrollIntoView({ block: 'start' });
    const bits = [];
    if ((ev.bill_lines || []).length) bits.push(`bill line${ev.bill_lines.length > 1 ? 's' : ''} ${ev.bill_lines.join(' and ')}`);
    if ((ev.bill_sections || []).length) bits.push(`the bill's ${ev.bill_sections.map((s) => s.replace(/_/g, ' ')).join(' and ')}`);
    if ((ev.eob_lines || []).length) bits.push(`insurer line${ev.eob_lines.length > 1 ? 's' : ''} ${ev.eob_lines.map((i) => i + 1).join(', ')}`);
    announce(`Highlighted ${bits.join(', and ')} for: ${f.title}.`);
  }

  // ---------- explainer ----------
  let explainInvoker = null;
  let explainSeq = 0;

  async function openExplain(req, invoker, fallbackTitle) {
    explainInvoker = invoker || null;
    const panel = $('#explain');
    const seq = ++explainSeq;
    $('#explain-title').textContent = fallbackTitle || 'Explanation';
    $('#explain-body').textContent = 'Looking that up…';
    $('#explain-source').textContent = '';
    panel.hidden = false;
    $('#explain-title').focus();
    try {
      let out = null;
      if (demoHero()) out = req.term ? DEMO.terms[String(req.term).toLowerCase()] : DEMO.flags[req.flag_id];
      if (!out) out = await api('/api/explain', { ...req, bill: state.bill, eob: state.eob });
      if (seq !== explainSeq) return;
      $('#explain-title').textContent = out.title || fallbackTitle || 'Explanation';
      $('#explain-body').textContent = out.text;
      $('#explain-source').textContent = out.source === 'gemini'
        ? 'Reworded by Gemini. Every number was checked against the rules.'
        : "From SecondLook's built-in glossary and rules.";
    } catch (e) {
      if (seq !== explainSeq) return;
      $('#explain-body').textContent = e.message;
    }
  }

  function closeExplain() {
    $('#explain').hidden = true;
    explainSeq += 1;
    if (explainInvoker && document.body.contains(explainInvoker)) explainInvoker.focus();
    explainInvoker = null;
  }

  // ---------- letter + voice ----------
  function renderLetter() {
    $('#letter-text').value = state.result.letter || '';
    $('#script-text').value = state.result.call_script || '';
  }

  function selectTab(which) {
    const letter = which === 'letter';
    $('#tab-letter').setAttribute('aria-selected', String(letter));
    $('#tab-script').setAttribute('aria-selected', String(!letter));
    $('#tab-letter').tabIndex = letter ? 0 : -1;
    $('#tab-script').tabIndex = letter ? -1 : 0;
    $('#pane-letter').hidden = !letter;
    $('#pane-script').hidden = letter;
  }

  async function copyCurrent() {
    const ta = $('#pane-letter').hidden ? $('#script-text') : $('#letter-text');
    const msg = $('#letter-msg');
    try {
      await navigator.clipboard.writeText(ta.value);
      setMsg(msg, 'Copied.', 'good');
    } catch (e) {
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      setMsg(msg, ok ? 'Copied.' : 'The text is selected. Press Ctrl+C (or Cmd+C) to copy it.', ok ? 'good' : '');
    }
  }

  let audio = null;
  let speakSeq = 0;
  function stopSpeaking() {
    speakSeq += 1;
    if (audio) { audio.pause(); audio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    $('#btn-stop').hidden = true;
  }

  // Speak with ElevenLabs when the server has it; otherwise (501 or any error) use the browser voice.
  async function speak(text, msgEl) {
    stopSpeaking();
    const seq = speakSeq;
    $('#btn-stop').hidden = false;
    const done = () => { if (seq === speakSeq) $('#btn-stop').hidden = true; };
    if (!state.demo && state.status.elevenlabs) {
      try {
        const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        if (res.ok) {
          const blob = await res.blob();
          if (seq !== speakSeq) return;
          audio = new Audio(URL.createObjectURL(blob));
          audio.onended = done;
          await audio.play();
          if (msgEl) setMsg(msgEl, 'Playing (ElevenLabs voice).');
          return;
        }
      } catch (e) { /* fall through to the browser voice */ }
    }
    if (seq !== speakSeq) return;
    if (!('speechSynthesis' in window)) {
      if (msgEl) setMsg(msgEl, "Your browser can't read text aloud.", 'err');
      done();
      return;
    }
    const u = new SpeechSynthesisUtterance(text.replace(/\[|\]/g, ''));
    u.rate = 0.95;
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
    if (msgEl) setMsg(msgEl, 'Playing (browser voice).');
  }

  function resultsText() {
    const r = state.result;
    const s = r.summary;
    const parts = [`The bill says ${money(s.amount_due)}. Based on your insurer's statement, you likely owe ${money(s.likely_owe)}.`];
    if (!r.flags.length) parts.push('We found no errors.');
    else {
      parts.push(`We found ${r.flags.length} ${r.flags.length === 1 ? 'problem' : 'problems'}.`);
      r.flags.forEach((f) => parts.push(`${f.title}. ${money(f.amount)}. ${f.explanation}`));
      parts.push(`Potential savings: ${money(s.potential_savings)}. This is not saved yet.`);
    }
    return parts.join(' ').replace(/−\$/g, 'minus $');
  }

  // ---------- break-it mode ----------
  let recheckTimer = null;
  function recomputeDue() {
    const b = state.bill;
    b.lines.forEach((l, i) => { l.line_no = i + 1; });
    b.amount_due = round2(sum(b.lines, (l) => l.charge) - sum(b.adjustments, (a) => a.amount)
      - sum(b.insurance_payments, (p) => p.amount) - sum(b.patient_payments, (p) => p.amount) + (Number(b.previous_balance) || 0));
    const due = $('#bill-amount-due');
    if (due) due.textContent = money(b.amount_due);
  }

  async function recheck(reason) {
    clearTimeout(recheckTimer);
    const before = state.result ? state.result.flags.map((f) => f.type) : [];
    const msg = $('#break-msg');
    setMsg(msg, 'Checking…');
    try {
      await runCheck();
      const after = state.result.flags.map((f) => f.type);
      const added = after.length - before.length;
      const change = added > 0 ? `${added} new` : (added < 0 ? `${-added} fewer` : 'same number');
      const text = `Re-checked${reason ? ` after ${reason}` : ''}. ${after.length} ${after.length === 1 ? 'finding' : 'findings'} now (${change}). You likely owe ${money(state.result.summary.likely_owe)}.`;
      setMsg(msg, text, 'good');
      announce(text);
    } catch (e) {
      setMsg(msg, e.message, 'err');
    }
  }
  function scheduleRecheck(reason) {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => recheck(reason), 250);
  }

  function setBreakIt(on) {
    state.breakIt = on;
    $('#btn-break').setAttribute('aria-pressed', String(on));
    $('#break-bar').hidden = !on;
    keepFocus(renderRecon);
    requestAnimationFrame(drawConnectors);
  }

  function onEditInput(e) {
    const el = e.target;
    const kind = el.dataset && el.dataset.edit;
    if (!kind) return;
    const b = state.bill;
    const v = el.value;
    if (kind === 'adj') {
      const n = Math.max(0, Number(v) || 0);
      b.adjustments = [{ description: 'Contractual adjustment', amount: round2(n) }];
    } else if (kind === 'ins') {
      const n = Math.max(0, Number(v) || 0);
      b.insurance_payments = n > 0 ? [{ date: b.statement_date, payer: state.eob.insurer || 'Insurer', amount: round2(n) }] : [];
    } else {
      const line = b.lines.find((l) => l.line_no === Number(el.dataset.line));
      if (!line) return;
      if (kind === 'charge') line.charge = round2(Math.max(0, Number(v) || 0));
      if (kind === 'units') line.units = Math.max(1, Number(v) || 1);
      if (kind === 'code') line.code = v.trim();
      if (kind === 'date') line.date = v;
    }
    recomputeDue();
    setMsg($('#break-msg'), 'Changed. Press Re-check, or move to the next box.');
  }

  function onEditAction(btn) {
    const n = Number(btn.dataset.line);
    const b = state.bill;
    const idx = b.lines.findIndex((l) => l.line_no === n);
    if (idx < 0) return;
    if (btn.dataset.act === 'dup') {
      b.lines.splice(idx + 1, 0, { ...b.lines[idx] });
      recomputeDue();
      recheck(`duplicating line ${n}`).then(() => { const el = $(`#dup-${n + 1}`); if (el) el.focus(); });
    } else {
      b.lines.splice(idx, 1);
      recomputeDue();
      recheck(`deleting line ${n}`).then(() => {
        const next = $(`#del-${Math.min(n, b.lines.length)}`) || $('#btn-recheck');
        if (next) next.focus();
      });
    }
  }

  // ---------- documents from the upload + review screen (public/upload-ui.js) ----------
  // The person has confirmed the numbers; from here the deterministic rules take over.
  async function useDocuments({ bill, eob, title, analysisId = null }) {
    stopSpeaking();
    if (state.breakIt) setBreakIt(false);
    state.caseId = null;
    state.analysisId = analysisId;
    $('#case-select').value = '';
    state.title = title || 'Your uploaded bill';
    state.profile = null;
    state.bill = clone(bill);
    state.eob = clone(eob);
    state.original = { bill: clone(bill), eob: clone(eob) };
    await runCheck();
  }

  // ---------- scoreboard ----------
  async function loadScoreboard() {
    try {
      renderScoreboard(state.demo && DEMO ? DEMO.scoreboard : await api('/api/scoreboard'));
    } catch (e) {
      $('#score-sets').textContent = 'Test results are not available yet. Run "npm run score" on the server.';
    }
    if (!state.demo) {
      // Only shown after "npm run score:extraction" has really been run with a Gemini key.
      api('/api/extraction-scoreboard').then(renderExtractionScore).catch(() => { $('#extraction-score').hidden = true; });
    }
  }

  function renderExtractionScore(x) {
    const box = $('#extraction-score');
    if (!x || !x.sets || !x.sets.length) { box.hidden = true; return; }
    const day = String(x.generated_at || '').slice(0, 10);
    box.innerHTML = `<h4>Reading documents with Gemini</h4>
      <p class="hint">Gemini read printed-style sample documents (${esc(x.format || 'png')}) with model ${esc(x.model)} on ${esc(day)}. Then the same rules ran on what it read.</p>
      ${x.sets.map((set) => {
        const t = set.totals;
        return `<p class="score-text"><b>${esc(set.name)}:</b> read <span class="num">${t.line_items_exact}</span> of <span class="num">${t.line_items_total}</span> line items exactly, header fields <span class="num">${t.headers_exact}</span> of <span class="num">${t.headers_total}</span>. Findings correct on <span class="num">${t.flags_correct}</span> of <span class="num">${t.cases}</span> cases, owed amount correct on <span class="num">${t.owe_correct}</span> of <span class="num">${t.cases}</span>.${t.errors ? ` ${t.errors} could not be read.` : ''}</p>`;
      }).join('')}
      <p class="hint">When Gemini misreads a number, the review step asks you to check it before any rules run.</p>`;
    box.hidden = false;
  }

  // One block per test set: the generated set and the hand-written edge cases.
  function renderScoreboard(sb) {
    const sets = sb.sets || [{ id: 'generated', name: `Generated set (${sb.totals.cases} cases)`, totals: sb.totals, cases: sb.cases }];
    const fmt = (a) => (a.length ? a.map((x) => `<code>${esc(x)}</code>`).join('<br>') : '<span aria-label="none">–</span>');
    const what = { generated: 'Fictional bills built by a program, with errors planted on purpose.', handwritten: 'Tricky cases written by hand: units split across lines, denied lines, carried-over balances, cents.' };
    $('#score-sets').innerHTML = sets.map((set) => {
      const t = set.totals;
      const all = t.caught === t.planted && t.false_alarms === 0 && t.owe_correct === t.cases;
      return `<div class="score-set">
        <h4>${esc(set.name)} <span class="st ${all ? 'st-ok' : 'st-diff'}"><span aria-hidden="true">${all ? '✓' : '≠'}</span> ${all ? 'All correct' : 'Not all correct'}</span></h4>
        <p class="hint">${esc(what[set.id] || '')}</p>
        <p class="score-text">Caught <span class="num">${t.caught}</span> of <span class="num">${t.planted}</span> planted errors, <span class="num">${t.false_alarms}</span> false alarms. The amount owed was right on <span class="num">${t.owe_correct}</span> of <span class="num">${t.cases}</span>.</p>
        <details><summary>See every case (${t.cases})</summary>
          <div class="table-scroll" role="region" aria-label="${esc(set.name)} results" tabindex="0">
          <table class="score-table"><caption class="sr-only">${esc(set.name)} results</caption>
          <thead><tr><th scope="col">Case</th><th scope="col">Planted errors</th><th scope="col">Found</th><th scope="col">Owed amount</th></tr></thead>
          <tbody>${set.cases.map((c) => `<tr><td>${esc(c.title)}</td><td>${fmt(c.planted)}</td><td>${fmt(c.found)}</td>
            <td class="num">${money(c.likely_owe)} ${c.owe_correct ? '✓ right' : '✗ wrong'}</td></tr>`).join('')}</tbody></table></div>
        </details></div>`;
    }).join('');
  }

  // ---------- wire up ----------
  function bind() {
    $('#case-select').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      stopSpeaking();
      try { await loadCase(e.target.value); announce(`Loaded ${state.title}.`); } catch (err) { showFatal(err.message); }
    });

    // Delegated clicks: terms, show me, why, break-it actions
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.term) { openExplain({ term: t.dataset.term }, t, t.textContent.trim()); return; }
      if (t.dataset.show) { showEvidence(t.dataset.show); return; }
      if (t.dataset.why) {
        const f = state.result.flags.find((x) => x.id === t.dataset.why);
        openExplain({ flag_id: t.dataset.why }, t, f ? f.title : 'Why?');
        return;
      }
      if (t.dataset.act) onEditAction(t);
    });

    const recon = $('#recon');
    recon.addEventListener('input', onEditInput);
    recon.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.edit) scheduleRecheck('your change'); });
    recon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.edit) { e.preventDefault(); recheck('your change'); }
    });

    $('#btn-break').addEventListener('click', () => setBreakIt(!state.breakIt));
    $('#btn-recheck').addEventListener('click', () => recheck());
    $('#btn-reset').addEventListener('click', async () => {
      state.bill = clone(state.original.bill);
      state.eob = clone(state.original.eob);
      await recheck('reset');
    });

    $('#explain-close').addEventListener('click', closeExplain);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#explain').hidden) closeExplain(); });

    $('#tab-letter').addEventListener('click', () => selectTab('letter'));
    $('#tab-script').addEventListener('click', () => selectTab('script'));
    $('.tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const toScript = $('#tab-letter').getAttribute('aria-selected') === 'true';
      selectTab(toScript ? 'script' : 'letter');
      (toScript ? $('#tab-script') : $('#tab-letter')).focus();
    });
    $('#btn-copy').addEventListener('click', copyCurrent);
    $('#btn-read-results').addEventListener('click', () => speak(resultsText(), $('#letter-msg')));
    $('#btn-play-script').addEventListener('click', () => speak($('#script-text').value, $('#letter-msg')));
    $('#btn-stop').addEventListener('click', () => { stopSpeaking(); setMsg($('#letter-msg'), 'Stopped.'); });

    if (window.ResizeObserver) new ResizeObserver(() => drawConnectors()).observe($('#recon'));
    window.addEventListener('resize', () => requestAnimationFrame(drawConnectors));
    const reconDetails = $('#recon-details');
    if (reconDetails) reconDetails.addEventListener('toggle', () => requestAnimationFrame(drawConnectors));
    $$('.table-scroll').forEach((el) => el.addEventListener('scroll', () => requestAnimationFrame(drawConnectors)));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawConnectors());
  }

  function showFatal(text) {
    $('#result-h').textContent = text;
    $('#reviewing').textContent = 'Something went wrong';
  }

  // Exposed for the dispute and call-practice module (disputes.js on the page).
  window.SecondLook = {
    state, api, money, esc, speak, stopSpeaking, announce, setMsg, shortDate, clone,
    loadCase: (id) => loadCase(id), fillCaseSelect: (p) => fillCaseSelect(p), useDocuments: (d) => useDocuments(d),
  };

  async function start() {
    initSettings();
    bind();
    pref('demo', '0'); // an old saved "demo mode" choice no longer applies
    // "Try an example" (no account) opens on Maya's fictional bill; signed-in people start at the upload step.
    const exampleVisit = Boolean(window.SecondLookAuth && window.SecondLookAuth.isGuest());
    try {
      const st = await api('/api/status').catch(() => null);
      if (st) state.status = st;
      await loadCaseList();
      if (exampleVisit) await loadCase('case-01');
      else renderEmpty();
    } catch (e) {
      if (DEMO) {
        setDemo(true);
        announce("We couldn't reach the server, so we're showing a saved example.");
      } else showFatal(e.message);
    }
    loadScoreboard();
  }

  start();
})();
