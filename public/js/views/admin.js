// Site admin: the real MFL that every fantasy league uses.
import { api, view, esc, toast, session, action, $, $$, weekPicker, bindWeekPicker, timeAgo } from '../lib.js';

const TABS = [['weeks', 'Season'], ['stats', 'Stats'], ['players', 'Players'], ['teams', 'MFL Teams'], ['users', 'Users']];
const POS = ['QB', 'WR', 'TE', 'C'];

export async function adminView(tab, q) {
  if (!session.user.isAdmin) {
    view.innerHTML = '<div class="card"><h2>Site admins only</h2></div>';
    return;
  }
  tab = TABS.some(([k]) => k === tab) ? tab : 'weeks';
  view.innerHTML = `<h1>MFL admin</h1>
    <p class="muted">Manage the real league here: players, weekly stats and the season calendar. Every fantasy league uses this data.</p>
    <div class="tabs">${TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div id="tab"></div>`;
  await ({ weeks, stats, players, teams, users })[tab]($('#tab'), q);
}

const teamOptions = (sel) => `<option value="" ${sel == null ? 'selected' : ''}>None</option>`
  + session.mfl.teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
const posOptions = (sel) => POS.map((p) => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');

async function refreshMfl() {
  session.mfl = await api('GET', '/api/mfl');
}

async function weeks(el) {
  const s = await api('GET', '/api/admin/season');
  el.innerHTML = `
    <div class="card"><h2>Weekly routine</h2>
      <ol class="steps">
        <li><strong>Before kickoff:</strong> managers set lineups and make moves.</li>
        <li><strong>At kickoff:</strong> <em>Lock</em> the week. Lineups freeze and roster moves pause.</li>
        <li><strong>After the games:</strong> enter stats on the Stats tab, then mark the week <em>Final</em>. It counts in every league's standings.</li>
        <li><strong>Advance</strong> to the next week. Waiver claims run in every league.</li>
      </ol></div>
    <div class="card"><h2>Current week: ${s.currentWeek}</h2>
      <div class="row-start">
        <button class="btn" id="advance" ${s.currentWeek >= s.seasonWeeks ? 'disabled' : ''}>Advance to week ${s.currentWeek + 1}</button>
        <button class="btn ghost" id="back" ${s.currentWeek <= 1 ? 'disabled' : ''}>Back to week ${s.currentWeek - 1}</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Week</th><th>Locked</th><th>Final</th></tr></thead>
        <tbody>${s.weeks.map((w) => `<tr class="${w.week === s.currentWeek ? 'mine' : ''}"><td>Week ${w.week}${w.week === s.currentWeek ? ' (current)' : ''}</td>
          <td><input type="checkbox" data-week="${w.week}" data-f="locked" ${w.locked ? 'checked' : ''} ${w.final ? 'disabled' : ''} aria-label="Week ${w.week} locked"></td>
          <td><input type="checkbox" data-week="${w.week}" data-f="final" ${w.final ? 'checked' : ''} aria-label="Week ${w.week} final"></td></tr>`).join('')}</tbody>
      </table></div></div>
    <div class="card"><h2>Season length</h2>
      <form id="len" class="form-row"><div><label for="sw">Weeks</label><input id="sw" type="number" min="1" max="30" value="${s.seasonWeeks}"></div>
      <button class="btn">Save</button></form>
      <p class="hint">This can only change before any fantasy league drafts.</p></div>`;

  const setWeek = (w) => action(async () => {
    await api('PUT', '/api/admin/current-week', { week: w });
    await refreshMfl();
    toast(`Now in week ${w}`);
    weeks(el);
  });
  $('#advance', el).addEventListener('click', async (e) => {
    if (confirm(`Advance to week ${s.currentWeek + 1}? Waiver claims in every league will be processed.`)) await setWeek(s.currentWeek + 1)(e);
  });
  $('#back', el).addEventListener('click', setWeek(s.currentWeek - 1));
  $$('[data-week]', el).forEach((cb) => cb.addEventListener('change', action(async () => {
    try {
      await api('PUT', `/api/admin/weeks/${cb.dataset.week}`, { [cb.dataset.f]: cb.checked });
    } catch (ex) { cb.checked = !cb.checked; throw ex; }
    await refreshMfl();
    toast(`Week ${cb.dataset.week} updated`);
    weeks(el);
  })));
  $('#len', el).addEventListener('submit', action(async () => {
    await api('PUT', '/api/admin/season-weeks', { season_weeks: Number($('#sw', el).value) });
    await refreshMfl();
    toast('Season length saved');
    weeks(el);
  }));
}

async function stats(el, q) {
  const week = Number(q.get('week')) || session.mfl.currentWeek;
  const [plist, st] = await Promise.all([api('GET', '/api/admin/players'), api('GET', `/api/admin/stats?week=${week}`)]);
  const byPlayer = new Map(st.rows.map((r) => [r.player_id, r]));
  const fields = session.mfl.statFields;
  const list = plist.filter((p) => p.active || byPlayer.has(p.id));

  el.innerHTML = `
    <div class="page-head">
      <div><h2 class="flush">Week ${week} stats</h2>
        <span class="muted">${st.final ? 'This week is final. Uncheck Final on the Season tab to edit.' : 'Leave a row blank if the player did not play.'}</span></div>
      ${weekPicker(week, session.mfl.seasonWeeks)}
    </div>
    <div class="card">
      <div class="table-wrap"><table class="stat-grid">
        <thead><tr><th>Player</th><th>Team</th>${fields.map((f) => `<th class="num">${esc(session.mfl.statLabels[f])}</th>`).join('')}</tr></thead>
        <tbody>${list.map((p) => {
          const s = byPlayer.get(p.id);
          return `<tr data-id="${p.id}"><td class="name"><span class="pos">${p.position}</span> ${esc(p.name)}</td><td>${esc(p.mfl_short || '–')}</td>
            ${fields.map((f) => `<td><input type="number" step="any" inputmode="decimal" data-f="${f}" value="${s ? s[f] : ''}"
              ${st.final ? 'disabled' : ''} aria-label="${esc(p.name)} ${esc(session.mfl.statLabels[f])}"></td>`).join('')}</tr>`;
        }).join('') || `<tr><td colspan="${fields.length + 2}" class="muted">Add players on the Players tab first.</td></tr>`}</tbody>
      </table></div>
      ${st.final ? '' : '<div class="row-end"><button class="btn" id="save">Save stats</button></div>'}
    </div>`;
  bindWeekPicker('#/admin/stats');
  $('#save', el)?.addEventListener('click', action(async () => {
    const rows = $$('tbody tr[data-id]', el).map((tr) => {
      const row = { player_id: Number(tr.dataset.id) };
      $$('[data-f]', tr).forEach((i) => { row[i.dataset.f] = i.value; });
      return row;
    });
    await api('PUT', '/api/admin/stats', { week, rows });
    toast('Stats saved');
  }));
}

async function players(el) {
  const list = await api('GET', '/api/admin/players');
  el.innerHTML = `
    <div class="card"><h2>Add player</h2>
      <form id="add" class="form-row">
        <div><label for="np-name">Name</label><input id="np-name" name="name" required maxlength="60"></div>
        <div><label for="np-pos">Position</label><select id="np-pos" name="position">${posOptions('WR')}</select></div>
        <div><label for="np-team">MFL team</label><select id="np-team" name="mfl_team_id">${teamOptions(null)}</select></div>
        <button class="btn">Add</button>
      </form></div>
    <div class="card"><h2>All players (${list.length})</h2>
      <p class="muted">${session.mfl.teams.map((t) => `${esc(t.short)}: ${list.filter((p) => p.active && p.mfl_team_id === t.id).length}`).join(' · ')}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Pos</th><th>MFL team</th><th>Active</th></tr></thead>
        <tbody>${list.map((p) => `<tr data-id="${p.id}">
          <td><input data-f="name" value="${esc(p.name)}" maxlength="60"></td>
          <td><select data-f="position">${posOptions(p.position)}</select></td>
          <td><select data-f="mfl_team_id">${teamOptions(p.mfl_team_id)}</select></td>
          <td><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''} aria-label="Active"></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint">Changes save as soon as you edit a field. Inactive players can't be drafted or added, but they keep their stats.</p></div>`;
  $('#add', el).addEventListener('submit', action(async (e) => {
    await api('POST', '/api/admin/players', Object.fromEntries(new FormData(e.target)));
    toast('Player added');
    await players(el);
    $('#np-name', el).focus();
  }));
  $$('[data-f]', el).forEach((input) => input.addEventListener('change', action(async () => {
    const value = input.type === 'checkbox' ? input.checked : input.value;
    await api('PATCH', `/api/admin/players/${input.closest('tr').dataset.id}`, { [input.dataset.f]: value });
    toast('Saved');
  })));
}

async function teams(el) {
  el.innerHTML = `<div class="card"><h2>MFL teams</h2>
    <p class="muted">These are the real MFL franchises that players play for.</p>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Abbr.</th><th>Color</th><th></th></tr></thead>
    <tbody>${session.mfl.teams.map((t) => `<tr data-id="${t.id}">
      <td><input data-f="name" value="${esc(t.name)}" maxlength="60" style="min-width:220px"></td>
      <td><input data-f="short" value="${esc(t.short)}" maxlength="4" size="5"></td>
      <td><input data-f="color" type="color" value="${esc(t.color)}"></td>
      <td><button class="btn ghost small" data-save>Save</button></td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-save]', el).forEach((b) => b.addEventListener('click', action(async () => {
    const tr = b.closest('tr');
    const body = Object.fromEntries($$('[data-f]', tr).map((i) => [i.dataset.f, i.value]));
    await api('PATCH', `/api/admin/mfl-teams/${tr.dataset.id}`, body);
    await refreshMfl();
    toast('Team saved');
  })));
}

async function users(el) {
  const list = await api('GET', '/api/admin/users');
  el.innerHTML = `<div class="card"><h2>Users (${list.length})</h2>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Site admin</th></tr></thead>
    <tbody>${list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td class="muted">${timeAgo(u.created_at)}</td>
      <td><input type="checkbox" data-user="${u.id}" ${u.is_admin ? 'checked' : ''} ${u.id === session.user.id ? 'disabled' : ''} aria-label="Admin"></td></tr>`).join('')}</tbody>
    </table></div></div>`;
  $$('[data-user]', el).forEach((cb) => cb.addEventListener('change', action(async () => {
    await api('PATCH', `/api/admin/users/${cb.dataset.user}`, { is_admin: cb.checked });
    toast('Saved');
  })));
}

