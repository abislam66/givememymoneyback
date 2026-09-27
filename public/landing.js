// Start page: type a name -> a name-only account for this browser -> the dashboard.
// Returning visitors get "Continue". "Try an example" needs no account and saves nothing.

(() => {
  'use strict';

  const A = window.SecondLookAuth;
  const $ = (sel) => document.querySelector(sel);
  const form = $('#start-form');
  const msg = $('#start-msg');
  const say = (text, kind) => { msg.textContent = text || ''; msg.className = `msg${kind ? ` ${kind}` : ''}`; };

  function showBack(s) {
    form.hidden = true;
    $('#back').hidden = false;
    $('#back-name').textContent = s.user.name;
    $('#switch-name').textContent = s.user.name;
  }

  const s = A.current();
  if (s) showBack(s);

  $('#btn-switch').addEventListener('click', () => {
    $('#back').hidden = true;
    form.hidden = false;
    $('#switch-note').hidden = false;
    $('#back').after($('#switch-note'));
    $('#name').focus();
  });

  // Tell people early if this server can't save accounts; the examples still work.
  A.config().then((c) => {
    if (c.accounts) return;
    $('#btn-start').disabled = true;
    $('#name').disabled = true;
    say("Saving isn't set up on this server yet. You can still try an example below.", 'err');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    if (!name) { say('Type your first name first.', 'err'); $('#name').focus(); return; }
    const btn = $('#btn-start');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    say('Setting up your account…');
    try {
      await A.signIn(name);
      say(`Welcome, ${name}! Opening your dashboard…`, 'good');
      location.assign('/app.html');
    } catch (err) {
      say(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Get started';
    }
  });

  // "Get started" further down the page moves focus into the name field.
  $('#cta-start').addEventListener('click', (e) => {
    e.preventDefault();
    $('#start').scrollIntoView({ block: 'center' });
    const target = form.hidden ? $('#btn-continue') : $('#name');
    target.focus({ preventScroll: true });
  });
})();
