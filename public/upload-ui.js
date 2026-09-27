// Live document upload: choose or drop a bill and an EOB (PDF, PNG, JPG) -> Gemini reads them
// (same /api/extract pipeline the extraction scoreboard uses) -> the person reviews and corrects every
// number -> "Confirm & Analyze" hands the documents to the deterministic rules engine.
// Without a Gemini key, the same review screen opens blank so the numbers can be typed in.

(() => {
  'use strict';

  const SL = window.SecondLook;
  const V = window.SecondLookValidate;
  if (!SL || !V) return;
  const { state, api, esc, setMsg, announce, clone } = SL;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const MAX_BYTES = 12e6;
  // Hosting limits a request to about 4.5 MB, and a file grows by a third when sent as text (base64).
  // So big photos are resized in the browser first, and PDFs (which we can't shrink here) must be 3 MB or less.
  const MAX_PDF_BYTES = 3e6;
  const MAX_SEND_BYTES = 3e6;
  const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  const files = { bill: null, eob: null };
  let draft = null; // { bill, eob } being reviewed

  // ---------- choosing files ----------
  function mimeOf(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (TYPES[ext]) return TYPES[ext];
    return Object.values(TYPES).includes(file.type) ? file.type : null;
  }

  function setFile(doc, file) {
    const msg = $('#upload-msg');
    const box = $(`#drop-${doc}`);
    if (!file) return;
    if (!mimeOf(file)) { setMsg(msg, `${file.name} isn't a PDF, PNG or JPG. Please choose one of those.`, 'err'); return; }
    if (file.size > MAX_BYTES) { setMsg(msg, `${file.name} is larger than 12 MB. Please use a smaller file.`, 'err'); return; }
    if (mimeOf(file) === 'application/pdf' && file.size > MAX_PDF_BYTES) { setMsg(msg, `${file.name} is larger than 3 MB. Please use a smaller PDF, or a photo or screenshot of each page.`, 'err'); return; }
    files[doc] = file;
    box.classList.add('has-file');
    $(`#name-${doc}`).textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
    setMsg(msg, '');
  }

  function bindDrop(doc) {
    const box = $(`#drop-${doc}`);
    const input = $(`#file-${doc}`);
    input.addEventListener('change', () => setFile(doc, input.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('over'); }));
    ['dragleave', 'dragend'].forEach((ev) => box.addEventListener(ev, () => box.classList.remove('over')));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        try { input.files = e.dataTransfer.files; } catch (err) { /* older browsers: the name label still shows the file */ }
        setFile(doc, f);
      }
    });
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error(`We couldn't open ${file.name}.`));
      r.readAsDataURL(file);
    });
  }

  // Photos over the limit are redrawn smaller as a JPEG (in the browser; nothing is saved).
  async function prepare(file) {
    const mime = mimeOf(file);
    if (mime === 'application/pdf' || file.size <= MAX_SEND_BYTES) return { b64: await readAsBase64(file), mime };
    let img;
    try { img = await createImageBitmap(file); } catch (e) { throw new Error(`We couldn't open ${file.name}. Try a different photo.`); }
    for (const side of [2400, 1800, 1400]) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob && blob.size <= MAX_SEND_BYTES) return { b64: await readAsBase64(blob), mime: 'image/jpeg' };
    }
    throw new Error(`${file.name} is too big to send. Please use a smaller photo.`);
  }

  // ---------- reading with Gemini ----------
  async function onRead(e) {
    e.preventDefault();
    const msg = $('#upload-msg');
    if (!files.bill || !files.eob) { setMsg(msg, 'Please choose both files: your bill and your EOB.', 'err'); return; }
    if (state.demo) { setMsg(msg, "We can't reach the server right now, so we can't read documents. Try again soon, or type the numbers in yourself.", 'err'); return; }
    $('#btn-read').disabled = true;
    setMsg(msg, 'Reading your documents with Gemini. This can take up to 20 seconds…');
    try {
      const [pb, pe] = await Promise.all([prepare(files.bill), prepare(files.eob)]);
      const [rb, re] = await Promise.allSettled([
        api('/api/extract', { image_base64: pb.b64, mime_type: pb.mime, doc_type: 'bill' }, { timeout: 45000 }),
        api('/api/extract', { image_base64: pe.b64, mime_type: pe.mime, doc_type: 'eob' }, { timeout: 45000 }),
      ]);
      const failed = [rb, re].filter((r) => r.status === 'rejected');
      if (failed.length === 2 && failed.every((r) => r.reason.status === 501)) {
        setMsg(msg, `${rb.reason.message} Press "Type the numbers in myself" to continue without it.`, 'err');
        return;
      }
      const errs = [];
      if (rb.status === 'rejected') errs.push(`Bill: ${rb.reason.message}`);
      if (re.status === 'rejected') errs.push(`EOB: ${re.reason.message}`);
      openReview({
        bill: rb.status === 'fulfilled' ? rb.value.bill : blankBill(),
        eob: re.status === 'fulfilled' ? re.value.eob : blankEob(),
        warnings: [...(rb.value ? rb.value.warnings || [] : []), ...(re.value ? re.value.warnings || [] : [])],
        source: errs.length ? 'partial' : 'gemini',
      });
      setMsg(msg, errs.length ? `${errs.join(' ')} You can type in what's missing below.` : 'Done reading. Please check the numbers below.', errs.length ? 'err' : 'good');
    } catch (err) {
      setMsg(msg, err.message, 'err');
    } finally {
      $('#btn-read').disabled = false;
    }
  }

  // ---------- review screen ----------
  function blankBill() {
    return { provider: { name: '', address: '' }, patient: { name: '' }, account_number: '', statement_date: '',
      lines: [{ line_no: 1, date: '', code: '', description: '', units: 1, charge: '' }],
      adjustments: [], insurance_payments: [], patient_payments: [], previous_balance: 0, printed_total_charges: null, amount_due: '' };
  }
  function blankEob() {
    return { insurer: '', member: { name: '', id: '' }, claim_number: '', provider_name: '', network: 'in-network', service_type: '',
      lines: [{ date: '', code: '', description: '', units: 1, billed: '', allowed: '', insurer_paid: '', patient_resp: '' }],
      totals: { billed: '', allowed: '', insurer_paid: '', patient_resp: '' } };
  }

  const total = (arr) => Math.round((arr || []).reduce((t, x) => t + (Number(x.amount) || 0), 0) * 100) / 100;
  const idOf = (path) => `rv-${path.replace(/\./g, '-')}`;

  // Read and write draft values by path. The three "_total" fields collapse lists into one editable number.
  function getPath(path) {
    const [doc, ...rest] = path.split('.');
    const d = draft[doc];
    if (rest[0] === 'adjustments_total') return total(d.adjustments);
    if (rest[0] === 'insurance_payments_total') return total(d.insurance_payments);
    if (rest[0] === 'patient_payments_total') return total(d.patient_payments);
    return rest.reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), d);
  }
  function setPath(path, value) {
    const [doc, ...rest] = path.split('.');
    const d = draft[doc];
    const n = value === '' ? '' : Number(value);
    if (rest[0] === 'adjustments_total') { d.adjustments = n > 0 ? [{ description: 'Contractual adjustment', amount: n }] : []; return; }
    if (rest[0] === 'insurance_payments_total') { d.insurance_payments = n > 0 ? [{ date: d.statement_date || '', payer: (draft.eob && draft.eob.insurer) || 'Insurance', amount: n }] : []; return; }
    if (rest[0] === 'patient_payments_total') { d.patient_payments = n > 0 ? [{ date: d.statement_date || '', amount: n }] : []; return; }
    let o = d;
    for (let i = 0; i < rest.length - 1; i += 1) {
      if (o[rest[i]] === undefined || o[rest[i]] === null) o[rest[i]] = {};
      o = o[rest[i]];
    }
    o[rest[rest.length - 1]] = value;
  }

  const val = (v) => (v === undefined || v === null ? '' : esc(v));
  function input(path, label, { type = 'text', cls = '', srOnly = false, step } = {}) {
    const id = idOf(path);
    const v = getPath(path);
    return `<div class="field"><label for="${id}" class="${srOnly ? 'sr-only' : ''}">${esc(label)}</label>
      <input id="${id}" data-path="${esc(path)}" type="${type}" class="${cls}" ${step ? `step="${step}"` : ''} ${type === 'number' ? 'inputmode="decimal"' : ''} value="${val(v)}"></div>`;
  }
  function cellInput(path, label, { type = 'text', cls = '', step } = {}) {
    const id = idOf(path);
    return `<label for="${id}" class="sr-only">${esc(label)}</label><input id="${id}" data-path="${esc(path)}" type="${type}" class="${cls}" ${step ? `step="${step}"` : ''} ${type === 'number' ? 'inputmode="decimal"' : ''} value="${val(getPath(path))}">`;
  }
  function select(path, label, options) {
    const id = idOf(path);
    const v = getPath(path);
    return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" data-path="${esc(path)}">
      <option value=""${v ? '' : ' selected'}>Choose…</option>${options.map(([k, t]) => `<option value="${k}"${v === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  function renderReview() {
    const b = draft.bill;
    const e = draft.eob;
    const billRows = b.lines.map((_, i) => `<tr>
      <td>${i + 1}</td>
      <td>${cellInput(`bill.lines.${i}.date`, `Bill line ${i + 1} date`, { type: 'date', cls: 'rv-date' })}</td>
      <td>${cellInput(`bill.lines.${i}.code`, `Bill line ${i + 1} code`)}</td>
      <td>${cellInput(`bill.lines.${i}.description`, `Bill line ${i + 1} description`, { cls: 'rv-desc' })}</td>
      <td>${cellInput(`bill.lines.${i}.units`, `Bill line ${i + 1} units`, { type: 'number', cls: 'rv-num', step: 'any' })}</td>
      <td>${cellInput(`bill.lines.${i}.charge`, `Bill line ${i + 1} charge`, { type: 'number', cls: 'rv-num', step: '0.01' })}</td>
      <td><button type="button" class="btn small ghost" data-remove="bill.${i}" id="rm-bill-${i}">Remove<span class="sr-only"> bill line ${i + 1}</span></button></td></tr>`).join('');
    const eobRows = e.lines.map((_, i) => `<tr>
      <td>${i + 1}</td>
      <td>${cellInput(`eob.lines.${i}.date`, `EOB line ${i + 1} date`, { type: 'date', cls: 'rv-date' })}</td>
      <td>${cellInput(`eob.lines.${i}.code`, `EOB line ${i + 1} code`)}</td>
      <td>${cellInput(`eob.lines.${i}.description`, `EOB line ${i + 1} description`, { cls: 'rv-desc' })}</td>
      <td>${cellInput(`eob.lines.${i}.units`, `EOB line ${i + 1} units`, { type: 'number', cls: 'rv-num', step: 'any' })}</td>
      ${['billed', 'allowed', 'insurer_paid', 'patient_resp'].map((k) => `<td>${cellInput(`eob.lines.${i}.${k}`, `EOB line ${i + 1} ${k.replace('_', ' ')}`, { type: 'number', cls: 'rv-num', step: '0.01' })}</td>`).join('')}
      <td><button type="button" class="btn small ghost" data-remove="eob.${i}" id="rm-eob-${i}">Remove<span class="sr-only"> EOB line ${i + 1}</span></button></td></tr>`).join('');

    $('#review-form').innerHTML = `
      <fieldset><legend>Your bill</legend>
        <div class="rv-grid">
          ${input('bill.provider.name', 'Provider')}${input('bill.patient.name', 'Patient')}
          ${input('bill.account_number', 'Account number')}${input('bill.statement_date', 'Statement date', { type: 'date' })}
        </div>
        <div class="table-scroll" role="region" aria-label="Bill lines to review" tabindex="0">
          <table class="rv-lines"><caption class="sr-only">Bill lines</caption>
            <thead><tr><th>#</th><th>Date</th><th>Code</th><th>Description</th><th>Units</th><th>Charge ($)</th><th><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>${billRows}</tbody></table></div>
        <div class="row"><button type="button" class="btn small ghost" data-add="bill" id="add-bill">Add a bill line</button></div>
        <div class="rv-grid">
          ${input('bill.printed_total_charges', 'Total charges printed on the bill (optional)', { type: 'number', step: '0.01' })}
          ${input('bill.adjustments_total', 'Adjustments / discounts', { type: 'number', step: '0.01' })}
          ${input('bill.insurance_payments_total', 'Insurance payments', { type: 'number', step: '0.01' })}
          ${input('bill.patient_payments_total', 'Your payments', { type: 'number', step: '0.01' })}
          ${input('bill.previous_balance', 'Previous balance', { type: 'number', step: '0.01' })}
          ${input('bill.amount_due', 'Amount due', { type: 'number', step: '0.01' })}
        </div>
      </fieldset>
      <fieldset><legend>Your insurer's statement (EOB)</legend>
        <div class="rv-grid">
          ${input('eob.insurer', 'Insurer')}${input('eob.claim_number', 'Claim number')}
          ${select('eob.network', 'Network', [['in-network', 'In network'], ['out-of-network', 'Out of network']])}
          ${select('eob.service_type', 'Type of care', [['emergency', 'Emergency room'], ['office', 'Office visit'], ['imaging', 'Imaging (X-ray, CT, MRI)'], ['lab', 'Lab tests'], ['therapy', 'Therapy']])}
        </div>
        <div class="table-scroll" role="region" aria-label="EOB lines to review" tabindex="0">
          <table class="rv-lines"><caption class="sr-only">EOB lines</caption>
            <thead><tr><th>#</th><th>Date</th><th>Code</th><th>Description</th><th>Units</th><th>Billed</th><th>Allowed</th><th>Insurer paid</th><th>Your share</th><th><span class="sr-only">Remove</span></th></tr></thead>
            <tbody>${eobRows}</tbody></table></div>
        <div class="row"><button type="button" class="btn small ghost" data-add="eob" id="add-eob">Add an EOB line</button></div>
        <div class="rv-grid">
          ${input('eob.totals.billed', 'Total billed', { type: 'number', step: '0.01' })}
          ${input('eob.totals.allowed', 'Total allowed', { type: 'number', step: '0.01' })}
          ${input('eob.totals.insurer_paid', 'Total insurer paid', { type: 'number', step: '0.01' })}
          ${input('eob.totals.patient_resp', 'Total your share', { type: 'number', step: '0.01' })}
        </div>
      </fieldset>`;
    runChecks();
  }

  // Numbers as numbers, for the checks and the rules.
  function finalDocs() {
    const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
    const b = clone(draft.bill);
    const e = clone(draft.eob);
    b.lines = b.lines.map((l, i) => ({ ...l, line_no: i + 1, code: String(l.code || '').trim().toUpperCase(), units: n(l.units) > 0 ? n(l.units) : 1, charge: n(l.charge) }));
    b.amount_due = n(b.amount_due);
    b.previous_balance = n(b.previous_balance) > 0 ? n(b.previous_balance) : 0;
    b.printed_total_charges = n(b.printed_total_charges) > 0 ? n(b.printed_total_charges) : null;
    e.lines = e.lines.map((l) => ({ ...l, code: String(l.code || '').trim().toUpperCase(), units: n(l.units) > 0 ? n(l.units) : 1,
      billed: n(l.billed), allowed: n(l.allowed), insurer_paid: n(l.insurer_paid), patient_resp: n(l.patient_resp) }));
    e.totals = Object.fromEntries(['billed', 'allowed', 'insurer_paid', 'patient_resp'].map((k) => [k, n((draft.eob.totals || {})[k])]));
    e.provider_name = e.provider_name || b.provider.name;
    return { bill: b, eob: e };
  }

  let lastIssues = [];
  function runChecks() {
    const { bill, eob } = finalDocs();
    const issues = V.checkAll(bill, eob);
    lastIssues = issues;
    const flagged = new Set(issues.flatMap((i) => i.fields));
    $$('#review-form [data-path]').forEach((el) => {
      const on = flagged.has(el.dataset.path);
      el.classList.toggle('needs-review', on);
      if (on) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', 'review-issues'); } else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
      const lab = document.querySelector(`label[for="${el.id}"]:not(.sr-only)`);
      if (lab) lab.classList.toggle('needs-review-label', on);
    });
    const box = $('#review-issues');
    if (issues.length) {
      box.className = 'review-issues bad';
      box.innerHTML = `<h5>Please review these numbers</h5><ul>${issues.map((i, k) => `<li>${esc(i.message)}${i.fields.length ? ` <button type="button" class="go" data-go="${k}">Go to it</button>` : ''}</li>`).join('')}</ul>`;
    } else {
      box.className = 'review-issues good';
      box.innerHTML = '<h5>Everything adds up</h5><p>Check the numbers against your papers, then press Confirm &amp; Analyze.</p>';
    }
  }

  // Signed-in users: the confirmed numbers (never the files) are saved once per review; analyzing again updates that save.
  let draftSource = 'upload';
  let draftSavedId = null;

  function openReview({ bill, eob, warnings = [], source }) {
    draft = { bill: clone(bill), eob: clone(eob) };
    draftSource = source === 'manual' ? 'manual' : 'upload';
    draftSavedId = null;
    if (!draft.bill.lines || !draft.bill.lines.length) draft.bill.lines = blankBill().lines;
    if (!draft.eob.lines || !draft.eob.lines.length) draft.eob.lines = blankEob().lines;
    draft.eob.totals = draft.eob.totals || blankEob().totals;
    $('#review').hidden = false;
    renderReview();
    const note = source === 'manual' ? 'Type the numbers from your bill and EOB.' : (warnings.length ? `Gemini's notes: ${warnings.join(' ')}` : '');
    setMsg($('#review-msg'), note);
    $('#review-h').focus();
    $('#review').scrollIntoView({ block: 'start' });
    announce(lastIssues.length ? `Please review ${lastIssues.length} ${lastIssues.length === 1 ? 'item' : 'items'} before analyzing.` : 'Check the numbers, then press Confirm and Analyze.');
  }

  async function analyze() {
    const { bill, eob } = finalDocs();
    if (!bill.lines.length || !eob.lines.length) { setMsg($('#review-msg'), 'Add at least one line to the bill and to the EOB.', 'err'); return; }
    const btn = $('#btn-analyze');
    btn.disabled = true;
    setMsg($('#review-msg'), lastIssues.length ? 'Analyzing. Some numbers still look off, so double-check the results.' : 'Analyzing…');
    try {
      // Blank numbers become 0 for the rules; the review step already pointed them out.
      const zero = (v) => (Number.isFinite(v) ? v : 0);
      bill.lines.forEach((l) => { l.charge = zero(l.charge); });
      bill.amount_due = zero(bill.amount_due);
      eob.lines.forEach((l) => { ['billed', 'allowed', 'insurer_paid', 'patient_resp'].forEach((k) => { l[k] = zero(l[k]); }); });
      Object.keys(eob.totals).forEach((k) => { eob.totals[k] = zero(eob.totals[k]); });
      delete bill.printed_total_charges;
      await SL.useDocuments({ bill, eob, title: 'Your uploaded bill' });
      let savedNote = '';
      if (window.SecondLookAccount) {
        const saved = await window.SecondLookAccount.save({ bill, eob, source: draftSource, id: draftSavedId });
        if (saved && saved.id) { draftSavedId = saved.id; savedNote = ' Saved to My analyses.'; }
        else if (saved && saved.error) savedNote = ` ${saved.error}`;
      }
      setMsg($('#review-msg'), `Analyzed.${savedNote} Your results are below. You can change numbers here and analyze again.`, 'good');
      $('#result').scrollIntoView({ block: 'start' });
      announce(`Analyzed. ${$('#result-h').textContent}`);
    } catch (e) {
      setMsg($('#review-msg'), e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- wire up ----------
  function init() {
    const toggle = $('#btn-upload-toggle');
    toggle.addEventListener('click', () => {
      const box = $('#upload-box');
      box.hidden = !box.hidden;
      toggle.setAttribute('aria-expanded', String(!box.hidden));
      $('#upload-nokey').hidden = Boolean(state.status && state.status.gemini) && !state.demo;
      if (!box.hidden) $('#file-bill').focus();
    });
    bindDrop('bill');
    bindDrop('eob');
    $('#upload-box').addEventListener('submit', onRead);
    $('#btn-manual').addEventListener('click', () => openReview({ bill: blankBill(), eob: blankEob(), source: 'manual' }));
    $('#btn-analyze').addEventListener('click', analyze);
    $('#btn-review-cancel').addEventListener('click', () => { $('#review').hidden = true; draft = null; $('#btn-upload-toggle').focus(); });

    const form = $('#review-form');
    form.addEventListener('input', (e) => {
      const p = e.target.dataset && e.target.dataset.path;
      if (!p || !draft) return;
      setPath(p, e.target.value);
      runChecks();
    });
    form.addEventListener('change', (e) => {
      const p = e.target.dataset && e.target.dataset.path;
      if (!p || !draft) return;
      setPath(p, e.target.value);
      runChecks();
    });
    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !draft) return;
      if (b.dataset.add) {
        const doc = b.dataset.add;
        const last = draft[doc].lines[draft[doc].lines.length - 1] || {};
        draft[doc].lines.push(doc === 'bill'
          ? { date: last.date || '', code: '', description: '', units: 1, charge: '' }
          : { date: last.date || '', code: '', description: '', units: 1, billed: '', allowed: '', insurer_paid: '', patient_resp: '' });
        renderReview();
        const el = document.getElementById(idOf(`${doc}.lines.${draft[doc].lines.length - 1}.code`));
        if (el) el.focus();
      } else if (b.dataset.remove) {
        const [doc, i] = b.dataset.remove.split('.');
        draft[doc].lines.splice(Number(i), 1);
        renderReview();
        const next = document.getElementById(`rm-${doc}-${Math.min(Number(i), draft[doc].lines.length - 1)}`) || document.getElementById(`add-${doc}`);
        if (next) next.focus();
      }
    });
    $('#review-issues').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-go]');
      if (!b) return;
      const issue = lastIssues[Number(b.dataset.go)];
      const el = issue && issue.fields.map((f) => document.getElementById(idOf(f))).find(Boolean);
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    });
  }

  init();
})();
