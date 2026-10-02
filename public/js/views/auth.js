import { api, view, esc, toast, go, session, action, $ } from '../lib.js';

function nextHash(q) {
  const n = q.get('next');
  return n && n.startsWith('#/') && !n.startsWith('#/login') ? n : '#/';
}

function authCard(title, inner, foot) {
  view.innerHTML = `<div class="auth-wrap"><div class="card">
    <h1>${title}</h1>${inner}</div>${foot ? `<p class="center muted">${foot}</p>` : ''}</div>`;
}

export function loginView(q) {
  const next = nextHash(q);
  authCard('Log in', `
    <form id="f" class="stack">
      <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block">Log in</button>
      <a href="#/forgot">Forgot password?</a>
    </form>`, `New here? <a href="#/signup?next=${encodeURIComponent(next)}">Create an account</a>`);
  $('#f').addEventListener('submit', action(async (e) => {
    const { user } = await api('POST', '/api/auth/login', Object.fromEntries(new FormData(e.target)));
    session.user = user;
    go(next);
  }));
}

export function signupView(q) {
  const next = nextHash(q);
  authCard('Create your account', `
    <form id="f" class="stack">
      <div><label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="40" required></div>
      <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="hint">At least 8 characters</span></div>
      <button class="btn block">Sign up</button>
    </form>`, `Already have an account? <a href="#/login?next=${encodeURIComponent(next)}">Log in</a>`);
  $('#f').addEventListener('submit', action(async (e) => {
    const { user } = await api('POST', '/api/auth/signup', Object.fromEntries(new FormData(e.target)));
    session.user = user;
    toast(`Welcome, ${user.name}!`);
    go(next);
  }));
}

export function forgotView() {
  authCard('Reset your password', `
    <form id="f" class="stack">
      <p class="muted">Enter your email and we'll send you a link to reset your password.</p>
      <div><label for="email">Email</label><input id="email" name="email" type="email" required></div>
      <button class="btn block">Send reset link</button>
    </form>`, '<a href="#/login">Back to log in</a>');
  $('#f').addEventListener('submit', action(async (e) => {
    await api('POST', '/api/auth/forgot', Object.fromEntries(new FormData(e.target)));
    $('#f').innerHTML = '<p>If that email has an account, a reset link is on its way. Check your inbox.</p>';
  }));
}

export function resetView(q) {
  authCard('Choose a new password', `
    <form id="f" class="stack">
      <div><label for="pw">New password</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn block">Save password</button>
    </form>`);
  $('#f').addEventListener('submit', action(async (e) => {
    const { user } = await api('POST', '/api/auth/reset', { token: q.get('token'), password: new FormData(e.target).get('password') });
    session.user = user;
    toast('Password updated');
    go('#/');
  }));
}

export function accountView() {
  const u = session.user;
  view.innerHTML = `<h1>Account</h1>
    <div class="grid-2">
      <div class="card"><h2>Profile</h2>
        <form id="profile" class="stack">
          <div><label>Email</label><input value="${esc(u.email)}" disabled></div>
          <div><label for="name">Name</label><input id="name" name="name" value="${esc(u.name)}" maxlength="40" required></div>
          <button class="btn">Save</button>
        </form></div>
      <div class="card"><h2>Change password</h2>
        <form id="pw" class="stack">
          <div><label for="cur">Current password</label><input id="cur" name="current_password" type="password" autocomplete="current-password" required></div>
          <div><label for="new">New password</label><input id="new" name="new_password" type="password" autocomplete="new-password" minlength="8" required></div>
          <button class="btn">Change password</button>
        </form></div>
    </div>`;
  $('#profile').addEventListener('submit', action(async (e) => {
    session.user = (await api('PATCH', '/api/auth/account', Object.fromEntries(new FormData(e.target)))).user;
    toast('Saved');
  }));
  $('#pw').addEventListener('submit', action(async (e) => {
    await api('PATCH', '/api/auth/account', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    toast('Password changed');
  }));
}
