// Family Bill Manager and Cost History. Numbers come from /api/family (documents + rules + disputes).
// Total saved counts resolved disputes only; potential savings are always shown apart from it.
// The Family section is hidden on the main page (its bills are fictional); /classic/ still shows it.
// Here this file only keeps the "Total saved" pill in the top bar up to date.

(() => {
  'use strict';

  const SL = window.SecondLook;
  if (!SL) return;
  const { state, api, money, esc, setMsg, shortDate, announce } = SL;
  const $ = (sel) => document.querySelector(sel);

  const ORDER = { self: 0, spouse: 1, child: 2, parent: 3 };
  let family = null;
  let selected = 'all';

  const STATUS = {
    draft: 'Tracking (letter not sent)',
    sent: 'Letter sent',
    follow_up_due: 'Follow-up due',
  };

  function people() {
    return family ? [...family.people].sort((a, b) => (ORDER[a.profile.relation] ?? 9) - (ORDER[b.profile.relation] ?? 9)) : [];
  }

  function renderPill() {
    const pill = $('#total-saved');
    if (!pill) return;
    pill.hidden = false;
    pill.textContent = `Total saved: ${money(family.total_saved)}`;
    pill.title = 'Counts resolved disputes only';
  }

  function renderPeople() {
    const list = people();
    const opt = (id, name, note) => `<label class="person"><input type="radio" name="person" id="person-${esc(id)}" value="${esc(id)}"${selected === id ? ' checked' : ''}><span>${esc(name)}${note ? ` <small>${esc(note)}</small>` : ''}</span></label>`;
    $('#people-row').innerHTML = opt('all', 'Everyone', `${family.family.claims} claims`)
      + list.map((p) => opt(p.profile.id, p.profile.name.split(' ')[0], p.profile.relation)).join('');
  }

  function disputeText(c) {
    if (!c.dispute) return c.findings ? 'Not tracked yet' : 'Nothing to dispute';
    if (c.dispute.status === 'resolved') return `Resolved: saved ${money(c.dispute.confirmed_savings)}`;
    return `${STATUS[c.dispute.status] || c.dispute.status} (${money(c.dispute.disputed_amount)} disputed)`;
  }

  function renderClaims() {
    const list = people().filter((p) => selected === 'all' || p.profile.id === selected);
    const claims = list.flatMap((p) => p.claims);
    const who = selected === 'all' ? 'the family' : `${list[0] ? list[0].profile.name.split(' ')[0] : ''}'s`;
    $('#claims-summary').textContent = selected === 'all' ? `See all of the family's claims (${claims.length})` : `See all of ${who} claims (${claims.length})`;
    $('#claims-table').innerHTML = `<caption class="sr-only">Claims for ${esc(selected === 'all' ? 'the whole family' : who.replace(/'s$/, ''))}</caption>
      <thead><tr><th scope="col">Claim</th><th scope="col">Who</th><th scope="col" class="r">Bill said</th><th scope="col" class="r">Likely owe</th><th scope="col">Problems found</th><th scope="col">Dispute</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
      <tbody>${claims.map((c) => {
        const current = c.case_id === state.caseId;
        return `<tr class="${current ? 'current' : ''}">
          <td><b>${esc(c.title.replace(/^[^,]+,\s*/, ''))}</b><br><span class="msg">${esc(shortDate(c.service_date))} · ${esc(c.provider)} · ${esc(c.claim_number)}</span></td>
          <td>${esc(c.profile.name.split(' ')[0])}</td>
          <td class="r">${money(c.amount_due)}</td><td class="r">${money(c.likely_owe)}</td>
          <td>${c.findings ? `${c.findings} ${c.findings === 1 ? 'problem' : 'problems'}` : 'None'}</td>
          <td>${esc(disputeText(c))}</td>
          <td>${current ? '<b>Showing now</b>' : `<button type="button" class="btn small ghost" data-review="${esc(c.case_id)}">Review<span class="sr-only"> ${esc(c.title)}</span></button>`}</td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  function renderCost() {
    const cols = [
      ['billed', 'Billed'], ['allowed', 'Allowed'], ['insurer_paid', 'Insurer paid'],
      ['patient_resp', 'Your share'], ['patient_payments', 'You paid'], ['disputed', 'Disputed'],
      ['potential_savings', 'Potential'], ['confirmed_savings', 'Saved'],
    ];
    const cell = (t, k) => `<td class="r${k === 'potential_savings' ? ' pot' : ''}${k === 'confirmed_savings' ? ' conf' : ''}">${money(t[k])}</td>`;
    const rows = people().map((p) => `<tr class="${selected === p.profile.id ? 'selected' : ''}">
        <th scope="row">${esc(p.profile.name.split(' ')[0])} <span class="msg">(${esc(p.profile.relation)})${selected === p.profile.id ? ', selected' : ''}</span></th>
        <td class="r">${p.totals.claims}</td>${cols.map(([k]) => cell(p.totals, k)).join('')}</tr>`);
    if (family.uploads.disputes) {
      rows.push(`<tr><th scope="row">Your uploads</th><td class="r">${family.uploads.disputes}</td>${cols.map(([k]) => `<td class="r${k === 'confirmed_savings' ? ' conf' : ''}">${k === 'confirmed_savings' ? money(family.uploads.confirmed_savings) : '–'}</td>`).join('')}</tr>`);
    }
    rows.push(`<tr class="family"><th scope="row">Whole family</th><td class="r">${family.family.claims}</td>${cols.map(([k]) => cell(family.family, k)).join('')}</tr>`);
    $('#cost-table').innerHTML = `<caption class="sr-only">Cost history and savings for each family member</caption>
      <thead><tr><th scope="col">Person</th><th scope="col" class="r">Claims</th>${cols.map(([, label]) => `<th scope="col" class="r">${esc(label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>`;
    $('#family-saved').textContent = money(family.total_saved);
    $('#family-saved-box').classList.toggle('is-saved', family.total_saved > 0);
    $('#family-potential').textContent = money(family.family.potential_savings);
  }

  const hasFamily = Boolean(document.getElementById('family-section'));

  function renderAll() {
    if (!family) return;
    renderPill();
    if (!hasFamily) return;
    renderPeople();
    renderClaims();
    renderCost();
  }

  async function refresh() {
    try {
      family = await api('/api/family');
      if (hasFamily) setMsg($('#family-msg'), '');
      renderAll();
    } catch (e) {
      if (hasFamily) setMsg($('#family-msg'), "Family totals aren't available right now. Is the server running?", 'err');
    }
  }

  async function choose(id) {
    selected = id;
    SL.fillCaseSelect(id === 'all' ? null : id);
    renderAll();
    const person = people().find((p) => p.profile.id === id);
    if (person && !person.claims.some((c) => c.case_id === state.caseId)) {
      await SL.loadCase(person.claims[0].case_id);
    }
    const r = document.getElementById(`person-${id}`);
    if (r) r.focus();
    announce(id === 'all' ? "Showing the whole family's bills." : `Showing ${person ? person.profile.name : ''}'s bills. Reviewing ${state.title}.`);
  }

  // ---------- hooks ----------
  const prevAfter = window.SecondLookAfterRender;
  window.SecondLookAfterRender = (s) => {
    if (typeof prevAfter === 'function') prevAfter(s);
    if (family && hasFamily) renderClaims();
  };
  window.SecondLookRefreshFamily = refresh;

  document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'person') choose(e.target.value);
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-review]');
    if (!b) return;
    await SL.loadCase(b.dataset.review);
    $('#result').scrollIntoView({ block: 'start' });
    announce(`Reviewing ${state.title}.`);
  });

  refresh();
})();
