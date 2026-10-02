import { api, esc, toast, action, $, $$, fmt, playerCell, onLeave } from '../lib.js';
import { loadLeague, shell, STATUS } from './league.js';

export async function draftView(id) {
  let L = await loadLeague(id);
  const filter = { pos: '', text: '' };
  let st = null;
  let players = [];
  let clockOffset = 0;

  shell(L, 'draft', `
    <div id="clock"></div>
    <div class="draft-layout">
      <div class="card">
        <h2>Available players</h2>
        <div class="form-row filters">
          <div><label for="d-text">Search</label><input id="d-text" type="search" placeholder="Player name"></div>
          <div><label for="d-pos">Position</label><select id="d-pos"><option value="">All</option><option>QB</option><option>WR</option><option>TE</option><option>C</option></select></div>
        </div>
        <div class="table-wrap avail"><table>
          <thead><tr><th>Player</th><th class="num">Pts</th><th></th></tr></thead>
          <tbody id="avail"></tbody></table></div>
      </div>
      <div>
        <div class="card"><h2>My team</h2><div id="mine"></div></div>
      </div>
    </div>
    <div class="card"><h2>Draft board</h2><div class="table-wrap" id="board"></div></div>`);

  const myTurn = () => st && st.current && st.current.team.id === L.myTeamId;
  const canPick = () => st && st.status === 'drafting' && !st.paused && myTurn();

  function drawClock() {
    const el = $('#clock');
    if (!el) return;
    if (st.status === 'predraft') {
      el.innerHTML = L.isCommish ? `<div class="card">
        <h2>Draft order</h2>
        <p class="muted">${L.teams.length} teams · ${st.rounds} rounds · snake order · ${st.pickSeconds ? `${st.pickSeconds}s per pick` : 'no pick timer'}</p>
        <ol class="order" id="order">${st.order.map((t, i) => `<li data-id="${t.id}">
          <span>${esc(t.name)} <span class="muted small">${esc(t.owner)}</span></span>
          <span><button class="btn ghost small" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="btn ghost small" data-move="1" ${i === st.order.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></span></li>`).join('')}</ol>
        <div class="row-end"><button class="btn ghost" id="randomize">Randomize</button><button class="btn ghost" id="save-order">Save order</button>
        <button class="btn" id="start">Start draft</button></div>
        <p class="hint">Starting the draft locks in the order. Everyone in the league can watch live from this page.</p></div>`
        : `<div class="card banner"><strong>The draft hasn't started yet.</strong> Stay on this page. It updates live when the commissioner starts the draft.</div>`;
      bindOrder();
      return;
    }
    if (st.status === 'inseason') {
      el.innerHTML = `<div class="card banner"><strong>The draft is complete.</strong> <a href="#/l/${id}">See your league →</a></div>`;
      return;
    }
    const c = st.current;
    const left = secondsLeft();
    el.innerHTML = `<div class="card clock ${myTurn() ? 'my-turn' : ''}">
      <div>
        <div class="muted small">Round ${c.round} · Pick ${c.overall} of ${st.totalPicks}</div>
        <div class="on-clock">${myTurn() ? "You're on the clock!" : `${esc(c.team.name)} is on the clock`}</div>
      </div>
      <div class="timer ${left !== null && left <= 10 ? 'urgent' : ''}">${timerText(left)}</div>
      ${L.isCommish ? `<div class="commish-ctl">
        <button class="btn ghost small" id="pause">${st.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn ghost small" id="autopick" ${st.paused ? 'disabled' : ''}>Autopick for ${esc(c.team.name)}</button></div>` : ''}
    </div>`;
    $('#pause')?.addEventListener('click', action(async () => api('POST', `/api/leagues/${id}/draft/pause`, { paused: !st.paused })));
    $('#autopick')?.addEventListener('click', action(async () => api('POST', `/api/leagues/${id}/draft/pick`, { auto: true })));
  }

  function secondsLeft() {
    return st.deadline ? Math.max(0, Math.ceil((st.deadline - (Date.now() + clockOffset)) / 1000)) : null;
  }

  function timerText(left) {
    if (st.paused) return 'Paused';
    return left === null ? '∞' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  // Ticks the countdown without rebuilding the controls around it.
  function tickTimer() {
    const el = $('.timer');
    if (!el || !st || st.status !== 'drafting') return;
    const left = secondsLeft();
    el.textContent = timerText(left);
    el.classList.toggle('urgent', left !== null && left <= 10);
  }

  function bindOrder() {
    const ids = () => $$('#order li').map((li) => Number(li.dataset.id));
    $$('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const li = b.closest('li');
      const order = ids();
      const i = order.indexOf(Number(li.dataset.id));
      const j = i + Number(b.dataset.move);
      [order[i], order[j]] = [order[j], order[i]];
      st.order = order.map((tid) => st.order.find((t) => t.id === tid));
      drawClock();
    }));
    $('#randomize')?.addEventListener('click', action(async () => { await api('POST', `/api/leagues/${id}/draft/order`); toast('Order randomized'); }));
    $('#save-order')?.addEventListener('click', action(async () => { await api('POST', `/api/leagues/${id}/draft/order`, { team_ids: ids() }); toast('Order saved'); }));
    $('#start')?.addEventListener('click', action(async () => {
      if (!confirm('Start the draft now? Make sure everyone is here.')) return;
      await api('POST', `/api/leagues/${id}/draft/order`, { team_ids: ids() });
      await api('POST', `/api/leagues/${id}/draft/start`);
      await refresh();
    }));
  }

  function drawPlayers() {
    const taken = new Set(st.picks.map((p) => p.player_id));
    const list = players.filter((p) => !taken.has(p.id) && !p.owner_id
      && (!filter.pos || p.position === filter.pos) && (!filter.text || p.name.toLowerCase().includes(filter.text)));
    const enabled = canPick();
    $('#avail').innerHTML = list.slice(0, 200).map((p) => `<tr><td>${playerCell(p)}</td><td class="num">${fmt(p.seasonPts)}</td>
      <td class="num"><button class="btn small" data-pick="${p.id}" ${enabled ? '' : 'disabled'}>Draft</button></td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">No players match.</td></tr>';
  }

  function drawMine() {
    const mine = st.picks.filter((p) => p.team_id === L.myTeamId);
    const need = { QB: 1, WR: 3, TE: 1, C: 1 };
    for (const p of mine) need[p.position] = (need[p.position] || 0) - 1;
    const needs = Object.entries(need).filter(([, n]) => n > 0).map(([pos, n]) => `${n} ${pos}`).join(', ');
    $('#mine').innerHTML = L.myTeamId
      ? `${mine.length ? `<ul class="plain">${mine.map((p) => `<li><span class="muted small">R${p.round}</span> ${playerCell(p)}</li>`).join('')}</ul>` : '<p class="muted">No picks yet.</p>'}
        <p class="muted small">${needs ? `Starters still needed: ${needs}` : 'All starting spots filled.'}</p>`
      : '<p class="muted">You are watching this draft.</p>';
  }

  function drawBoard() {
    const order = st.order;
    const byPick = new Map(st.picks.map((p) => [p.overall, p]));
    const n = order.length;
    let html = `<table class="board"><thead><tr><th>Rd</th>${order.map((t) => `<th class="${t.id === L.myTeamId ? 'mine' : ''}">${esc(t.name)}</th>`).join('')}</tr></thead><tbody>`;
    for (let r = 1; r <= st.rounds; r++) {
      html += `<tr><td class="muted">${r}</td>`;
      for (let i = 0; i < n; i++) {
        const overall = (r - 1) * n + (r % 2 === 1 ? i + 1 : n - i);
        const p = byPick.get(overall);
        const now = st.current && st.current.overall === overall;
        html += `<td class="${now ? 'now' : ''} ${p ? `pos-${p.position}` : ''}">${p ? `<span class="pos">${p.position}</span> ${esc(p.name)}${p.auto ? ' <span class="muted small" title="Autopicked">auto</span>' : ''}` : now ? '<span class="muted">on the clock</span>' : ''}</td>`;
      }
      html += '</tr>';
    }
    $('#board').innerHTML = `${html}</tbody></table>`;
  }

  // Several change events can arrive at once; only the newest response is drawn.
  let seq = 0;
  async function refresh() {
    const mine = ++seq;
    const before = st && st.picks.length;
    const [s, p] = await Promise.all([api('GET', `/api/leagues/${id}/draft`), api('GET', `/api/leagues/${id}/players`)]);
    const statusChanged = st && st.status !== s.status;
    if (statusChanged) L = await loadLeague(id);
    if (mine !== seq) return;
    if (statusChanged) {
      const pill = $('.league-head .pill');
      if (pill) { pill.textContent = STATUS[s.status]; pill.classList.toggle('live', s.status === 'drafting'); }
    }
    st = s;
    players = p;
    clockOffset = st.now - Date.now();
    if (!$('#clock')) return; // navigated away
    drawClock(); drawPlayers(); drawMine(); drawBoard();
    if (before != null && st.picks.length > before) {
      const last = st.picks[st.picks.length - 1];
      toast(`${st.order.find((t) => t.id === last.team_id)?.name} drafted ${last.name}`);
    }
  }

  $('#d-text').addEventListener('input', (e) => { filter.text = e.target.value.trim().toLowerCase(); drawPlayers(); });
  $('#d-pos').addEventListener('change', (e) => { filter.pos = e.target.value; drawPlayers(); });
  $('#avail').addEventListener('click', action(async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    await api('POST', `/api/leagues/${id}/draft/pick`, { player_id: Number(b.dataset.pick) });
  }));

  await refresh();

  // live updates + countdown; both stop when the user leaves the page
  const es = new EventSource(`/api/leagues/${id}/events`);
  es.onmessage = () => refresh().catch(() => {});
  const timer = setInterval(tickTimer, 1000);
  onLeave(() => { es.close(); clearInterval(timer); });
}
