// MFL Fantasy single-page app. Hash routes:
//   #/login #/signup #/forgot #/reset?token= #/account
//   #/                    my leagues (create / join)
//   #/join/:code          join a league from an invite link
//   #/l/:id               league home: scoreboard, standings, activity
//   #/l/:id/team/:tid     roster + lineup
//   #/l/:id/matchup/:mid  head-to-head
//   #/l/:id/players       player pool, adds, waiver claims
//   #/l/:id/trades        propose / respond to trades
//   #/l/:id/draft         live draft room
//   #/l/:id/settings      team + commissioner settings
//   #/admin/:tab          MFL site admin
import { api, view, esc, go, session, toast, runLeaveHooks } from './lib.js';
import { loginView, signupView, forgotView, resetView, accountView } from './views/auth.js';
import { homeView, joinView } from './views/home.js';
import { leagueHome, teamView, matchupView, playersView, tradesView, settingsView } from './views/league.js';
import { draftView } from './views/draft.js';
import { adminView } from './views/admin.js';

const PUBLIC = new Set(['login', 'signup', 'forgot', 'reset']);

function renderTopbar() {
  const u = session.user;
  document.getElementById('nav').innerHTML = u
    ? `<a href="#/">My leagues</a>${u.isAdmin ? '<a href="#/admin">MFL admin</a>' : ''}`
    : '';
  document.getElementById('auth').innerHTML = u
    ? `<a href="#/account" class="muted">${esc(u.name)}</a><button class="btn ghost small" id="logout">Log out</button>`
    : '<a class="btn small" href="#/login">Log in</a>';
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    session.user = null;
    session.mfl = null;
    toast('Logged out');
    go('#/login');
  });
  const hash = location.hash || '#/';
  document.querySelectorAll('#nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '#/' ? hash === '#/' || hash.startsWith('#/l/') : hash.startsWith(href));
  });
}

async function route() {
  runLeaveHooks();
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  const name = parts[0] || 'home';

  try {
    if (session.user === undefined) session.user = (await api('GET', '/api/auth/me')).user;
    if (!session.user && !PUBLIC.has(name)) {
      go(`#/login?next=${encodeURIComponent(location.hash || '#/')}`);
      return;
    }
    if (session.user && PUBLIC.has(name) && name !== 'reset') {
      go(q.get('next') || '#/');
      return;
    }
    if (session.user && !session.mfl) session.mfl = await api('GET', '/api/mfl');
    renderTopbar();

    if (name === 'login') return loginView(q);
    if (name === 'signup') return signupView(q);
    if (name === 'forgot') return forgotView();
    if (name === 'reset') return resetView(q);
    if (name === 'account') return accountView();
    if (name === 'join') return await joinView(parts[1]);
    if (name === 'admin') return await adminView(parts[1], q);
    if (name === 'l') {
      // refresh the shared calendar so week state is current on league pages
      session.mfl = await api('GET', '/api/mfl');
      const [id, sub, sid] = [parts[1], parts[2], parts[3]];
      if (sub === 'team') return await teamView(id, sid, q);
      if (sub === 'matchup') return await matchupView(id, sid);
      if (sub === 'players') return await playersView(id, q);
      if (sub === 'trades') return await tradesView(id, q);
      if (sub === 'draft') return await draftView(id);
      if (sub === 'settings') return await settingsView(id);
      return await leagueHome(id, q);
    }
    return await homeView();
  } catch (ex) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="error">${esc(ex.message)}</p><a href="#/">Back to my leagues</a></div>`;
  }
}

session.user = undefined; // unknown until /me answers
window.addEventListener('hashchange', route);
route();
