import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapStorage, Store } from '../../src/online/files.js';
import { hex } from '../../src/online/jsx.js';
import {
  Stats,
  RACE_TYPES,
  OUT,
  racePoints,
  decodeResult,
  nodeBase64,
  monthBefore,
  ReportPlayer,
  finished,
  racedToTheEnd,
} from '../../src/online/stats.js';

const T0 = 1792411200000; // Date.UTC(2026, 9, 19, 12)

function clocks(cell) {
  return { now: () => cell.t, timer: () => cell.t };
}
const quiet = () => {};

function race(kind, ranked, track, players) {
  return { kind, ranked, track, players: players.map(([name, place, time]) => ({ name, place, time, left: place === 0 })) };
}

function hexes(s) {
  return s.split(',').filter((x) => x !== '').map((x) => parseInt(x, 16));
}

function newStore() {
  const storage = new MapStorage();
  return { storage, store: new Store(storage) };
}

const b64 = (b) => Buffer.from(Uint8Array.from(b)).toString('base64');

// counts, points, STAT, boards, months
test('counts_points_stat_boards_months', () => {
  const t = { t: T0 };
  const st = new Stats({ store: null, clocks: clocks(t), log: quiet });
  st.addRace(race(0, true, 4014, [['Alpha', 1, 100.0], ['Bravo', 2, 101.0], ['Charlie', 0, 0.0]]));
  st.addRace(race(0, false, 4014, [['Bravo', 1, 99.5], ['Alpha', 2, 102.0]]));
  const b = st.board(0, 'all');
  assert.deepEqual(
    b.map((r) => [r.name, r.points, r.wins, r.losses, r.races]),
    [
      ['Alpha', 100, 1, 1, 2],
      ['Bravo', 50, 1, 1, 2],
      ['Charlie', 0, 0, 1, 1],
    ],
  );
  const stat = st.statField('alpha', false);
  assert.equal(stat.split(',').length, 39);
  assert.ok(stat.endsWith(','));
  assert.deepEqual(hexes(stat).slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(hexes(st.statField('Charlie', false)).slice(0, 2), [0, 1], 'a dropped race: a disconnect');
  assert.deepEqual(hexes(stat).slice(8, 13), [100, 1, 0, 0, 1]);
  assert.equal(st.rec('Bravo', false).best.get('0:4014'), 99.5);
  assert.equal(st.statField('nobody', false), '0,'.repeat(38));
  assert.equal(st.board(0, 'lastMonth').length, 0, 'no month before kept yet');
  t.t = 1793577600000; // Date.UTC(2026, 10, 2)
  assert.equal(st.board(0, 'month').length, 0);
  assert.equal(st.board(0, 'all').length, 3);
  assert.equal(st.board(0, 'lastMonth').length, 0, 'October 2026: not shown');
  const alpha = st.rec('Alpha', false);
  assert.deepEqual([alpha.lastKey, alpha.last[0] && alpha.last[0].points], ['2026-10', 100], 'but kept');
  assert.equal(st.statField('Alpha', true), '0,'.repeat(38));
  st.addRace(race(1, false, 1, [['Alpha', 1, 50.0], ['Bravo', 2, 51.0]]));
  assert.equal(st.board(1, 'month')[0].name, 'Alpha');
  assert.equal(st.board(1, 'lastMonth').length, 0, "this month's race is not last month's");
  t.t = 1796169600000; // Date.UTC(2026, 11, 2)
  assert.deepEqual(st.board(1, 'lastMonth').map((r) => r.name), ['Alpha', 'Bravo']);
  assert.equal(st.board(0, 'lastMonth').length, 0);
  assert.ok(st.rec('Charlie', false).last.every((c) => c === null));
  t.t = 1801440000000; // Date.UTC(2027, 1, 1)
  for (let k = 0; k < 6; k++) assert.equal(st.board(k, 'lastMonth').length, 0);
});

test('last_month_saved_and_read_back', () => {
  const { storage, store } = newStore();
  const t = { t: 1796083200000 }; // Date.UTC(2026, 11, 1): December
  const opts = () => ({ store, clocks: clocks(t), log: quiet });
  const a = new Stats(opts());
  a.addRace(race(0, true, 7, [['Alpha', 1, 100.0], ['Bravo', 2, 101.0], ['Charlie', 3, 102.0]]));
  a.stop();
  let text = store.get('stats.json');
  assert.ok(!text.includes('"last"'), 'none yet: the file as before');
  t.t = 1798761600000; // Date.UTC(2027, 0, 1)
  const b = new Stats(opts());
  assert.equal(b.board(0, 'lastMonth').length, 3);
  b.addRace(race(1, false, 7, [['Alpha', 1, 50.0], ['Bravo', 2, 51.0]]));
  b.stop();
  text = store.get('stats.json');
  assert.ok(
    text.includes(
      '"month":{"key":"2027-01","t":{"1":{"races":1,"rw":0,"rl":0,"uw":1,"ul":0,"points":0,"dc":0}}},"last":{"key":"2026-12","t":{"0":{"races":1,"rw":1,"rl":0,"uw":0,"ul":0,"points":100,"dc":0}}},"best"',
    ),
    text,
  );
  const c = new Stats(opts());
  assert.deepEqual(c.board(0, 'lastMonth').map((r) => [r.name, r.points]), [
    ['Alpha', 100],
    ['Bravo', 50],
    ['Charlie', 0],
  ]);
  storage.put(
    'online/stats.json',
    '{"personas":[{"name":"Okay","seen":"2027-01","all":{},"month":{"key":"2027-01","t":{}},"last":{"key":"x","t":{"0":{"races":1}}}}]}',
  );
  const e = new Stats(opts());
  assert.equal(e.board(0, 'lastMonth').length, 0);
});

test('last_month_before_november_2026_not_shown', () => {
  const { storage, store } = newStore();
  storage.put(
    'online/stats.json',
    '{"v":1,"personas":[\n' +
      '{"name":"Gone","seen":"2026-10","all":{"0":{"races":5,"rw":4,"points":400}},"month":{"key":"2026-10","t":{"0":{"races":5,"rw":4,"points":400}}},"best":{}},\n' +
      '{"name":"Back","seen":"2026-11","all":{"0":{"races":9,"rw":9,"points":900}},"month":{"key":"2026-11","t":{"0":{"races":1,"rw":1,"points":100}}},"best":{}}\n' +
      ']}',
  );
  const t = { t: 1793577600000 }; // Date.UTC(2026, 10, 2)
  const st = new Stats({ store, clocks: clocks(t), log: quiet });
  assert.equal(st.board(0, 'lastMonth').length, 0, 'October 2026: not shown');
  assert.equal(st.ranking(0, 'lastMonth').rows.length, 0);
  assert.ok(
    st.serialize().includes('"last":{"key":"2026-10","t":{"0":{"races":5,"rw":4,"rl":0,"uw":0,"ul":0,"points":400,"dc":0}}}'),
    'kept in the file',
  );
  t.t = 1796169600000; // Date.UTC(2026, 11, 2)
  assert.deepEqual(st.board(0, 'lastMonth').map((r) => [r.name, r.points]), [['Back', 100]], "November's leaders");
});

test('saved_read_back_damaged_pruned', () => {
  const { storage, store } = newStore();
  const t = { t: T0 };
  const opts = (log) => ({ store, clocks: clocks(t), log, saveMs: 60000 });
  const a = new Stats(opts(quiet));
  a.addRace(race(2, true, 7, [['Alpha', 1, 10.0], ['Bravo', 2, 11.0]]));
  assert.equal(a.saveDue(), T0 + 60000);
  a.stop();
  assert.equal(a.saveDue(), null);
  const text = store.get('stats.json');
  assert.deepEqual([...storage.m.keys()], ['online/stats.json'], 'no temporary file left');
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j.personas[0]).sort(), ['all', 'best', 'month', 'name', 'seen']);
  assert.ok(!text.includes('10.77.') && !text.includes('PASS') && !text.includes('MID') && !text.includes('ADDR') && !text.includes('@'));
  const b = new Stats(opts(quiet));
  assert.deepEqual(b.board(2, 'all').map((r) => [r.name, r.points]), [
    ['Alpha', 100],
    ['Bravo', 0],
  ]);
  storage.put(
    'online/stats.json',
    '{"personas":[{"name":"Evil<script>","all":{}},{"name":"Okay","seen":"2026-10","all":{"0":{"races":-5,"rw":"x","points":7,"secret":"y"}},"ip":"1.2.3.4"}]}',
  );
  const c = new Stats(opts(quiet));
  assert.equal(c.rec('Evil<script>', false), null);
  assert.deepEqual(c.rec('Okay', false).all[0], { races: 0, rw: 0, rl: 0, uw: 0, ul: 0, points: 7, dc: 0 });
  // damaged: moved aside, a fresh start
  storage.put('online/stats.json', '{not json');
  const logs = [];
  const e = new Stats(opts((s) => logs.push(s)));
  assert.equal(e.board(0, 'all').length, 0);
  assert.ok([...storage.m.keys()].some((k) => k.startsWith('online/stats.json.bad-')));
  assert.ok(!storage.m.has('online/stats.json'));
  assert.equal(storage.m.get('online/stats.json.bad-' + T0), '{not json');
  assert.deepEqual(logs, [
    "[online] online/stats.json could not be read (Expected property name or '}' in JSON at position 1 (line 1 column 2)): moved to online/stats.json.bad-" +
      T0 +
      ', starting with no results',
  ]);
  // personas not seen for a year are forgotten at the next save
  e.addRace(race(0, false, 1, [['Old', 1, 5.0], ['Older', 2, 6.0]]));
  t.t = 1827705600000; // Date.UTC(2027, 11, 1)
  e.addRace(race(0, false, 1, [['New', 1, 5.0], ['Newer', 2, 6.0]]));
  e.stop();
  const names = JSON.parse(store.get('stats.json')).personas.map((p) => p.name).sort();
  assert.deepEqual(names, ['New', 'Newer']);
});

test('a_name_that_reads_as_a_slur_is_dropped_from_the_file', () => {
  const { storage, store } = newStore();
  storage.put('online/stats.json', '{"v":1,"personas":[{"name":"Speedy","seen":1792411200000},{"name":"F4g_42","seen":1792411200000}]}');
  const logs = [];
  const st = new Stats({ store, clocks: clocks({ t: T0 }), log: (s, k) => logs.push([s, k]) });
  assert.deepEqual([...st.p.keys()], ['speedy']);
  assert.deepEqual(logs, [['[online] results of 1 personas read from online/stats.json', null]]);
});

test('race_report_decoder', () => {
  let r = decodeResult(
    'AwIAAQ+uAAIBAQEVQAADJ0M60exCuGZnQflKqkIogLdAsZmaQU2tD0I5HwoAAAAAAAAAAAAAAAAAAAAAAAAAAAIBFUAAAOhDO6uGQreo9kH44idCKNlYQL3CkEFciThCPgV4AAAAAAAAAAAAAAAAAAAAAAAAAA==',
  );
  assert.deepEqual([r.kind, r.track, r.laps, r.players.length], [0, 4014, 2, 2]);
  assert.deepEqual(
    r.players.map((p) => [p.index, p.place, Math.round(p.time * 100) / 100, p.dropped]),
    [
      [1, 1, 186.82, false],
      [0, 2, 187.67, false],
    ],
  );
  assert.deepEqual(r.players.map((p) => Math.round(p.top * 1000) / 1000), [42.126, 42.212], 'top speeds in m/s');
  assert.ok(r.players.every((p) => p.jump === 0 && p.slide === 0 && p.driftBest === 0), 'no jump, slide or drift');
  assert.ok(r.players.every((p) => p.finished() && p.racedToTheEnd()));
  assert.equal(decodeResult('not base64 at all!'), null);
  assert.equal(decodeResult(b64([2, 1, 0, 0, 0, 0, 0, 0])), null, 'another version');
  assert.equal(decodeResult(b64([3, 2, 0, 0, 0, 0, 0, 0, 1, 1])), null, 'cut short');
  const dropped = new Uint8Array(8 + 55 * 2);
  const dv = new DataView(dropped.buffer);
  dropped[0] = 3;
  dropped[1] = 2;
  dropped[8] = 0;
  dropped[9] = 1;
  dv.setFloat32(16, 90, false);
  dropped[8 + 2] = 1;
  dropped[63] = 1;
  dropped[64] = 2;
  dropped[65] = 0x0c;
  dv.setFloat32(63 + 32, -1, false);
  assert.deepEqual(decodeResult(b64(dropped)).players.map((p) => p.dropped), [false, true]);
  dropped[65] = 1;
  dv.setFloat32(63 + 32, 0, false);
  dv.setFloat32(63 + 44, -1, false);
  assert.deepEqual(decodeResult(b64(dropped)).players.map((p) => p.dropped), [false, true]);
  dv.setFloat32(8 + 36, 1.5, false);
  dv.setFloat32(8 + 40, 20.25, false);
  dv.setInt32(8 + 48, 70000, false);
  const p = decodeResult(b64(dropped)).players[0];
  assert.deepEqual([p.jump, p.slide, p.driftBest], [1.5, 20.25, 70000]);
  const counted = [...dropped.slice(0, 63)];
  counted[8 + 53] = 0x04;
  counted[8 + 54] = 0x02;
  counted.push(0, 7, 0, 3, ...dropped.slice(63));
  r = decodeResult(b64(counted));
  assert.deepEqual(r.players.map((p) => [p.index, p.place, p.dropped]), [
    [0, 1, false],
    [1, 2, true],
  ]);
  // a dropped racer put out on the road raced to the end; one gone did not
  const out = new ReportPlayer({ dropped: true, state: OUT });
  assert.ok(!out.finished() && out.racedToTheEnd());
  assert.ok(!racedToTheEnd({ dropped: true, state: 0x0c }) && finished({ dropped: false }));
});

test('records', () => {
  const { storage, store } = newStore();
  const t = { t: T0 };
  const opts = () => ({ store, clocks: clocks(t), log: quiet });
  const st = new Stats(opts());
  const me = (time, top, jump, slide, driftBest) =>
    new ReportPlayer({ index: 0, place: 1, state: 1, car: 0, time, score: 0, dropped: false, top, avg: 0, jump, slide, driftBest });
  st.addRecords('Alpha', 0, me(100.0, 0.0, 0.0, 0.0, 0));
  assert.equal(st.rec('Alpha', false), null, 'nothing to keep: no record made');
  st.addRecords('Alpha', 0, me(100.0, 42.1257, 1.5, 12.25, 5300));
  st.addRecords('Alpha', 0, me(100.0, 40.0, 2.25, 0.0, 9000));
  st.addRecords('Alpha', 0, me(100.0, 900.0, 0.0, NaN, -5));
  st.addRecords('Alpha', 0, me(11.0, 0.0, 0.0, 0.0, 0));
  for (const time of [12.75, 11.5, 13.0]) st.addRecords('Alpha', 2, me(time, 0.0, 0.0, 0.0, 0));
  const want = { top: 42.126, drift: 9000, slide: 12.25, jump: 2.25, drag: 11.5 };
  assert.deepEqual(st.rec('Alpha', false).records, want);
  assert.deepEqual(hexes(st.statField('Alpha', false)).slice(0, 8), [0, 0, 0, 42126, 9000, 12250, 2250, 11500]);
  assert.deepEqual(hexes(st.statField('Alpha', true)).slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0], "the month's: none");
  st.stop();
  const text = store.get('stats.json');
  assert.ok(text.includes('"best":{},"rec":{"top":42.126,"drift":9000,"slide":12.25,"jump":2.25,"drag":11.5}}'), text);
  const b = new Stats(opts());
  assert.deepEqual(b.rec('Alpha', false).records, want);
  storage.put('online/stats.json', '{"personas":[{"name":"Okay","seen":"2026-10","all":{},"rec":{"top":1e9,"jump":"x","slide":-3,"drag":12}}]}');
  const c = new Stats(opts());
  assert.deepEqual(c.rec('Okay', false).records, { top: 0, drift: 0, slide: 0, jump: 0, drag: 12 });
});

test('onl7_store_full_best_capped', () => {
  const t = { t: T0 };
  const st = new Stats({ store: null, clocks: clocks(t), log: quiet, max: 3 });
  st.addRace(race(0, false, 1, [['Old1', 1, 50.0], ['Old2', 2, 51.0]]));
  st.addRace(race(0, false, 1, [['New1', 1, 50.0], ['New2', 2, 51.0]]));
  assert.ok(st.len() <= 3, st.len() + ' records (the cap is 3)');
  assert.ok(st.rec('New1', false) !== null && st.rec('New2', false) !== null, 'the newest players are recorded');
  const s2 = new Stats({ store: null, clocks: clocks(t), log: quiet });
  for (let tr = 0; tr < 400; tr++) s2.addRace(race(0, false, tr, [['Alpha', 1, 50.0], ['Bravo', 2, 51.0]]));
  const n = s2.rec('Alpha', false).best.size;
  assert.ok(n <= 300, n + ' best times kept');
  // in memory: no save armed
  assert.equal(s2.saveDue(), null);
});

// a file nested far deeper than a stack: JSON.parse takes it (V8's parser keeps its own stack), and the loader walks
// the value without recursion.  (The Rust test's buddies.json half belongs to buddy.js.)
test('a_deeply_nested_file_is_read', () => {
  const n = 200000;
  const deep = '['.repeat(n) + ']'.repeat(n);
  const { storage, store } = newStore();
  storage.put(
    'online/stats.json',
    '{"personas":[{"name":"Alpha","seen":"2026-10","all":{"0":{"races":2,"rw":1},"1":' + deep + '},"x":' + deep + '},' + deep + ']}',
  );
  const st = new Stats({ store, clocks: clocks({ t: T0 }), log: quiet });
  const alpha = st.p.get('alpha');
  assert.deepEqual(alpha.all[0], { races: 2, rw: 1, rl: 0, uw: 0, ul: 0, points: 0, dc: 0 });
  assert.ok(alpha.all[1] !== null, 'the array in "1" is a count block of none of the fields');
  const bad = newStore();
  bad.storage.put('online/stats.json', '{"personas":[' + deep + ',' + '['.repeat(n));
  const sb = new Stats({ store: bad.store, clocks: clocks({ t: T0 }), log: quiet });
  assert.equal(sb.len(), 0);
  assert.ok(!bad.storage.m.has('online/stats.json'));
});

test('node_base64_as_node_reads_it', () => {
  for (const [s, h] of [
    ['QUJD=REVG', '414243'],
    ['QU JD', '414243'],
    ['QU*JD', '414243'],
    ['QQ', '41'],
    ['Q', ''],
    ['QUJ', '4142'],
    ['QU=JD', '41'],
    ['-_8', 'fbff'],
    ['+/8', 'fbff'],
    ['not base64 at all!', '9e8b5b6ac7bae1ab5a96'],
    ['undefined', 'ba775e7e29de'],
    ['=QUJD', ''],
    ['QUJ=D', '4142'],
  ]) {
    assert.equal(hex(nodeBase64(s)), h, s);
    // as Node itself reads it
    assert.equal(hex(nodeBase64(s)), Buffer.from(s, 'base64').toString('hex'), s);
  }
});

// (beyond the Rust tests) the API's small parts
test('points, months, rankings, search', () => {
  assert.equal(RACE_TYPES[2], 'drag');
  assert.deepEqual([racePoints(true, 3, 1), racePoints(true, 3, 2), racePoints(true, 3, 3), racePoints(true, 3, 0), racePoints(false, 3, 1)], [100, 50, 0, 0, 0]);
  assert.equal(racePoints(true, 4, 2), 67);
  assert.deepEqual([monthBefore('2026-01'), monthBefore('2026-11')], ['2025-12', '2026-10']);
  const t = { t: T0 };
  const st = new Stats({ store: null, clocks: clocks(t), log: quiet });
  st.addRace(race(0, true, 1, [['Bravo', 1, 10], ['alpha', 2, 11], ['Alfa', 3, 12]]));
  const r1 = st.ranking(0, 'all');
  assert.deepEqual(r1.rows.map((r) => [r.name, r.rank]), [['Bravo', 1], ['alpha', 2], ['Alfa', 3]]);
  assert.equal(r1.index.get('alfa'), 2);
  const builds = st.builds;
  st.ranking(0, 'all');
  assert.equal(st.builds, builds, 'built once within boardMs');
  t.t += 5000;
  st.ranking(0, 'all');
  assert.equal(st.builds, builds + 1);
  assert.deepEqual(st.startingWith('al', 10), ['Alfa', 'alpha']);
  assert.deepEqual(st.startingWith('al', 1), ['Alfa']);
  assert.deepEqual(st.startingWith('b', 10), ['Bravo']);
  st.addRace(race(0, true, 1, [['Alpine', 1, 10], ['Bravo', 2, 11]]));
  assert.deepEqual(st.startingWith('al', 10), ['Alfa', 'alpha'], 'the sorted list: at most every boardMs');
  t.t += 5000;
  assert.deepEqual(st.startingWith('al', 10), ['Alfa', 'alpha', 'Alpine']);
  const one = new Stats({ store: null, clocks: clocks({ t: T0 }), log: quiet });
  one.addRace({ kind: 0, ranked: true, track: 1, players: [{ name: 'Alpha', place: 1, time: 10.12345, left: false }, { name: 'Bravo', place: 0, time: 0, left: true }] });
  const c1 = '{"races":1,"rw":1,"rl":0,"uw":0,"ul":0,"points":100,"dc":0}';
  const c2 = '{"races":1,"rw":0,"rl":1,"uw":0,"ul":0,"points":0,"dc":1}';
  assert.equal(
    one.serialize(),
    '{"v":1,"note":"NFSU2 online results per persona (public in the game)","personas":[' +
      '{"name":"Alpha","seen":"2026-10","all":{"0":' + c1 + '},"month":{"key":"2026-10","t":{"0":' + c1 + '}},"best":{"0:1":10.123}},' +
      '{"name":"Bravo","seen":"2026-10","all":{"0":' + c2 + '},"month":{"key":"2026-10","t":{"0":' + c2 + '}},"best":{}}]}',
  );
  assert.equal(one.statField('Bravo', false).split(',').slice(0, 2).join(','), '0,1');
});
