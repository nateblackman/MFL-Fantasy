const test = require('node:test');
const assert = require('node:assert');
const { openDb, seedIfEmpty } = require('../src/db');
const { createApp } = require('../server');

async function startLeague() {
  const db = openDb(':memory:');
  seedIfEmpty(db, { commishPin: '9999', teamPins: ['1111', '2222', '3333', '4444', '5555', '6666'] });
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    };
  }
  return { db, server, client };
}

test('league API end to end', async (t) => {
  const { server, client } = await startLeague();
  t.after(() => server.close());

  const anon = client();
  const commish = client();
  const team1 = client();

  await t.test('anonymous users can read but not write', async () => {
    const league = await anon('GET', '/api/league');
    assert.strictEqual(league.status, 200);
    assert.strictEqual(league.body.teams.length, 6);
    assert.strictEqual(league.body.teams[0].name, 'Loot Lake LLamas');
    assert.strictEqual((await anon('POST', '/api/admin/players', { name: 'X', position: 'QB' })).status, 401);
    assert.strictEqual((await anon('PUT', '/api/teams/1/lineup', { week: 1, slots: {} })).status, 401);
  });

  await t.test('wrong PIN is rejected', async () => {
    assert.strictEqual((await anon('POST', '/api/auth/login', { pin: '0000' })).status, 401);
  });

  const ids = {};
  await t.test('commissioner adds players', async () => {
    assert.strictEqual((await commish('POST', '/api/auth/login', { pin: '9999' })).status, 200);
    for (const [name, position, team_id] of [
      ['Quinn', 'QB', 1], ['Will', 'WR', 1], ['Wes', 'WR', 1], ['Wade', 'WR', 1], ['Ty', 'TE', 1], ['Cal', 'C', 1],
      ['Other', 'WR', 2],
    ]) {
      const r = await commish('POST', '/api/admin/players', { name, position, team_id });
      assert.strictEqual(r.status, 201);
      ids[name] = r.body.id;
    }
  });

  const lineup = () => ({ QB: ids.Quinn, WR1: ids.Will, WR2: ids.Wes, WR3: ids.Wade, TE: ids.Ty, C: ids.Cal });

  await t.test('a team that never set a lineup starts its roster by position', async () => {
    const team = await anon('GET', '/api/teams/1?week=1');
    assert.deepStrictEqual(team.body.lineup.slots.map((s) => s.player && s.player.id), Object.values(lineup()));
  });

  await t.test('team PIN can only edit its own lineup', async () => {
    assert.strictEqual((await team1('POST', '/api/auth/login', { pin: '1111' })).status, 200);
    assert.strictEqual((await team1('PUT', '/api/teams/2/lineup', { week: 1, slots: {} })).status, 401);
    assert.strictEqual((await team1('PUT', '/api/admin/players/1', { name: 'x' })).status, 401);
  });

  await t.test('lineup validation', async () => {
    const wrongPos = { ...lineup(), TE: ids.Will, WR1: null };
    assert.strictEqual((await team1('PUT', '/api/teams/1/lineup', { week: 1, slots: wrongPos })).status, 400);
    const notMine = { ...lineup(), WR1: ids.Other };
    assert.strictEqual((await team1('PUT', '/api/teams/1/lineup', { week: 1, slots: notMine })).status, 400);
    const dupe = { ...lineup(), WR2: ids.Will };
    assert.strictEqual((await team1('PUT', '/api/teams/1/lineup', { week: 1, slots: dupe })).status, 400);
    assert.strictEqual((await team1('PUT', '/api/teams/1/lineup', { week: 1, slots: lineup() })).status, 200);
  });

  await t.test('stats score the lineup, lock the slot, and count once final', async () => {
    const r = await commish('PUT', '/api/admin/stats', {
      week: 1,
      rows: [{ player_id: ids.Quinn, pass_yds: 250, pass_td: 3, pass_int: 1, rush_yds: 20 }],
    });
    assert.strictEqual(r.status, 200);

    const team = await anon('GET', '/api/teams/1?week=1');
    assert.strictEqual(team.body.lineup.total, 22);
    assert.strictEqual(team.body.lineup.slots[0].locked, true);

    const swap = { ...lineup(), QB: null };
    assert.strictEqual((await team1('PUT', '/api/teams/1/lineup', { week: 1, slots: swap })).status, 409);

    let st = await anon('GET', '/api/standings');
    assert.ok(st.body.every((row) => row.w + row.l + row.t === 0));

    assert.strictEqual((await commish('PUT', '/api/admin/weeks/1/final', { final: true })).status, 200);
    st = await anon('GET', '/api/standings');
    assert.strictEqual(st.body[0].team.id, 1);
    assert.strictEqual(st.body[0].w, 1);
    assert.strictEqual(st.body[0].pf, 22);
  });

  await t.test('lineup carries forward to the next week', async () => {
    const team = await anon('GET', '/api/teams/1?week=2');
    assert.strictEqual(team.body.lineup.slots[0].player.id, ids.Quinn);
    assert.strictEqual(team.body.lineup.slots[0].locked, false);
  });

  await t.test('team PIN changes must be unique', async () => {
    assert.strictEqual((await commish('PATCH', '/api/admin/teams/1', { pin: '2222' })).status, 400);
    assert.strictEqual((await commish('PATCH', '/api/admin/teams/1', { pin: '7777' })).status, 200);
  });
});
