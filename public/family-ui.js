// "Total saved" pill in the top bar. The number comes from /api/family (resolved disputes only, for this person);
// potential savings are always shown apart from it, on the results.

(() => {
  'use strict';

  const SL = window.SecondLook;
  if (!SL) return;
  const { api, money } = SL;

  async function refresh() {
    try {
      const family = await api('/api/family');
      const pill = document.getElementById('total-saved');
      if (!pill) return;
      pill.hidden = false;
      pill.textContent = `Total saved: ${money(family.total_saved)}`;
      pill.title = 'Counts resolved disputes only';
    } catch (e) { /* the pill just stays hidden */ }
  }

  window.SecondLookRefreshFamily = refresh;
  refresh();
})();
