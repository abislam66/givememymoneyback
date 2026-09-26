// Sidebar navigation (compact top navigation on phones): marks the section on screen (aria-current),
// shows its name in the top bar, and shows small status badges read from what the page already rendered.
// Also: "Try demo", the dispute letter button, and the no-key note on the upload cards. Computes no money itself.

(() => {
  'use strict';

  const SL = window.SecondLook;
  const nav = document.getElementById('steps-nav');
  if (!SL || !nav) return;
  const { state, money } = SL;
  const $ = (sel) => document.querySelector(sel);
  const links = [...nav.querySelectorAll('a[data-step]')];
  const phone = window.matchMedia('(max-width: 899px)');

  // Keep jump targets and keyboard focus clear of whatever is sticky: the top bar on desktop, the compact nav on phones.
  const setStickyHeight = () => {
    const el = phone.matches ? $('#sidebar') : $('#topbar');
    document.documentElement.style.setProperty('--sticky-h', `${el ? el.offsetHeight : 0}px`);
  };
  setStickyHeight();
  window.addEventListener('resize', setStickyHeight);
  new MutationObserver(setStickyHeight).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  function setCurrent(id) {
    links.forEach((a) => {
      const on = a.dataset.step === id;
      if (on) {
        a.setAttribute('aria-current', 'location');
        $('#topbar-title').textContent = a.dataset.title;
        if (phone.matches && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else a.removeAttribute('aria-current');
    });
  }

  // The section crossing the upper third of the screen is the current one.
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => seen.set(e.target.id, e.isIntersecting));
    const first = links.find((a) => seen.get(a.dataset.step));
    if (first) setCurrent(first.dataset.step);
  }, { rootMargin: '-30% 0px -65% 0px' });
  links.forEach((a) => { const s = document.getElementById(a.dataset.step); if (s) io.observe(s); });
  setCurrent('step-upload');

  function badge(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = `sn-badge${kind ? ` ${kind}` : ''}`;
  }

  function update() {
    // The upload cards are always shown, so the "no Gemini key" note follows the server status here.
    $('#upload-nokey').hidden = Boolean(state.status && state.status.gemini) && !state.demo;
    const reviewing = !$('#review').hidden;
    badge('sn-upload', state.caseId ? 'Test bill' : (state.result ? 'Your papers' : ''));
    badge('sn-review', reviewing ? 'Check the numbers' : (state.caseId ? 'Not needed' : (state.result ? 'Done' : '')), reviewing ? 'warn' : '');
    const r = state.result;
    if (!r) return;
    const n = r.flags.length;
    badge('sn-results', `${n ? `${n} ${n === 1 ? 'problem' : 'problems'}` : 'No problems'} · owe ${money(r.summary.likely_owe)}`);
    const saved = document.getElementById('tile-confirmed');
    const v = saved && saved.querySelector('.v');
    badge('sn-dispute', v ? `Saved ${v.textContent}` : (n ? 'Letter ready' : ''));
  }

  // Tiles are rewritten on every render, and the dispute tracker adds the confirmed-savings tile there.
  const tiles = $('#tiles');
  if (tiles) new MutationObserver(update).observe(tiles, { childList: true });
  new MutationObserver(update).observe($('#review'), { attributes: true, attributeFilter: ['hidden'] });
  $('#btn-demo').addEventListener('click', () => setTimeout(update, 0));
  update();

  // "Try demo": load Maya's ER bill (the hero case) and go to the results.
  const tryDemo = $('#btn-try-demo');
  if (tryDemo) {
    tryDemo.addEventListener('click', () => {
      const everyone = document.querySelector('#people-row input[value="all"]');
      if (everyone && !everyone.checked) everyone.click();
      const sel = $('#case-select');
      const go = () => $('#step-results').scrollIntoView({ block: 'start' });
      if (sel && sel.value !== 'case-01' && sel.querySelector('option[value="case-01"]')) {
        sel.value = 'case-01';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(go, 400);
      } else go();
    });
  }

  // "Create dispute letter": show the letter and call script only when asked for.
  const openBtn = $('#btn-letter-open');
  const panel = $('#letter-panel');
  if (openBtn && panel) {
    openBtn.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      openBtn.setAttribute('aria-expanded', String(open));
      openBtn.textContent = open ? 'Hide dispute letter' : 'Create dispute letter';
      if (open) {
        panel.scrollIntoView({ block: 'start' });
        const tab = $('#tab-letter');
        if (tab) tab.focus();
      }
    });
  }
})();
