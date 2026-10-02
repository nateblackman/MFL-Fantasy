const test = require('node:test');
const assert = require('node:assert');
const { openDb, seedIfEmpty } = require('../src/db');
const { createApp } = require('../server');

async function startServer() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const outbox = [];
  const mailer = { send: async (m) => { outbox.push(m); } };
  const server = createApp(db, { mailer, appUrl: 'http://test' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    };
  }
  return { db, server, client, outbox };
}

const ok = (r, status = 200) => {
  assert.strictEqual(r.status, status, JSON.stringify(r.body));
  return r.body;
};

test('accounts', async (t) => {
  const { server, client, outbox } = await startServer();
  t.after(() => server.close());
  const a = client();
  const b = client();

  await t.test('first signup becomes site admin, later ones do not', async () => {
    assert.strictEqual(ok(await a('POST', '/api/auth/signup', { email: 'Ann@x.com', name: 'Ann', password: 'password1' }), 201).user.isAdmin, true);
    assert.strictEqual(ok(await b('POST', '/api/auth/signup', { email: 'bo@x.com', name: 'Bo', password: 'password1' }), 201).user.isAdmin, false);
  });

  await t.test('signup validation', async () => {
    const c = client();
    assert.strictEqual((await c('POST', '/api/auth/signup', { email: 'ann@x.com', name: 'A', password: 'password1' })).status, 400);
    assert.strictEqual((await c('POST', '/api/auth/signup', { email: 'new@x.com', name: 'A', password: 'short' })).status, 400);
    assert.strictEqual((await c('POST', '/api/auth/signup', { email: 'nope', name: 'A', password: 'password1' })).status, 400);
  });

  await t.test('login, logout and protected routes', async () => {
    const c = client();
    assert.strictEqual((await c('GET', '/api/leagues')).status, 401);
    assert.strictEqual((await c('POST', '/api/auth/login', { email: 'bo@x.com', password: 'wrong-pass' })).status, 401);
    ok(await c('POST', '/api/auth/login', { email: 'BO@x.com', password: 'password1' }));
    ok(await c('GET', '/api/leagues'));
    assert.strictEqual((await c('GET', '/api/admin/players')).status, 403);
    ok(await c('POST', '/api/auth/logout'));
    assert.strictEqual((await c('GET', '/api/leagues')).status, 401);
  });

  await t.test('password reset by email', async () => {
    ok(await client()('POST', '/api/auth/forgot', { email: 'nobody@x.com' }));
    assert.strictEqual(outbox.length, 0);
    ok(await client()('POST', '/api/auth/forgot', { email: 'bo@x.com' }));
    const token = outbox[0].text.match(/token=([0-9a-f]+)/)[1];
    const c = client();
    ok(await c('POST', '/api/auth/reset', { token, password: 'newpassword' }));
    assert.strictEqual((await c('POST', '/api/auth/reset', { token, password: 'again12345' })).status, 400);
    assert.strictEqual((await b('GET', '/api/leagues')).status, 401, 'old sessions are signed out');
    ok(await client()('POST', '/api/auth/login', { email: 'bo@x.com', password: 'newpassword' }));
  });

  await t.test('rejects non-JSON writes (CSRF guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/logout`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1',
    });
    assert.strictEqual(res.status, 415);
  });
});

test('league season: draft, waivers, trades, lineups, standings', async (t) => {
  const { server, client } = await startServer();
  t.after(() => server.close());

  const admin = client();
  const users = [client(), client(), client()];
  ok(await admin('POST', '/api/auth/signup', { email: 'admin@x.com', name: 'Admin', password: 'password1' }), 201);
  for (const [i, u] of users.entries()) {
    ok(await u('POST', '/api/auth/signup', { email: `u${i}@x.com`, name: `User ${i}`, password: 'password1' }), 201);
  }
  const [ann, bo, cy] = users;

  // 6 QB, 16 WR, 6 TE, 6 C spread over the MFL teams
  const playerIds = { QB: [], WR: [], TE: [], C: [] };
  for (const [pos, n] of [['QB', 6], ['WR', 16], ['TE', 6], ['C', 6]]) {
    for (let i = 0; i < n; i++) {
      const r = ok(await admin('POST', '/api/admin/players', { name: `${pos} ${i}`, position: pos, mfl_team_id: (i % 6) + 1 }), 201);
      playerIds[pos].push(r.id);
    }
  }
  // QB 0 had a big week 1 last... give some prior stats so autopick has a ranking
  ok(await admin('PUT', '/api/admin/stats', { week: 1, rows: [{ player_id: playerIds.QB[5], pass_td: 5 }] }));

  let leagueId;
  let invite;
  await t.test('create and join a league', async () => {
    assert.strictEqual((await ann('POST', '/api/leagues', { name: 'L', team_name: 'T', roster_size: 3 })).status, 400);
    leagueId = ok(await ann('POST', '/api/leagues', { name: 'Friends', team_name: 'Ann FC', max_teams: 4, roster_size: 7, pick_seconds: 0 }), 201).id;
    invite = ok(await ann('GET', `/api/leagues/${leagueId}`)).league.inviteCode;
    assert.strictEqual((await bo('GET', `/api/leagues/${leagueId}`)).status, 403);
    assert.strictEqual(ok(await bo('GET', `/api/leagues/invite/${invite}`)).name, 'Friends');
    ok(await bo('POST', '/api/leagues/join', { code: invite.toLowerCase(), team_name: 'Bo Bros' }), 201);
    ok(await cy('POST', '/api/leagues/join', { code: invite, team_name: 'Cy Squad' }), 201);
    assert.strictEqual((await cy('POST', '/api/leagues/join', { code: invite, team_name: 'Again' })).status, 409);
    ok(await admin('POST', '/api/leagues/join', { code: invite, team_name: 'Admin United' }), 201);
    const extra = client();
    ok(await extra('POST', '/api/auth/signup', { email: 'late@x.com', name: 'Late', password: 'password1' }), 201);
    assert.strictEqual((await extra('POST', '/api/leagues/join', { code: invite, team_name: 'Late' })).status, 409);
  });

  let teams;
  const teamOf = (name) => teams.find((x) => x.name === name);
  await t.test('snake draft', async () => {
    teams = ok(await ann('GET', `/api/leagues/${leagueId}`)).teams;
    const order = ['Ann FC', 'Bo Bros', 'Cy Squad', 'Admin United'].map((n) => teamOf(n).id);
    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/draft/start`)).status, 403);
    ok(await ann('POST', `/api/leagues/${leagueId}/draft/order`, { team_ids: order }));
    ok(await ann('POST', `/api/leagues/${leagueId}/draft/start`));

    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: playerIds.QB[0] })).status, 403);
    ok(await ann('POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: playerIds.QB[0] }));
    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: playerIds.QB[0] })).status, 409);
    ok(await bo('POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: playerIds.QB[1] }));
    ok(await cy('POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: playerIds.QB[2] }));

    // snake: Admin United picks 4th and 5th
    let st = ok(await ann('GET', `/api/leagues/${leagueId}/draft`));
    assert.strictEqual(st.current.team.name, 'Admin United');
    ok(await admin('POST', `/api/leagues/${leagueId}/draft/pick`, { auto: true }));
    st = ok(await ann('GET', `/api/leagues/${leagueId}/draft`));
    assert.strictEqual(st.current.team.name, 'Admin United');
    assert.strictEqual(st.picks[3].player_id, playerIds.QB[5], 'autopick takes the top scorer at a needed position');

    // commissioner autopicks the rest of the draft
    while (st.status === 'drafting') {
      ok(await ann('POST', `/api/leagues/${leagueId}/draft/pick`, { auto: true }));
      st = ok(await ann('GET', `/api/leagues/${leagueId}/draft`));
    }
    assert.strictEqual(st.picks.length, 28);
    const league = ok(await ann('GET', `/api/leagues/${leagueId}`));
    assert.strictEqual(league.league.status, 'inseason');
    assert.strictEqual(league.league.startWeek, 1);
    const board = ok(await ann('GET', `/api/leagues/${leagueId}/scoreboard?week=1`));
    assert.strictEqual(board.matchups.length, 2);
  });

  await t.test('autodrafted rosters fill every starting slot', async () => {
    for (const tm of teams) {
      const team = ok(await ann('GET', `/api/leagues/${leagueId}/teams/${tm.id}?week=1`));
      assert.strictEqual(team.roster.length, 7);
      assert.ok(team.lineup.slots.every((s) => s.player), `${tm.name} has an empty slot`);
    }
  });

  const rosterIds = async (c, teamName) =>
    ok(await c('GET', `/api/leagues/${leagueId}/teams/${teamOf(teamName).id}`)).roster.map((p) => p.id);
  const freeAgents = async () =>
    ok(await ann('GET', `/api/leagues/${leagueId}/players`)).filter((p) => !p.owner_id && !p.on_waivers);

  let dropped;
  await t.test('free agency and waivers', async () => {
    const fa = (await freeAgents())[0];
    const annRoster = await rosterIds(ann, 'Ann FC');
    assert.strictEqual((await ann('POST', `/api/leagues/${leagueId}/add`, { add_player_id: fa.id })).status, 409, 'roster full');
    dropped = annRoster[annRoster.length - 1];
    ok(await ann('POST', `/api/leagues/${leagueId}/add`, { add_player_id: fa.id, drop_player_id: dropped }));
    assert.ok((await rosterIds(ann, 'Ann FC')).includes(fa.id));

    // the dropped player is on waivers: no instant add, only claims
    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/add`, { add_player_id: dropped, drop_player_id: (await rosterIds(bo, 'Bo Bros'))[6] })).status, 409);
    const boDrop = (await rosterIds(bo, 'Bo Bros'))[6];
    const cyDrop = (await rosterIds(cy, 'Cy Squad'))[6];
    ok(await bo('POST', `/api/leagues/${leagueId}/claims`, { add_player_id: dropped, drop_player_id: boDrop }), 201);
    ok(await cy('POST', `/api/leagues/${leagueId}/claims`, { add_player_id: dropped, drop_player_id: cyDrop }), 201);

    // priority is reverse draft order: Admin 1, Cy 2, Bo 3, Ann 4, so Cy wins
    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/waivers/process`)).status, 403);
    assert.strictEqual(ok(await ann('POST', `/api/leagues/${leagueId}/waivers/process`)).awarded, 1);
    assert.ok((await rosterIds(cy, 'Cy Squad')).includes(dropped));
    assert.ok(!(await rosterIds(cy, 'Cy Squad')).includes(cyDrop));
    const boTeam = ok(await bo('GET', `/api/leagues/${leagueId}/teams/${teamOf('Bo Bros').id}`));
    assert.strictEqual(boTeam.claims[0].status, 'lost');
    const cyTeam = ok(await cy('GET', `/api/leagues/${leagueId}/teams/${teamOf('Cy Squad').id}`));
    assert.strictEqual(cyTeam.team.waiverPriority, 4, 'winner moves to the back');
  });

  await t.test('trades', async () => {
    const [a1] = await rosterIds(ann, 'Ann FC');
    const [b1] = await rosterIds(bo, 'Bo Bros');
    const to = teamOf('Bo Bros').id;
    assert.strictEqual((await ann('POST', `/api/leagues/${leagueId}/trades`, { to_team_id: to, give: [b1], get: [] })).status, 400);
    const tradeId = ok(await ann('POST', `/api/leagues/${leagueId}/trades`, { to_team_id: to, give: [a1], get: [b1] }), 201).id;
    assert.strictEqual((await ann('POST', `/api/leagues/${leagueId}/trades/${tradeId}/accept`)).status, 403);
    assert.strictEqual((await cy('POST', `/api/leagues/${leagueId}/trades/${tradeId}/accept`)).status, 403);
    ok(await bo('POST', `/api/leagues/${leagueId}/trades/${tradeId}/accept`));
    assert.ok((await rosterIds(ann, 'Ann FC')).includes(b1));
    assert.ok((await rosterIds(bo, 'Bo Bros')).includes(a1));
    assert.strictEqual((await bo('POST', `/api/leagues/${leagueId}/trades/${tradeId}/accept`)).status, 409);
  });

  await t.test('lineups, locking and standings', async () => {
    const annId = teamOf('Ann FC').id;
    const team = ok(await ann('GET', `/api/leagues/${leagueId}/teams/${annId}?week=2`));
    const qb = team.roster.find((p) => p.position === 'QB');
    const slots = Object.fromEntries(team.lineup.slots.map((s) => [s.slot, s.player && s.player.id]));
    slots.QB = qb.id;
    assert.strictEqual((await bo('PUT', `/api/leagues/${leagueId}/teams/${annId}/lineup`, { week: 2, slots })).status, 403);
    const wr = team.roster.find((p) => p.position === 'WR');
    assert.strictEqual((await ann('PUT', `/api/leagues/${leagueId}/teams/${annId}/lineup`, { week: 2, slots: { ...slots, TE: wr.id } })).status, 400);
    ok(await ann('PUT', `/api/leagues/${leagueId}/teams/${annId}/lineup`, { week: 2, slots }));

    // week 1: enter stats, lock, finalize
    ok(await admin('PUT', '/api/admin/stats', { week: 1, rows: [{ player_id: qb.id, pass_td: 3 }] }));
    ok(await admin('PUT', '/api/admin/weeks/1', { locked: true }));
    assert.strictEqual((await ann('PUT', `/api/leagues/${leagueId}/teams/${annId}/lineup`, { week: 1, slots })).status, 409);
    const fa = (await freeAgents())[0];
    assert.strictEqual((await ann('POST', `/api/leagues/${leagueId}/add`, { add_player_id: fa.id, drop_player_id: qb.id })).status, 409, 'moves paused while locked');

    let st = ok(await ann('GET', `/api/leagues/${leagueId}/standings`));
    assert.ok(st.every((r) => r.w + r.l + r.t === 0));
    ok(await admin('PUT', '/api/admin/weeks/1', { final: true }));
    ok(await admin('PUT', '/api/admin/current-week', { week: 2 }));
    st = ok(await ann('GET', `/api/leagues/${leagueId}/standings`));
    assert.strictEqual(st.reduce((n, r) => n + r.w + r.l + r.t, 0), 4);
    assert.ok(st.find((r) => r.team.id === annId).pf >= 12);
  });
});

test('pick timer autopicks when it runs out', async (t) => {
  const { db, server, client } = await startServer();
  t.after(() => server.close());
  const draft = require('../src/draft');
  const a = client();
  const b = client();
  ok(await a('POST', '/api/auth/signup', { email: 'a@x.com', name: 'A', password: 'password1' }), 201);
  ok(await b('POST', '/api/auth/signup', { email: 'b@x.com', name: 'B', password: 'password1' }), 201);
  for (const pos of ['QB', 'QB', 'WR', 'WR', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'C', 'C']) {
    ok(await a('POST', '/api/admin/players', { name: `${pos} x`, position: pos }), 201);
  }
  const id = ok(await a('POST', '/api/leagues', { name: 'T', team_name: 'A', max_teams: 2, roster_size: 6, pick_seconds: 30 }), 201).id;
  ok(await b('POST', '/api/leagues/join', { code: ok(await a('GET', `/api/leagues/${id}`)).league.inviteCode, team_name: 'B' }), 201);
  ok(await a('POST', `/api/leagues/${id}/draft/start`));

  draft.tick(db);
  assert.strictEqual(ok(await a('GET', `/api/leagues/${id}/draft`)).picks.length, 0, 'nothing happens before the deadline');
  db.prepare('UPDATE leagues SET pick_deadline = ? WHERE id = ?').run(Date.now() - 1, id);
  draft.tick(db);
  const st = ok(await a('GET', `/api/leagues/${id}/draft`));
  assert.strictEqual(st.picks.length, 1);
  assert.strictEqual(st.picks[0].auto, 1);
  assert.ok(st.deadline > Date.now(), 'the next pick gets a fresh clock');

  ok(await a('POST', `/api/leagues/${id}/draft/pause`, { paused: true }));
  db.prepare('UPDATE leagues SET pick_deadline = ? WHERE id = ?').run(Date.now() - 1, id);
  draft.tick(db);
  assert.strictEqual(ok(await a('GET', `/api/leagues/${id}/draft`)).picks.length, 1, 'paused drafts do not autopick');
});

test('login limiter counts only failures', async (t) => {
  const { server, client } = await startServer();
  t.after(() => server.close());
  const c = client();
  ok(await c('POST', '/api/auth/signup', { email: 'a@x.com', name: 'A', password: 'password1' }), 201);
  for (let i = 0; i < 20; i++) ok(await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'password1' }));
  for (let i = 0; i < 15; i++) assert.strictEqual((await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'nope' })).status, 401);
  assert.strictEqual((await client()('POST', '/api/auth/login', { email: 'a@x.com', password: 'password1' })).status, 429);
});
