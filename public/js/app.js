// MFL Fantasy single-page app. Hash routes:
//   #/                 scoreboard + standings   (?week=N)
//   #/team/:id         team lineup + roster      (?week=N)
//   #/matchup/:id      head-to-head breakdown
//   #/admin/:tab       commissioner tools

const view = document.getElementById('view');
let league = null;

// ---------- helpers ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);
const slotPos = (slot) => slot.replace(/\d+$/, '');
const teamById = (id) => league.teams.find((t) => t.id === id);

function teamChip(team, link = true) {
  const inner = `<span class="swatch" style="background:${esc(team.color)}"></span>${esc(team.name)}`;
  return link ? `<a class="team-chip" href="#/team/${team.id}">${inner}</a>` : `<span class="team-chip">${inner}</span>`;
}

function weekPicker(current) {
  const opts = [];
  for (let w = 1; w <= league.seasonWeeks; w++) {
    opts.push(`<option value="${w}" ${w === current ? 'selected' : ''}>Week ${w}${league.finalWeeks.includes(w) ? ' ✓' : ''}</option>`);
  }
  return `<div class="week-picker">
    <button class="btn ghost small" data-week="${current - 1}" ${current <= 1 ? 'disabled' : ''} aria-label="Previous week">‹</button>
    <select data-week-select aria-label="Week">${opts.join('')}</select>
    <button class="btn ghost small" data-week="${current + 1}" ${current >= league.seasonWeeks ? 'disabled' : ''} aria-label="Next week">›</button>
  </div>`;
}

function bindWeekPicker(base) {
  const go = (w) => { location.hash = `${base}?week=${w}`; };
  view.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => go(b.dataset.week)));
  const sel = view.querySelector('[data-week-select]');
  if (sel) sel.addEventListener('change', () => go(sel.value));
}

function statLine(s) {
  if (!s) return '';
  const short = {
    pass_yds: 'PaYd', pass_td: 'PaTD', pass_int: 'INT', rush_yds: 'RuYd', rush_td: 'RuTD',
    rec: 'Rec', rec_yds: 'ReYd', rec_td: 'ReTD', fumbles_lost: 'FL', two_pt: '2PT',
    bad_snaps: 'BadSnap', sacks_allowed: 'SkAlw',
  };
  return league.statFields.filter((f) => s[f]).map((f) => `${s[f]} ${short[f]}`).join(', ');
}

// ---------- header / auth ----------

function renderChrome(route) {
  const me = league.me;
  const links = [['#/', 'Scoreboard', route === 'home']];
  if (me && me.role === 'team') links.push([`#/team/${me.teamId}`, 'My Team', route === 'team']);
  if (me && me.role === 'commish') links.push(['#/admin/players', 'Commissioner', route === 'admin']);
  document.getElementById('nav').innerHTML = links
    .map(([href, label, active]) => `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`).join('');

  const who = !me ? '' : me.role === 'commish' ? 'Commissioner' : esc(teamById(me.teamId)?.name || 'Team');
  document.getElementById('auth').innerHTML = me
    ? `<span class="muted">${who}</span><button class="btn ghost small" id="logout">Log out</button>`
    : `<button class="btn small" id="login">Log in</button>`;
  document.getElementById('login')?.addEventListener('click', openLogin);
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    toast('Logged out');
    route_();
  });
}

const dialog = document.getElementById('login-dialog');
function openLogin() {
  document.getElementById('login-pin').value = '';
  document.getElementById('login-error').hidden = true;
  dialog.showModal();
}
document.getElementById('login-cancel').addEventListener('click', () => dialog.close());
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  try {
    await api('POST', '/api/auth/login', { pin: document.getElementById('login-pin').value });
    dialog.close();
    league = await api('GET', '/api/league');
    toast('Logged in');
    if (league.me.role === 'team') location.hash = `#/team/${league.me.teamId}`;
    else if (league.me.role === 'commish') location.hash = '#/admin/players';
    route_();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ---------- views ----------

async function homeView(q) {
  const week = Number(q.get('week')) || league.currentWeek;
  const [board, standings] = await Promise.all([
    api('GET', `/api/scoreboard?week=${week}`),
    api('GET', '/api/standings'),
  ]);

  const games = board.matchups.map((m) => {
    const side = (s, other) => `<div class="side ${board.final && s.score > other.score ? 'lead' : ''}">
      ${teamChip(s.team, false)}<span class="score">${fmt(s.score)}</span></div>`;
    return `<a class="card game" href="#/matchup/${m.id}">
      ${side(m.away, m.home)}${side(m.home, m.away)}
    </a>`;
  }).join('') || '<p class="muted">No games scheduled this week.</p>';

  const rows = standings.map((r, i) => `<tr>
    <td>${i + 1}</td><td>${teamChip(r.team)}</td>
    <td class="num">${r.w}-${r.l}${r.t ? `-${r.t}` : ''}</td>
    <td class="num">${fmt(r.pf)}</td><td class="num">${fmt(r.pa)}</td></tr>`).join('');

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Week ${week}</h1>
        <span class="pill ${board.final ? 'final' : ''}">${board.final ? 'Final' : week === league.currentWeek ? 'In progress' : 'Not final'}</span></div>
      ${weekPicker(week)}
    </div>
    <div class="scoreboard">${games}</div>
    <div class="card">
      <h2>Standings</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Team</th><th class="num">Record</th><th class="num">PF</th><th class="num">PA</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="muted">Only weeks marked final count toward standings.</p>
    </div>`;
  bindWeekPicker('#/');
}

async function teamView(id, q) {
  const week = Number(q.get('week')) || league.currentWeek;
  const data = await api('GET', `/api/teams/${id}?week=${week}`);
  const { team, roster, lineup, canEdit, final } = data;
  const editable = canEdit && !final;

  const starters = new Set(lineup.slots.map((s) => s.player?.id).filter(Boolean));
  const rows = lineup.slots.map((s) => {
    let cell;
    if (editable && !s.locked) {
      const opts = roster.filter((p) => p.position === slotPos(s.slot))
        .map((p) => `<option value="${p.id}" ${s.player?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      cell = `<select data-slot="${s.slot}" aria-label="${s.slot}"><option value="">— empty —</option>${opts}</select>`;
    } else {
      cell = s.player ? esc(s.player.name) : '<span class="muted">Empty</span>';
      if (editable && s.locked) cell += `<span class="lock" title="Locked: stats are in">🔒</span>`;
      if (editable) cell += `<input type="hidden" data-slot="${s.slot}" value="${s.player?.id ?? ''}">`;
    }
    return `<tr><td class="slot"><span class="pos">${slotPos(s.slot)}</span></td>
      <td>${cell}<div class="muted" style="font-size:.8rem">${esc(statLine(s.stats))}</div></td>
      <td class="num pts">${s.played ? fmt(s.points) : '–'}</td></tr>`;
  }).join('');

  const bench = roster.filter((p) => !starters.has(p.id));
  const benchRows = bench.map((p) => `<tr><td class="slot"><span class="pos">${p.position}</span></td><td>${esc(p.name)}</td></tr>`).join('')
    || '<tr><td colspan="2" class="muted">Nobody on the bench.</td></tr>';

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${teamChip(team, false)}</h1>
        <span class="muted">Week ${week}${final ? ' · Final' : ''}${data.matchupId ? ` · <a href="#/matchup/${data.matchupId}">View matchup</a>` : ''}</span></div>
      ${weekPicker(week)}
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>Starting lineup</h2>
        <table class="lineup">
          <tbody>${rows}</tbody>
          <tfoot><tr><td></td><td>Total</td><td class="num">${fmt(lineup.total)}</td></tr></tfoot>
        </table>
        ${editable ? '<div class="row-end"><button class="btn" id="save-lineup">Save lineup</button></div>' : ''}
        ${!canEdit ? '<p class="muted">Log in with this team\'s PIN to set the lineup.</p>' : ''}
        ${canEdit && final ? '<p class="muted">This week is final, so the lineup is locked.</p>' : ''}
      </div>
      <div class="card">
        <h2>Bench</h2>
        <table class="lineup"><tbody>${benchRows}</tbody></table>
        <p class="muted">${roster.length} players on roster.</p>
      </div>
    </div>`;
  bindWeekPicker(`#/team/${id}`);

  document.getElementById('save-lineup')?.addEventListener('click', async () => {
    const slots = {};
    view.querySelectorAll('[data-slot]').forEach((el) => { slots[el.dataset.slot] = el.value || null; });
    try {
      await api('PUT', `/api/teams/${id}/lineup`, { week, slots });
      toast('Lineup saved');
      teamView(id, q);
    } catch (ex) { toast(ex.message, true); }
  });
}

async function matchupView(id) {
  const m = await api('GET', `/api/matchups/${id}`);
  const col = (side) => `<div class="card">
    <div class="vs-head">${teamChip(side.team)}<span class="big">${fmt(side.total)}</span></div>
    <table class="lineup"><tbody>${side.slots.map((s) => `<tr>
      <td class="slot"><span class="pos">${slotPos(s.slot)}</span></td>
      <td>${s.player ? esc(s.player.name) : '<span class="muted">Empty</span>'}
        <div class="muted" style="font-size:.8rem">${esc(statLine(s.stats))}</div></td>
      <td class="num pts">${s.played ? fmt(s.points) : '–'}</td></tr>`).join('')}</tbody></table>
  </div>`;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Week ${m.week} matchup</h1><span class="pill ${m.final ? 'final' : ''}">${m.final ? 'Final' : 'Not final'}</span></div>
      <a href="#/?week=${m.week}">← Week ${m.week} scoreboard</a>
    </div>
    <div class="grid-2">${col(m.away)}${col(m.home)}</div>`;
}

// ---------- commissioner ----------

const ADMIN_TABS = [['players', 'Players'], ['stats', 'Stats'], ['schedule', 'Schedule'], ['league', 'League']];

async function adminView(tab, q) {
  if (!league.me || league.me.role !== 'commish') {
    view.innerHTML = '<div class="card"><h2>Commissioner only</h2><p>Log in with the commissioner PIN.</p></div>';
    return;
  }
  tab = ADMIN_TABS.some(([k]) => k === tab) ? tab : 'players';
  view.innerHTML = `<h1>Commissioner</h1>
    <div class="tabs">${ADMIN_TABS.map(([k, label]) =>
      `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div id="tab"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/admin/${b.dataset.tab}`; }));
  const el = document.getElementById('tab');
  await ({ players: adminPlayers, stats: adminStats, schedule: adminSchedule, league: adminLeague })[tab](el, q);
}

function teamOptions(selected, { allowNone = true } = {}) {
  return (allowNone ? `<option value="" ${selected == null ? 'selected' : ''}>Free agent</option>` : '')
    + league.teams.map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}
const posOptions = (sel) => ['QB', 'WR', 'TE', 'C'].map((p) => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');

async function adminPlayers(el) {
  const players = await api('GET', '/api/players');
  const counts = Object.fromEntries(league.teams.map((t) => [t.id, 0]));
  players.forEach((p) => { if (p.active && p.team_id) counts[p.team_id]++; });

  el.innerHTML = `
    <div class="card">
      <h2>Add player</h2>
      <form class="form-row" id="add-player">
        <div><label for="np-name">Name</label><input id="np-name" required maxlength="60"></div>
        <div><label for="np-pos">Position</label><select id="np-pos">${posOptions('WR')}</select></div>
        <div><label for="np-team">Team</label><select id="np-team">${teamOptions(null)}</select></div>
        <button class="btn">Add</button>
      </form>
    </div>
    <div class="card">
      <h2>All players (${players.length})</h2>
      <p class="muted">${league.teams.map((t) => `${esc(t.short)}: ${counts[t.id]}`).join(' · ')}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Pos</th><th>Team</th><th>Active</th></tr></thead>
        <tbody>${players.map((p) => `<tr data-id="${p.id}">
          <td><input data-f="name" value="${esc(p.name)}" maxlength="60"></td>
          <td><select data-f="position">${posOptions(p.position)}</select></td>
          <td><select data-f="team_id">${teamOptions(p.team_id)}</select></td>
          <td><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">Changes save as soon as you edit a field. Inactive players are hidden from rosters but keep their stats.</p>
    </div>`;

  el.querySelector('#add-player').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/admin/players', {
        name: el.querySelector('#np-name').value,
        position: el.querySelector('#np-pos').value,
        team_id: el.querySelector('#np-team').value || null,
      });
      toast('Player added');
      adminPlayers(el);
    } catch (ex) { toast(ex.message, true); }
  });

  el.querySelectorAll('[data-f]').forEach((input) => input.addEventListener('change', async () => {
    const id = input.closest('tr').dataset.id;
    const f = input.dataset.f;
    const value = input.type === 'checkbox' ? input.checked : input.value;
    try {
      await api('PATCH', `/api/admin/players/${id}`, { [f]: value });
      toast('Saved');
    } catch (ex) { toast(ex.message, true); }
  }));
}

async function adminStats(el, q) {
  const week = Number(q.get('week')) || league.currentWeek;
  const [players, stats] = await Promise.all([api('GET', '/api/players'), api('GET', `/api/stats?week=${week}`)]);
  const byPlayer = new Map(stats.rows.map((r) => [r.player_id, r]));
  const fields = league.statFields;
  // show active players, plus anyone who already has stats this week
  const list = players.filter((p) => p.active || byPlayer.has(p.id))
    .sort((a, b) => (a.team_short || 'zz').localeCompare(b.team_short || 'zz') || a.name.localeCompare(b.name));

  el.innerHTML = `
    <div class="page-head">
      <div><h2 style="margin:0">Week ${week} stats</h2>
        <span class="muted">${stats.final ? 'This week is final. Un-finalize it on the League tab to edit.' : 'Leave a row blank if the player did not play.'}</span></div>
      ${weekPicker(week)}
    </div>
    <div class="card">
      <div class="table-wrap"><table class="stat-grid">
        <thead><tr><th>Player</th><th>Team</th>${fields.map((f) => `<th class="num">${esc(league.statLabels[f])}</th>`).join('')}</tr></thead>
        <tbody>${list.map((p) => {
          const s = byPlayer.get(p.id);
          return `<tr data-id="${p.id}"><td class="name"><span class="pos">${p.position}</span> ${esc(p.name)}</td>
            <td>${esc(p.team_short || 'FA')}</td>
            ${fields.map((f) => `<td><input type="number" step="any" inputmode="decimal" data-f="${f}"
              value="${s ? s[f] : ''}" ${stats.final ? 'disabled' : ''} aria-label="${esc(p.name)} ${esc(league.statLabels[f])}"></td>`).join('')}
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${stats.final ? '' : '<div class="row-end"><button class="btn" id="save-stats">Save stats</button></div>'}
    </div>`;
  bindWeekPicker('#/admin/stats');

  el.querySelector('#save-stats')?.addEventListener('click', async () => {
    const rows = [...el.querySelectorAll('tbody tr')].map((tr) => {
      const row = { player_id: Number(tr.dataset.id) };
      tr.querySelectorAll('[data-f]').forEach((i) => { row[i.dataset.f] = i.value; });
      return row;
    });
    try {
      await api('PUT', '/api/admin/stats', { week, rows });
      toast('Stats saved');
    } catch (ex) { toast(ex.message, true); }
  });
}

async function adminSchedule(el) {
  const weeks = [];
  for (let w = 1; w <= league.seasonWeeks; w++) weeks.push(w);
  const boards = await Promise.all(weeks.map((w) => api('GET', `/api/scoreboard?week=${w}`)));

  el.innerHTML = `
    <div class="card">
      <h2>Regenerate schedule</h2>
      <form class="form-row" id="regen">
        <div><label for="season-weeks">Season length (weeks)</label>
          <input id="season-weeks" type="number" min="1" max="30" value="${league.seasonWeeks}"></div>
        <button class="btn">Regenerate</button>
      </form>
      <p class="muted">Round robin: each team plays every other team once every 5 weeks. This replaces every matchup and only works before any week is final.</p>
    </div>
    ${boards.map((b) => `<div class="card">
      <h2>Week ${b.week} ${b.final ? '<span class="pill final">Final</span>' : ''}</h2>
      ${b.matchups.map((m) => `<div class="form-row" style="margin-bottom:8px" data-id="${m.id}">
        <select data-f="away_team_id" ${b.final ? 'disabled' : ''} aria-label="Away team">${teamOptions(m.away.team.id, { allowNone: false })}</select>
        <span class="muted">at</span>
        <select data-f="home_team_id" ${b.final ? 'disabled' : ''} aria-label="Home team">${teamOptions(m.home.team.id, { allowNone: false })}</select>
        ${b.final ? '' : '<button class="btn ghost small" data-save>Save</button>'}
      </div>`).join('')}
    </div>`).join('')}`;

  el.querySelector('#regen').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('Replace the whole schedule?')) return;
    try {
      await api('POST', '/api/admin/schedule', { season_weeks: Number(el.querySelector('#season-weeks').value) });
      league = await api('GET', '/api/league');
      toast('Schedule regenerated');
      adminSchedule(el);
    } catch (ex) { toast(ex.message, true); }
  });

  el.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('[data-id]');
    try {
      await api('PATCH', `/api/admin/matchups/${row.dataset.id}`, {
        home_team_id: row.querySelector('[data-f=home_team_id]').value,
        away_team_id: row.querySelector('[data-f=away_team_id]').value,
      });
      toast('Matchup saved');
    } catch (ex) { toast(ex.message, true); }
  }));
}

async function adminLeague(el) {
  const rules = await api('GET', '/api/scoring');
  const weeks = [];
  for (let w = 1; w <= league.seasonWeeks; w++) weeks.push(w);
  const ruleHint = { pass_yds: '0.04 = 1 pt / 25 yds', rush_yds: '0.1 = 1 pt / 10 yds', rec_yds: '0.1 = 1 pt / 10 yds' };

  el.innerHTML = `
    <div class="card">
      <h2>Current week</h2>
      <form class="form-row" id="cur-week">
        <div><label for="cw">Week shown by default</label>
          <select id="cw">${weeks.map((w) => `<option ${w === league.currentWeek ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
        <button class="btn">Set</button>
      </form>
    </div>
    <div class="card">
      <h2>Final weeks</h2>
      <p class="muted">Mark a week final once all stats are in. That locks its stats and lineups and counts it in the standings.</p>
      <div class="form-row">${weeks.map((w) => `<label style="display:flex;gap:6px;align-items:center;margin-right:12px">
        <input type="checkbox" data-final="${w}" ${league.finalWeeks.includes(w) ? 'checked' : ''}> Week ${w}</label>`).join('')}</div>
    </div>
    <div class="card">
      <h2>Scoring (points per unit)</h2>
      <form id="rules">
        <div class="rules-grid">${league.statFields.map((f) => `<div>
          <label for="r-${f}">${esc(league.statLabels[f])}</label>
          <input id="r-${f}" type="number" step="any" data-rule="${f}" value="${rules[f]}">
          ${ruleHint[f] ? `<span class="muted" style="font-size:.75rem">${ruleHint[f]}</span>` : ''}
        </div>`).join('')}</div>
        <div class="row-end"><button class="btn">Save scoring</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Teams</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Color</th><th>New PIN</th><th></th></tr></thead>
        <tbody>${league.teams.map((t) => `<tr data-id="${t.id}">
          <td><input data-f="name" value="${esc(t.name)}" maxlength="60" style="min-width:200px"></td>
          <td><input data-f="color" type="color" value="${esc(t.color)}"></td>
          <td><input data-f="pin" inputmode="numeric" placeholder="unchanged" size="10"></td>
          <td><button class="btn ghost small" data-save-team>Save</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Commissioner PIN</h2>
      <form class="form-row" id="cpin">
        <div><label for="cpin-in">New PIN (4–8 digits)</label><input id="cpin-in" inputmode="numeric" required></div>
        <button class="btn">Change</button>
      </form>
    </div>`;

  const refresh = async () => { league = await api('GET', '/api/league'); renderChrome('admin'); };

  el.querySelector('#cur-week').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/admin/current-week', { week: Number(el.querySelector('#cw').value) }); await refresh(); toast('Current week set'); }
    catch (ex) { toast(ex.message, true); }
  });

  el.querySelectorAll('[data-final]').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api('PUT', `/api/admin/weeks/${cb.dataset.final}/final`, { final: cb.checked }); await refresh(); toast(`Week ${cb.dataset.final} ${cb.checked ? 'final' : 'reopened'}`); }
    catch (ex) { cb.checked = !cb.checked; toast(ex.message, true); }
  }));

  el.querySelector('#rules').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    el.querySelectorAll('[data-rule]').forEach((i) => { body[i.dataset.rule] = i.value; });
    try { await api('PUT', '/api/admin/scoring', body); toast('Scoring saved'); }
    catch (ex) { toast(ex.message, true); }
  });

  el.querySelectorAll('[data-save-team]').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const body = { name: tr.querySelector('[data-f=name]').value, color: tr.querySelector('[data-f=color]').value };
    const pin = tr.querySelector('[data-f=pin]').value.trim();
    if (pin) body.pin = pin;
    try { await api('PATCH', `/api/admin/teams/${tr.dataset.id}`, body); await refresh(); toast('Team saved'); adminLeague(el); }
    catch (ex) { toast(ex.message, true); }
  }));

  el.querySelector('#cpin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/admin/commish-pin', { pin: el.querySelector('#cpin-in').value }); toast('Commissioner PIN changed'); e.target.reset(); }
    catch (ex) { toast(ex.message, true); }
  });
}

// ---------- router ----------

async function route_() {
  const [path, qs] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  try {
    league = await api('GET', '/api/league');
    const name = parts[0] || 'home';
    renderChrome(name);
    if (name === 'team') await teamView(Number(parts[1]), q);
    else if (name === 'matchup') await matchupView(Number(parts[1]));
    else if (name === 'admin') await adminView(parts[1], q);
    else await homeView(q);
  } catch (ex) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="error">${esc(ex.message)}</p><a href="#/">Back to scoreboard</a></div>`;
  }
}

window.addEventListener('hashchange', route_);
route_();
