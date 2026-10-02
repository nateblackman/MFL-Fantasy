import {
  api, view, esc, toast, go, session, action, modal, $, $$, fmt, slotPos, statLine,
  playerCell, mflTag, weekPicker, bindWeekPicker, timeAgo,
} from '../lib.js';

export const STATUS = { predraft: 'Pre-draft', drafting: 'Drafting now', inseason: 'In season' };

export async function loadLeague(id) {
  return api('GET', `/api/leagues/${id}`);
}

export function shell(L, active, body) {
  const id = L.league.id;
  const links = [
    ['home', `#/l/${id}`, 'League'],
    L.myTeamId && ['team', `#/l/${id}/team/${L.myTeamId}`, 'My Team'],
    ['players', `#/l/${id}/players`, 'Players'],
    L.league.status === 'inseason' && ['trades', `#/l/${id}/trades`, 'Trades'],
    ['draft', `#/l/${id}/draft`, L.league.status === 'drafting' ? 'Draft 🔴' : 'Draft'],
    ['settings', `#/l/${id}/settings`, 'Settings'],
  ].filter(Boolean);
  view.innerHTML = `
    <div class="league-head">
      <div><h1>${esc(L.league.name)}</h1>
        <span class="pill ${L.league.status === 'drafting' ? 'live' : ''}">${STATUS[L.league.status]}</span></div>
    </div>
    <nav class="subnav">${links.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
    <div id="league-body">${body}</div>`;
}

const teamLink = (L, t) => `<a href="#/l/${L.league.id}/team/${t.id}" class="team-link">${esc(t.name)}</a>`;
const inviteUrl = (L) => `${location.origin}/#/join/${L.league.inviteCode}`;

function inviteCard(L) {
  if (!L.league.inviteCode || L.league.status !== 'predraft') return '';
  return `<div class="card">
    <h2>Invite friends</h2>
    <p class="muted">Send this link, or have them enter code <strong class="code">${esc(L.league.inviteCode)}</strong>.</p>
    <div class="copy-row"><input readonly value="${esc(inviteUrl(L))}" id="invite-url" aria-label="Invite link"><button class="btn" id="copy-invite">Copy</button></div>
  </div>`;
}

function bindInvite(L) {
  $('#copy-invite')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteUrl(L)); toast('Invite link copied'); }
    catch { $('#invite-url').select(); }
  });
}

// ---------- league home ----------

export async function leagueHome(id, q) {
  const L = await loadLeague(id);
  if (L.league.status !== 'inseason') {
    const teams = L.teams.map((t) => `<li>${esc(t.name)} <span class="muted">· ${esc(t.owner)}</span></li>`).join('');
    shell(L, 'home', `
      ${L.league.status === 'drafting' ? `<a class="card banner" href="#/l/${id}/draft"><strong>The draft is live!</strong> Enter the draft room →</a>` : ''}
      <div class="grid-2">
        <div class="card"><h2>Teams (${L.teams.length}/${L.league.maxTeams})</h2><ul class="plain">${teams}</ul>
          <p class="muted">Roster: ${L.league.rosterSize} players · Pick timer: ${L.league.pickSeconds ? `${L.league.pickSeconds}s` : 'none'}</p>
          ${L.isCommish && L.league.status === 'predraft' ? `<a class="btn" href="#/l/${id}/draft">Set up the draft</a>` : ''}
        </div>
        ${L.league.status === 'predraft' ? inviteCard(L) : ''}
      </div>
      ${await activityCard(id)}`);
    bindInvite(L);
    return;
  }

  const week = Number(q.get('week')) || Math.max(session.mfl.currentWeek, L.league.startWeek || 1);
  const [board, standings] = await Promise.all([
    api('GET', `/api/leagues/${id}/scoreboard?week=${week}`),
    api('GET', `/api/leagues/${id}/standings`),
  ]);
  const games = board.matchups.map((m) => {
    const side = (s, o) => `<div class="side ${board.final && s.score > o.score ? 'lead' : ''} ${s.team.id === L.myTeamId ? 'mine' : ''}">
      <span>${esc(s.team.name)}<br><span class="muted small">${esc(s.team.owner)}</span></span><span class="score">${fmt(s.score)}</span></div>`;
    return `<a class="card game" href="#/l/${id}/matchup/${m.id}">${side(m.away, m.home)}${side(m.home, m.away)}</a>`;
  }).join('') || `<p class="muted">No games this week${week < L.league.startWeek ? ` (your season starts in week ${L.league.startWeek})` : ''}.</p>`;
  const playing = new Set(board.matchups.flatMap((m) => [m.home.team.id, m.away.team.id]));
  const byes = board.matchups.length ? L.teams.filter((t) => !playing.has(t.id)) : [];
  const rows = standings.map((r, i) => `<tr class="${r.team.id === L.myTeamId ? 'mine' : ''}">
    <td>${i + 1}</td><td>${teamLink(L, r.team)}<div class="muted small">${esc(r.team.owner)}</div></td>
    <td class="num">${r.w}-${r.l}${r.t ? `-${r.t}` : ''}</td><td class="num">${fmt(r.pf)}</td><td class="num">${fmt(r.pa)}</td></tr>`).join('');

  shell(L, 'home', `
    <div class="page-head">
      <div><h2 class="flush">Week ${week}</h2>
        <span class="pill ${board.final ? 'final' : board.locked ? 'live' : ''}">${board.final ? 'Final' : board.locked ? 'Games underway' : 'Upcoming'}</span></div>
      ${weekPicker(week, session.mfl.seasonWeeks)}
    </div>
    <div class="scoreboard">${games}</div>
    ${byes.length ? `<p class="muted">Bye: ${byes.map((t) => esc(t.name)).join(', ')}</p>` : ''}
    <div class="grid-2">
      <div class="card"><h2>Standings</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Team</th><th class="num">Record</th><th class="num">PF</th><th class="num">PA</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <p class="muted small">Only final weeks count toward standings.</p>
      </div>
      ${await activityCard(id)}
    </div>`);
  bindWeekPicker(`#/l/${id}`);
}

async function activityCard(id) {
  const items = await api('GET', `/api/leagues/${id}/activity`);
  return `<div class="card"><h2>Recent activity</h2>
    ${items.length ? `<ul class="feed">${items.slice(0, 15).map((a) => `<li><span class="feed-kind ${a.kind}">${esc(a.kind)}</span> ${esc(a.text)} <span class="muted small">${timeAgo(a.created_at)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
  </div>`;
}

// ---------- team ----------

export async function teamView(id, teamId, q) {
  const L = await loadLeague(id);
  const week = Number(q.get('week')) || Math.max(session.mfl.currentWeek, L.league.startWeek || 1);
  const d = await api('GET', `/api/leagues/${id}/teams/${teamId}?week=${week}`);
  const editable = d.canEdit && !d.weekState.locked && week >= session.mfl.currentWeek;
  const movesOpen = d.isMine && L.league.status === 'inseason' && L.season.movesOpen;

  const rows = d.lineup.slots.map((s) => {
    let cell;
    if (editable && !s.locked) {
      const opts = d.roster.filter((p) => p.position === slotPos(s.slot))
        .map((p) => `<option value="${p.id}" ${s.player?.id === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.mfl_short || 'FA')})</option>`).join('');
      cell = `<select data-slot="${s.slot}" aria-label="${s.slot}"><option value="">— empty —</option>${opts}</select>`;
    } else {
      cell = s.player ? `${esc(s.player.name)} ${mflTag(s.player)}` : '<span class="muted">Empty</span>';
      if (editable) cell += `<span class="lock" title="Already played">🔒</span><input type="hidden" data-slot="${s.slot}" value="${s.player?.id ?? ''}">`;
    }
    return `<tr><td class="slot"><span class="pos">${slotPos(s.slot)}</span></td>
      <td>${cell}<div class="muted small">${esc(statLine(s.stats))}</div></td>
      <td class="num pts">${s.played ? fmt(s.points) : '–'}</td></tr>`;
  }).join('');

  const starters = new Set(d.lineup.slots.map((s) => s.player?.id).filter(Boolean));
  const rosterRows = d.roster.map((p) => `<tr>
    <td>${playerCell(p)} ${starters.has(p.id) ? '<span class="pill small">Starter</span>' : ''}</td>
    <td class="num">${fmt(p.seasonPts)}</td>
    ${movesOpen ? `<td class="num"><button class="btn ghost small" data-drop="${p.id}" data-name="${esc(p.name)}">Drop</button></td>` : ''}
  </tr>`).join('') || '<tr><td class="muted">No players yet. They arrive in the draft.</td></tr>';

  const claims = d.claims.filter((c) => c.status === 'pending');
  const lockMsg = d.weekState.final ? 'This week is final.' : d.weekState.locked ? 'Games are underway, so lineups are locked.' : '';

  shell(L, d.isMine ? 'team' : '', `
    <div class="page-head">
      <div><h2 class="flush">${esc(d.team.name)}</h2>
        <span class="muted">${esc(d.team.owner)} · Week ${week}${d.matchupId ? ` · <a href="#/l/${id}/matchup/${d.matchupId}">Matchup</a>` : ''}${d.team.waiverPriority ? ` · Waiver #${d.team.waiverPriority}` : ''}</span></div>
      ${L.league.status === 'inseason' ? weekPicker(week, session.mfl.seasonWeeks) : ''}
    </div>
    <div class="grid-2">
      <div class="card"><h2>Starting lineup</h2>
        <table class="lineup"><tbody>${rows}</tbody>
          <tfoot><tr><td></td><td>Total</td><td class="num">${fmt(d.lineup.total)}</td></tr></tfoot></table>
        ${editable ? '<div class="row-end"><button class="btn" id="save-lineup">Save lineup</button></div>' : ''}
        ${d.isMine && lockMsg ? `<p class="muted">${lockMsg}</p>` : ''}
      </div>
      <div class="card"><h2>Roster (${d.roster.length}/${L.league.rosterSize})</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Player</th><th class="num">Season pts</th>${movesOpen ? '<th></th>' : ''}</tr></thead>
          <tbody>${rosterRows}</tbody></table></div>
        ${d.isMine && L.league.status === 'inseason' ? `<p><a href="#/l/${id}/players">Find free agents →</a></p>` : ''}
      </div>
    </div>
    ${claims.length ? `<div class="card"><h2>Pending waiver claims</h2><ul class="plain">${claims.map((c) => `<li>
      Add <strong>${esc(c.add_name)}</strong>${c.drop_name ? `, drop ${esc(c.drop_name)}` : ''}
      <button class="btn ghost small" data-cancel-claim="${c.id}">Cancel</button></li>`).join('')}</ul>
      <p class="muted small">Claims are processed when the MFL moves to the next week.</p></div>` : ''}`);
  if (L.league.status === 'inseason') bindWeekPicker(`#/l/${id}/team/${teamId}`);

  $('#save-lineup')?.addEventListener('click', action(async () => {
    const slots = {};
    $$('[data-slot]').forEach((el) => { slots[el.dataset.slot] = el.value || null; });
    await api('PUT', `/api/leagues/${id}/teams/${teamId}/lineup`, { week, slots });
    toast('Lineup saved');
    teamView(id, teamId, q);
  }));
  $$('[data-drop]').forEach((b) => b.addEventListener('click', action(async () => {
    if (!confirm(`Drop ${b.dataset.name}? They'll go on waivers.`)) return;
    await api('POST', `/api/leagues/${id}/drop`, { player_id: Number(b.dataset.drop) });
    toast(`Dropped ${b.dataset.name}`);
    teamView(id, teamId, q);
  })));
  $$('[data-cancel-claim]').forEach((b) => b.addEventListener('click', action(async () => {
    await api('DELETE', `/api/leagues/${id}/claims/${b.dataset.cancelClaim}`);
    teamView(id, teamId, q);
  })));
}

// ---------- matchup ----------

export async function matchupView(id, mid) {
  const L = await loadLeague(id);
  const m = await api('GET', `/api/leagues/${id}/matchups/${mid}`);
  const col = (side) => `<div class="card">
    <div class="vs-head">${teamLink(L, side.team)}<span class="big">${fmt(side.total)}</span></div>
    <table class="lineup"><tbody>${side.slots.map((s) => `<tr>
      <td class="slot"><span class="pos">${slotPos(s.slot)}</span></td>
      <td>${s.player ? `${esc(s.player.name)} ${mflTag(s.player)}` : '<span class="muted">Empty</span>'}
        <div class="muted small">${esc(statLine(s.stats))}</div></td>
      <td class="num pts">${s.played ? fmt(s.points) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
  shell(L, '', `
    <div class="page-head">
      <div><h2 class="flush">Week ${m.week}</h2><span class="pill ${m.final ? 'final' : m.locked ? 'live' : ''}">${m.final ? 'Final' : m.locked ? 'Games underway' : 'Upcoming'}</span></div>
      <a href="#/l/${id}?week=${m.week}">← Scoreboard</a>
    </div>
    <div class="grid-2">${col(m.away)}${col(m.home)}</div>`);
}

// ---------- players ----------

export async function playersView(id, q) {
  const L = await loadLeague(id);
  const [players, mine] = await Promise.all([
    api('GET', `/api/leagues/${id}/players`),
    L.myTeamId ? api('GET', `/api/leagues/${id}/teams/${L.myTeamId}`) : null,
  ]);
  const myRoster = mine ? mine.roster : [];
  const canMove = !!L.myTeamId && L.league.status === 'inseason' && L.season.movesOpen;
  const state = { pos: q.get('pos') || '', status: q.get('status') || 'available', text: '' };

  shell(L, 'players', `
    <div class="card">
      <div class="form-row filters">
        <div><label for="f-text">Search</label><input id="f-text" type="search" placeholder="Player name"></div>
        <div><label for="f-pos">Position</label><select id="f-pos"><option value="">All</option>${['QB', 'WR', 'TE', 'C'].map((p) => `<option ${p === state.pos ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div><label for="f-status">Show</label><select id="f-status">
          ${[['available', 'Available'], ['all', 'All players'], ['rostered', 'On rosters']].map(([v, l]) => `<option value="${v}" ${v === state.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      </div>
      ${L.league.status === 'inseason' && !L.season.movesOpen ? '<p class="muted">Roster moves are paused while games are underway.</p>' : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Player</th><th>Status</th><th class="num">Pts</th><th class="num">GP</th><th></th></tr></thead>
        <tbody id="rows"></tbody></table></div>
    </div>`);

  const draw = () => {
    const list = players.filter((p) => (!state.pos || p.position === state.pos)
      && (!state.text || p.name.toLowerCase().includes(state.text))
      && (state.status === 'all' || (state.status === 'rostered' ? p.owner_id : !p.owner_id)));
    $('#rows').innerHTML = list.map((p) => {
      const status = p.owner_id ? `<a href="#/l/${id}/team/${p.owner_id}">${esc(p.owner_name)}</a>`
        : p.on_waivers ? '<span class="pill">Waivers</span>' : '<span class="pill final">Free agent</span>';
      let btn = '';
      if (canMove && !p.owner_id) btn = `<button class="btn small" data-act="${p.on_waivers ? 'claim' : 'add'}" data-id="${p.id}">${p.on_waivers ? 'Claim' : 'Add'}</button>`;
      else if (L.league.status === 'inseason' && p.owner_id && p.owner_id !== L.myTeamId && L.myTeamId) btn = `<a class="btn ghost small" href="#/l/${id}/trades?team=${p.owner_id}&get=${p.id}">Trade</a>`;
      return `<tr><td>${playerCell(p)}</td><td>${status}</td><td class="num">${fmt(p.seasonPts)}</td><td class="num">${p.games}</td><td class="num">${btn}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No players match.</td></tr>';
  };
  draw();
  $('#f-text').addEventListener('input', (e) => { state.text = e.target.value.trim().toLowerCase(); draw(); });
  $('#f-pos').addEventListener('change', (e) => { state.pos = e.target.value; draw(); });
  $('#f-status').addEventListener('change', (e) => { state.status = e.target.value; draw(); });

  $('#rows').addEventListener('click', action(async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = players.find((x) => x.id === Number(b.dataset.id));
    const full = myRoster.length >= L.league.rosterSize;
    const claim = b.dataset.act === 'claim';
    let drop = null;
    if (full || claim) {
      const res = await modal(`${claim ? 'Claim' : 'Add'} ${p.name}`, `
        ${claim ? '<p class="muted">Waiver claims are awarded in priority order when the week advances.</p>' : ''}
        <label for="drop">${full ? 'Your roster is full. Drop:' : 'Drop (optional):'}</label>
        <select id="drop" name="drop" ${full ? 'required' : ''}>
          <option value="">${full ? 'Choose a player…' : 'Nobody'}</option>
          ${myRoster.map((r) => `<option value="${r.id}">${esc(r.position)} ${esc(r.name)}</option>`).join('')}
        </select>`, claim ? 'Submit claim' : 'Add player');
      if (!res) return;
      drop = res.drop ? Number(res.drop) : null;
    }
    await api('POST', `/api/leagues/${id}/${claim ? 'claims' : 'add'}`, { add_player_id: p.id, drop_player_id: drop });
    toast(claim ? `Claim submitted for ${p.name}` : `Added ${p.name}`);
    playersView(id, q);
  }));
}

// ---------- trades ----------

export async function tradesView(id, q) {
  const L = await loadLeague(id);
  const trades = await api('GET', `/api/leagues/${id}/trades`);
  const others = L.teams.filter((t) => t.id !== L.myTeamId);
  const teamName = (tid) => L.teams.find((t) => t.id === tid)?.name || 'Team';
  const pending = trades.filter((t) => t.status === 'pending');
  const past = trades.filter((t) => t.status !== 'pending');

  const tradeCard = (t) => {
    const side = (tid) => t.items.filter((i) => i.from_team_id === tid).map((i) => `<li><span class="pos">${i.position}</span> ${esc(i.name)}</li>`).join('') || '<li class="muted">Nothing</li>';
    let buttons = '';
    if (t.status === 'pending') {
      if (t.receiver_team_id === L.myTeamId) buttons += `<button class="btn small" data-trade="${t.id}" data-act="accept">Accept</button><button class="btn ghost small" data-trade="${t.id}" data-act="reject">Reject</button>`;
      if (t.proposer_team_id === L.myTeamId) buttons += `<button class="btn ghost small" data-trade="${t.id}" data-act="cancel">Cancel</button>`;
      if (L.isCommish) buttons += `<button class="btn ghost small" data-trade="${t.id}" data-act="veto">Veto</button>`;
    }
    return `<div class="card trade">
      <div class="trade-head"><strong>${esc(teamName(t.proposer_team_id))}</strong> ⇄ <strong>${esc(teamName(t.receiver_team_id))}</strong>
        <span class="pill ${t.status === 'accepted' ? 'final' : ''}">${t.status}</span> <span class="muted small">${timeAgo(t.created_at)}</span></div>
      <div class="grid-2 tight">
        <div><div class="muted small">${esc(teamName(t.proposer_team_id))} sends</div><ul class="plain">${side(t.proposer_team_id)}</ul></div>
        <div><div class="muted small">${esc(teamName(t.receiver_team_id))} sends</div><ul class="plain">${side(t.receiver_team_id)}</ul></div>
      </div>
      ${t.message ? `<p class="quote">“${esc(t.message)}”</p>` : ''}
      ${buttons ? `<div class="row-end">${buttons}</div>` : ''}
    </div>`;
  };

  shell(L, 'trades', `
    ${L.myTeamId ? `<div class="card"><h2>Propose a trade</h2>
      <div class="form-row"><div><label for="t-team">Trade with</label>
        <select id="t-team"><option value="">Choose a team…</option>${others.map((t) => `<option value="${t.id}" ${Number(q.get('team')) === t.id ? 'selected' : ''}>${esc(t.name)} (${esc(t.owner)})</option>`).join('')}</select></div></div>
      <div id="t-builder"></div></div>` : ''}
    <h2>Pending</h2>${pending.map(tradeCard).join('') || '<p class="muted">No pending trades.</p>'}
    ${past.length ? `<h2>History</h2>${past.map(tradeCard).join('')}` : ''}`);

  const builder = async () => {
    const other = Number($('#t-team').value);
    if (!other) { $('#t-builder').innerHTML = ''; return; }
    const [me, them] = await Promise.all([
      api('GET', `/api/leagues/${id}/teams/${L.myTeamId}`),
      api('GET', `/api/leagues/${id}/teams/${other}`),
    ]);
    const want = Number(q.get('get'));
    const list = (roster, name, pre) => roster.map((p) => `<label class="check"><input type="checkbox" name="${name}" value="${p.id}" ${p.id === pre ? 'checked' : ''}> ${playerCell(p)}</label>`).join('');
    $('#t-builder').innerHTML = `<form id="t-form">
      <div class="grid-2 tight">
        <div><h3>You send</h3>${list(me.roster, 'give')}</div>
        <div><h3>You get</h3>${list(them.roster, 'get', want)}</div>
      </div>
      <div><label for="t-msg">Message (optional)</label><input id="t-msg" name="message" maxlength="280" style="width:100%"></div>
      <div class="row-end"><button class="btn">Send offer</button></div></form>`;
    $('#t-form').addEventListener('submit', action(async (e) => {
      const fd = new FormData(e.target);
      await api('POST', `/api/leagues/${id}/trades`, {
        to_team_id: other, give: fd.getAll('give').map(Number), get: fd.getAll('get').map(Number), message: fd.get('message'),
      });
      toast('Trade offer sent');
      go(`#/l/${id}/trades`);
    }));
  };
  $('#t-team')?.addEventListener('change', action(builder));
  if (q.get('team') && L.myTeamId) await builder();

  $$('[data-trade]').forEach((b) => b.addEventListener('click', action(async () => {
    if (b.dataset.act === 'veto' && !confirm('Veto this trade?')) return;
    await api('POST', `/api/leagues/${id}/trades/${b.dataset.trade}/${b.dataset.act}`);
    toast(`Trade ${b.dataset.act === 'accept' ? 'accepted' : b.dataset.act === 'reject' ? 'rejected' : b.dataset.act === 'cancel' ? 'cancelled' : 'vetoed'}`);
    tradesView(id, new URLSearchParams());
  })));
}

// ---------- settings ----------

export async function settingsView(id) {
  const L = await loadLeague(id);
  const pre = L.league.status === 'predraft';
  const myTeam = L.teams.find((t) => t.id === L.myTeamId);
  const ruleHint = { pass_yds: '0.04 = 1 pt per 25 yds', rush_yds: '0.1 = 1 pt per 10 yds', rec_yds: '0.1 = 1 pt per 10 yds' };
  const f = session.mfl;

  shell(L, 'settings', `
    ${myTeam ? `<div class="card"><h2>Your team</h2>
      <form id="rename" class="form-row"><div><label for="tn">Team name</label><input id="tn" name="name" value="${esc(myTeam.name)}" maxlength="40" required></div>
      <button class="btn">Rename</button></form></div>` : ''}
    ${inviteCard(L)}
    ${L.isCommish ? `
    <div class="card"><h2>League settings</h2>
      <form id="settings" class="stack">
        <div><label for="ln">League name</label><input id="ln" name="name" value="${esc(L.league.name)}" maxlength="40" required></div>
        <div class="form-row">
          <div><label for="mt">Max teams</label><input id="mt" name="max_teams" type="number" min="2" max="12" value="${L.league.maxTeams}" ${pre ? '' : 'disabled'}></div>
          <div><label for="rs">Roster size</label><input id="rs" name="roster_size" type="number" min="6" max="20" value="${L.league.rosterSize}" ${pre ? '' : 'disabled'}></div>
          <div><label for="ps">Pick timer (sec, 0 = none)</label><input id="ps" name="pick_seconds" type="number" min="0" max="600" value="${L.league.pickSeconds}"></div>
        </div>
        ${pre ? '' : '<span class="hint">Team count and roster size are fixed once the draft starts.</span>'}
        <div class="row-end"><button class="btn">Save settings</button></div>
      </form></div>
    <div class="card"><h2>Scoring (points per unit)</h2>
      <form id="scoring"><div class="rules-grid">${f.statFields.map((k) => `<div>
        <label for="r-${k}">${esc(f.statLabels[k])}</label>
        <input id="r-${k}" type="number" step="any" name="${k}" value="${L.scoring[k]}">
        ${ruleHint[k] ? `<span class="hint">${ruleHint[k]}</span>` : ''}</div>`).join('')}</div>
        <div class="row-end"><button class="btn">Save scoring</button></div></form></div>
    <div class="card"><h2>Teams</h2>
      <table><tbody>${L.teams.map((t) => `<tr><td>${esc(t.name)}</td><td class="muted">${esc(t.owner)}</td>
        <td class="num">${pre && t.id !== L.myTeamId ? `<button class="btn ghost small" data-remove="${t.id}" data-name="${esc(t.name)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${L.league.status === 'inseason' ? `<div class="card"><h2>Waivers</h2>
      <p class="muted">Waivers run automatically when the MFL moves to the next week. You can also run them now.</p>
      <button class="btn" id="run-waivers">Process waivers now</button></div>` : ''}
    ` : `<div class="card"><h2>Scoring</h2><p class="muted">${f.statFields.map((k) => `${esc(f.statLabels[k])}: ${L.scoring[k]}`).join(' · ')}</p></div>`}`);
  bindInvite(L);

  $('#rename')?.addEventListener('submit', action(async (e) => {
    await api('PATCH', `/api/leagues/${id}/teams/${L.myTeamId}`, Object.fromEntries(new FormData(e.target)));
    toast('Team renamed');
  }));
  $('#settings')?.addEventListener('submit', action(async (e) => {
    const body = Object.fromEntries(new FormData(e.target));
    await api('PATCH', `/api/leagues/${id}`, body);
    toast('Settings saved');
    settingsView(id);
  }));
  $('#scoring')?.addEventListener('submit', action(async (e) => {
    await api('PATCH', `/api/leagues/${id}`, { scoring: Object.fromEntries(new FormData(e.target)) });
    toast('Scoring saved');
  }));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', action(async () => {
    if (!confirm(`Remove ${b.dataset.name} from the league?`)) return;
    await api('DELETE', `/api/leagues/${id}/teams/${b.dataset.remove}`);
    settingsView(id);
  })));
  $('#run-waivers')?.addEventListener('click', action(async () => {
    const r = await api('POST', `/api/leagues/${id}/waivers/process`);
    toast(`Waivers processed: ${r.awarded} claim${r.awarded === 1 ? '' : 's'} awarded`);
  }));
}
