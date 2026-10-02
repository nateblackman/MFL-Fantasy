import { api, view, esc, toast, go, session, action, $ } from '../lib.js';

const STATUS = { predraft: 'Pre-draft', drafting: 'Drafting now', inseason: 'In season' };

export async function homeView() {
  const leagues = await api('GET', '/api/leagues');
  const cards = leagues.map((l) => `
    <a class="card league-card" href="#/l/${l.id}">
      <div><strong>${esc(l.name)}</strong>${l.isCommish ? ' <span class="pill">Commissioner</span>' : ''}</div>
      <div class="muted">${esc(l.team_name)} · ${l.team_count}/${l.max_teams} teams</div>
      <span class="pill ${l.status === 'drafting' ? 'live' : ''}">${STATUS[l.status]}</span>
    </a>`).join('');

  view.innerHTML = `
    <div class="page-head"><div><h1>My leagues</h1><span class="muted">Hi, ${esc(session.user.name)}. Week ${session.mfl.currentWeek} of the MFL season.</span></div></div>
    ${leagues.length ? `<div class="league-grid">${cards}</div>` : '<div class="card empty">You\'re not in any leagues yet. Create one or join with an invite code.</div>'}
    <div class="grid-2">
      <div class="card">
        <h2>Create a league</h2>
        <form id="create" class="stack">
          <div><label for="ln">League name</label><input id="ln" name="name" maxlength="40" required></div>
          <div><label for="tn">Your team name</label><input id="tn" name="team_name" maxlength="40" required></div>
          <div class="form-row">
            <div><label for="mt">Teams</label><select id="mt" name="max_teams">${[2, 4, 6, 8, 10, 12].map((n) => `<option ${n === 6 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
            <div><label for="rs">Roster size</label><select id="rs" name="roster_size">${[6, 7, 8, 9, 10, 11, 12].map((n) => `<option ${n === 9 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
            <div><label for="ps">Pick timer</label><select id="ps" name="pick_seconds">
              ${[[30, '30 sec'], [60, '1 min'], [90, '90 sec'], [120, '2 min'], [300, '5 min'], [0, 'No timer']].map(([v, l]) => `<option value="${v}" ${v === 90 ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          </div>
          <span class="hint">6 starters (QB, 3 WR, TE, C) plus bench. You can change these until the draft.</span>
          <button class="btn">Create league</button>
        </form>
      </div>
      <div class="card">
        <h2>Join a league</h2>
        <form id="join" class="stack">
          <div><label for="code">Invite code</label><input id="code" name="code" maxlength="6" required style="text-transform:uppercase"></div>
          <button class="btn">Find league</button>
        </form>
      </div>
    </div>`;

  $('#create').addEventListener('submit', action(async (e) => {
    const { id } = await api('POST', '/api/leagues', Object.fromEntries(new FormData(e.target)));
    toast('League created. Invite your friends!');
    go(`#/l/${id}/settings`);
  }));
  $('#join').addEventListener('submit', action(async (e) => {
    go(`#/join/${encodeURIComponent(new FormData(e.target).get('code').trim().toUpperCase())}`);
  }));
}

export async function joinView(code) {
  const l = await api('GET', `/api/leagues/invite/${encodeURIComponent(code)}`);
  if (l.alreadyMember) return go(`#/l/${l.id}`);
  const open = l.status === 'predraft' && l.teamCount < l.maxTeams;
  view.innerHTML = `<div class="auth-wrap"><div class="card">
    <h1>${esc(l.name)}</h1>
    <p class="muted">Commissioner: ${esc(l.commissioner)} · ${l.teamCount}/${l.maxTeams} teams</p>
    ${open ? `<form id="f" class="stack">
      <div><label for="tn">Name your team</label><input id="tn" name="team_name" maxlength="40" required></div>
      <button class="btn block">Join league</button></form>`
    : `<p>${l.status !== 'predraft' ? 'This league has already drafted.' : 'This league is full.'}</p>`}
  </div></div>`;
  $('#f')?.addEventListener('submit', action(async (e) => {
    const { id } = await api('POST', '/api/leagues/join', { code, team_name: new FormData(e.target).get('team_name') });
    toast(`You joined ${l.name}!`);
    go(`#/l/${id}`);
  }));
}
