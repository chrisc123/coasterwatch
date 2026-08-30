// Regression tests for the graphing/history pipeline in src/pkjs/index.js:
// history sampling and downsampling for the watch's graph, the
// queue-times.com-is-wrong-about-is_open workaround (cross-checked against a
// mocked themeparks.wiki schedule), and the ride-switch race that used to let
// two graph requests' AppMessage streams interleave. No real phone/watch or
// network needed — queue-times.com and themeparks.wiki responses are mocked.
// Run with: node test/graphing.test.js
'use strict';

// Fixed so graphFloorMinuteOfDay's UTC-instant-to-local-minute conversion is
// simple to hand-verify in its test (no dependence on this machine's zone).
process.env.TZ = 'UTC';

const assert = require('assert');
const { loadPkjs } = require('./pkjs-harness');

let passed = 0;
const failures = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// A ride known to be in Energylandia's default-visible set (Abyssus / Hyperion).
const RIDE_A = 11281;
const RIDE_B = 11270;

function queueTimesResponse(rides) {
  return {
    status: 200,
    responseText: JSON.stringify({
      lands: [{ id: 1, name: 'Test Land', rides: rides }],
    }),
  };
}

// `type` defaults to 'OPERATING' with a window comfortably spanning "now",
// so tests only need to override what they're actually asserting on.
function scheduleResponse(overrides) {
  const now = Date.now();
  const entry = Object.assign({
    date: '2026-01-01',
    type: 'OPERATING',
    openingTime: new Date(now - 3600000).toISOString(),
    closingTime: new Date(now + 3600000).toISOString(),
  }, overrides);
  return { status: 200, responseText: JSON.stringify({ schedule: [entry] }) };
}

function xhrRouter(routes) {
  return (url) => {
    for (const [match, respond] of routes) {
      if (url.indexOf(match) !== -1) return respond(url);
    }
    throw new Error('graphing.test.js: unexpected XHR to ' + url);
  };
}

// ---------------------------------------------------------------------------
// History sampling / downsampling

test('appendHistory records is_open:false as wait -1, not the stale wait_time', () => {
  const pkjs = loadPkjs();
  pkjs.appendHistory([{ id: RIDE_A, name: 'Abyssus', is_open: false, wait_time: 15 }]);
  const hist = pkjs.loadHistory();
  assert.strictEqual(hist.rides[RIDE_A].length, 1);
  assert.strictEqual(hist.rides[RIDE_A][0][1], -1, 'a closed ride must be recorded as -1, ignoring wait_time');
});

test('getGraphPoints returns null with fewer than 2 recorded samples', () => {
  const pkjs = loadPkjs();
  assert.strictEqual(pkjs.getGraphPoints(RIDE_A), null, 'no samples at all');
  pkjs.appendHistory([{ id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: 5 }]);
  assert.strictEqual(pkjs.getGraphPoints(RIDE_A), null, 'exactly 1 sample is still not enough');
});

test('getGraphPoints returns every sample, oldest first, when under the point cap', () => {
  const pkjs = loadPkjs();
  for (let i = 0; i < 5; i++) {
    pkjs.appendHistory([{ id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: i * 10 }]);
  }
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 5);
  // Spread rather than compare the mapped array directly: `points` (and
  // anything .map() derives from it) belongs to the sandboxed vm context's
  // own Array realm, which deepStrictEqual treats as a different type from
  // a Node-native array literal even with identical elements.
  assert.deepStrictEqual([...points.map((p) => p.wait)], [0, 10, 20, 30, 40]);
});

test('getGraphPoints downsamples to MAX_GRAPH_POINTS, preserving the first and last sample', () => {
  const pkjs = loadPkjs();
  const total = 100;
  for (let i = 0; i < total; i++) {
    pkjs.appendHistory([{ id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: i }]);
  }
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 24, 'must downsample down to exactly MAX_GRAPH_POINTS');
  assert.strictEqual(points[0].wait, 0, 'first recorded sample must be preserved');
  assert.strictEqual(points[points.length - 1].wait, total - 1, 'last recorded sample must be preserved');
  // Downsampled waits must still be non-decreasing (evenly spaced picks from
  // a monotonically increasing series) - catches an off-by-one/out-of-order
  // regression in the sampling index math without hardcoding every value.
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].wait > points[i - 1].wait, 'downsampled points must stay in recorded order');
  }
});

// These need specific, artificial minute-of-day gaps (every other test here
// uses appendHistory(), which stamps real nowMinutes()), so they seed
// queueHistory_v1 directly. localTodayStr() duplicates todayStr()'s exact
// (unpadded) format so the seeded entry reads as fresh, not stale-and-reset.
function localTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function seedHistory(rideId, samples) {
  return loadPkjs({
    storageSeed: {
      queueHistory_v1: JSON.stringify({ date: localTodayStr(), rides: { [rideId]: samples } }),
    },
  });
}

// Energylandia's park id (317) - matches DEFAULT_PARK_ID, so getGraphPoints'
// internal loadCachedSchedule(getSelectedParkId()) call finds this without
// any park-selection seeding.
function seedHistoryWithSchedule(rideId, samples, openingTimeIso) {
  return loadPkjs({
    storageSeed: {
      queueHistory_v1: JSON.stringify({ date: localTodayStr(), rides: { [rideId]: samples } }),
      parkSchedule_v1: JSON.stringify({
        317: { type: 'OPERATING', openingTime: openingTimeIso, closingTime: '2026-01-01T23:00:00Z' },
      }),
    },
  });
}

test('getGraphPoints drops samples from more than an hour before the park opened, entirely - ' +
  'not just compressed like a same-day gap', () => {
  // TZ is pinned to UTC at the top of this file, so the floor (opening
  // minus 60 min) is simply the opening hour/minute minus one hour.
  const floorMinute = 9 * 60; // 10:00 opening - 60 min = 09:00
  const pkjs = seedHistoryWithSchedule(RIDE_A, [
    [floorMinute - 20, 0], [floorMinute - 10, 0], // before the floor: not real queue data, drop entirely
    [floorMinute + 5, 15], [floorMinute + 65, 20], [floorMinute + 125, 25], // after the floor: real
  ], '2026-01-01T10:00:00Z');

  const points = pkjs.getGraphPoints(RIDE_A);
  assert.ok(points, 'expected a valid graph after filtering');
  assert.strictEqual(points.length, 3, 'the 2 pre-floor samples must be dropped entirely, not compressed to markers');
  assert.deepStrictEqual([...points.map((p) => p.wait)], [15, 20, 25]);
});

test('getGraphPoints keeps a sample recorded within the hour-early-entry window before opening', () => {
  const floorMinute = 9 * 60;
  const pkjs = seedHistoryWithSchedule(RIDE_A, [
    [floorMinute + 1, 0], [floorMinute + 30, 5], [floorMinute + 65, 15],
  ], '2026-01-01T10:00:00Z');

  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 3, 'a sample right at/after the floor must be kept, not dropped');
});

// A Pebble watchapp only records while it's the running app, so a normal
// day of real use is many bursts separated by long gaps. An earlier version
// split the day at those gaps and compressed every "older" burst to 2
// marker points, which threw away most of a real day's queue history. These
// pin down that the whole recorded day is kept and thinned evenly instead.
test('getGraphPoints keeps every burst of a normally-used day, not just the latest', () => {
  // Four usage bursts across the day, each separated by well over an hour -
  // exactly what a watchapp records when it's opened and closed repeatedly.
  const samples = [];
  [[600, 640], [760, 800], [930, 970], [1080, 1120]].forEach(([a, b]) => {
    for (let m = a; m <= b; m += 10) samples.push([m, 20]);
  });
  const pkjs = seedHistory(RIDE_A, samples);

  const points = pkjs.getGraphPoints(RIDE_A);
  const minutes = points.map((p) => p.minuteOfDay);
  // Every burst must be represented by more than a token marker pair.
  [[600, 640], [760, 800], [930, 970], [1080, 1120]].forEach(([a, b]) => {
    const inBurst = minutes.filter((m) => m >= a && m <= b);
    assert.ok(inBurst.length >= 3,
      `burst ${a}-${b} should keep real resolution, got only ${inBurst.length} point(s)`);
  });
  assert.strictEqual(minutes[0], 600, 'the day\'s first recorded sample must be kept');
  assert.strictEqual(minutes[minutes.length - 1], 1120, 'the latest sample must be kept');
});

test('getGraphPoints passes a short day through untouched', () => {
  const pkjs = seedHistory(RIDE_A, [[600, 10], [610, 15], [620, 20]]);
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 3, 'under the point cap, nothing should be dropped');
});

test('getGraphPoints never exceeds MAX_GRAPH_POINTS, however fragmented the day', () => {
  // Many separate bursts: the total sent must still fit the watch's fixed
  // MAX_GRAPH_POINTS array, or s_graph_count can never reach the GraphCount
  // it was told to expect and the graph sticks on "Loading graph..." forever.
  const samples = [];
  for (let s = 0; s < 15; s++) samples.push([s * 90, 0], [s * 90 + 5, 0]);
  samples.push([1350, 15], [1360, 20]);

  const pkjs = seedHistory(RIDE_A, samples);
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.ok(points.length <= 24, 'must never exceed MAX_GRAPH_POINTS: got ' + points.length);
  assert.strictEqual(points[points.length - 1].minuteOfDay, 1360, 'the latest sample must be kept');
  assert.strictEqual(points[0].minuteOfDay, 0, 'the earliest sample must be kept');
});

// ---------------------------------------------------------------------------
// Park hours cross-check (the "Energylandia shows 0m while actually closed" bug)

test('isParkOpenNow: true inside the operating window, false before/after it', () => {
  const pkjs = loadPkjs();
  const now = Date.now();
  assert.strictEqual(pkjs.isParkOpenNow({
    type: 'OPERATING',
    openingTime: new Date(now - 1000).toISOString(),
    closingTime: new Date(now + 100000).toISOString(),
  }), true);
  assert.strictEqual(pkjs.isParkOpenNow({
    type: 'OPERATING',
    openingTime: new Date(now + 1000).toISOString(),
    closingTime: new Date(now + 100000).toISOString(),
  }), false, 'not open yet');
  assert.strictEqual(pkjs.isParkOpenNow({
    type: 'OPERATING',
    openingTime: new Date(now - 100000).toISOString(),
    closingTime: new Date(now - 1000).toISOString(),
  }), false, 'already closed for the day');
});

test('isParkOpenNow: false for a non-OPERATING day, true (fail-open) when schedule is unknown', () => {
  const pkjs = loadPkjs();
  assert.strictEqual(pkjs.isParkOpenNow({ type: 'CLOSED' }), false);
  assert.strictEqual(pkjs.isParkOpenNow(null), true, 'unknown schedule must not mislabel every ride closed');
  assert.strictEqual(pkjs.isParkOpenNow({ type: 'OPERATING', openingTime: 'not a date', closingTime: 'nope' }),
    true, 'unparseable times must fail open too');
});

// Decodes the RidesData wire format the watch parses in inbox_received_callback:
//   [count]{ id(4) wait(2) dist(4) flags(1) nameLen(1) name(nameLen) }*
// Kept as one helper so a format change breaks in a single place rather than
// being half-updated across tests.
function decodeRidesData(bytes) {
  const s16 = (v) => (v << 16) >> 16;
  const rides = [];
  let o = 1;
  for (let i = 0; i < bytes[0]; i++) {
    const id = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    o += 4;
    const wait = s16((bytes[o] << 8) | bytes[o + 1]);
    o += 2;
    const dist = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    o += 4;
    const flags = bytes[o++];
    const nameLen = bytes[o++];
    let name = '';
    for (let k = 0; k < nameLen; k++) name += String.fromCharCode(bytes[o + k]);
    o += nameLen;
    rides.push({ id, wait, dist, flags, name });
  }
  return { rides, bytesConsumed: o };
}

function unpackRidesData(sentMessages) {
  const msg = sentMessages.find((m) => 'RidesData' in m);
  if (!msg) return [];
  return decodeRidesData(msg.RidesData).rides;
}

test('fetchQueueTimes overrides every ride to closed when the park schedule says it is not open, ' +
  'even though queue-times.com itself still reports is_open:true', () => {
  let scheduleFetches = 0;
  const pkjs = loadPkjs({
    xhrHandler: xhrRouter([
      ['queue_times.json', () => queueTimesResponse([
        { id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: 0, last_updated: '2026-01-01T00:00:00Z' },
        { id: RIDE_B, name: 'Hyperion', is_open: true, wait_time: 0, last_updated: '2026-01-01T00:00:00Z' },
      ])],
      ['themeparks.wiki', () => { scheduleFetches++; return scheduleResponse({ type: 'CLOSED' }); }],
    ]),
  });

  pkjs.fetchQueueTimes();

  const rides = unpackRidesData(pkjs.__sentMessages);
  assert.ok(rides.length > 0, 'expected at least one ride in RidesData');
  assert.ok(rides.every((r) => r.wait === -1),
    'every ride must be forced closed (-1) once the park schedule says it is not open: got ' + JSON.stringify(rides));
  assert.strictEqual(scheduleFetches, 1);
});

test('fetchQueueTimes leaves queue-times.com\'s own is_open alone while the park schedule says it IS open', () => {
  const pkjs = loadPkjs({
    xhrHandler: xhrRouter([
      ['queue_times.json', () => queueTimesResponse([
        { id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: 25, last_updated: '2026-01-01T00:00:00Z' },
        { id: RIDE_B, name: 'Hyperion', is_open: false, wait_time: 0, last_updated: '2026-01-01T00:00:00Z' },
      ])],
      ['themeparks.wiki', () => scheduleResponse({})], // OPERATING, spanning "now" (see scheduleResponse default)
    ]),
  });

  pkjs.fetchQueueTimes();

  const rides = unpackRidesData(pkjs.__sentMessages);
  const byId = {};
  rides.forEach((r) => { byId[r.id] = r; });
  assert.strictEqual(byId[RIDE_A].wait, 25, 'an open ride\'s real wait must pass through unchanged');
  assert.strictEqual(byId[RIDE_B].wait, -1, 'a ride queue-times.com itself already reports closed must stay closed');
});

test('the park schedule is cached for the day: a second fetchQueueTimes does not re-fetch it', () => {
  let scheduleFetches = 0;
  const pkjs = loadPkjs({
    xhrHandler: xhrRouter([
      ['queue_times.json', () => queueTimesResponse([
        { id: RIDE_A, name: 'Abyssus', is_open: true, wait_time: 5, last_updated: '2026-01-01T00:00:00Z' },
      ])],
      ['themeparks.wiki', () => { scheduleFetches++; return scheduleResponse({}); }],
    ]),
  });

  pkjs.fetchQueueTimes();
  pkjs.fetchQueueTimes();

  assert.strictEqual(scheduleFetches, 1, 'the second fetch should have hit the cache, not the network again');
});

// ---------------------------------------------------------------------------
// The ride-switch graph-stream race (see main.c's gi == s_graph_count fix)

test('sendGraph packages all points into an atomic GraphData byte array', () => {
  const pkjs = loadPkjs();

  for (let i = 0; i < 5; i++) {
    pkjs.appendHistory([{ id: RIDE_A, name: 'A', is_open: true, wait_time: (i + 1) * 10 }]);
  }

  pkjs.sendGraph(RIDE_A);

  assert.strictEqual(pkjs.__sentMessages.length, 1, 'expected exactly 1 atomic message for GraphData');
  const msg = pkjs.__sentMessages[0];
  assert.ok(msg.GraphData, 'message must contain GraphData');
  assert.strictEqual(msg.GraphData.length, 5 * 3, '5 points * 3 bytes per point');

  // Verify unpacked wait values
  const waits = [];
  for (let i = 0; i < msg.GraphData.length; i += 3) {
    waits.push(msg.GraphData[i]);
  }
  assert.deepStrictEqual(waits, [10, 20, 30, 40, 50]);
});

test('sendRidesToWatch packages all rides into an atomic RidesData byte array', () => {
  const pkjs = loadPkjs();

  const rides = [
    { id: 11281, name: 'Abyssus', is_open: true, wait_time: 15, _distance: 120 },
    { id: 11270, name: 'Hyperion', is_open: false, wait_time: 30, _distance: 350 },
  ];

  pkjs.sendRidesToWatch(rides);

  assert.strictEqual(pkjs.__sentMessages.length, 1, 'expected exactly 1 atomic message for RidesData');
  const msg = pkjs.__sentMessages[0];
  assert.ok(msg.RidesData, 'message must contain RidesData');

  const bytes = msg.RidesData;
  assert.strictEqual(bytes[0], 2, 'count must be 2');
  const { rides: got, bytesConsumed } = decodeRidesData(bytes);

  assert.deepStrictEqual(got[0], { id: 11281, wait: 15, dist: 120, flags: 0, name: 'Abyssus' });
  assert.deepStrictEqual(got[1], { id: 11270, wait: -1, dist: 350, flags: 0, name: 'Hyperion' },
    'closed ride must encode wait as -1');
  assert.strictEqual(bytesConsumed, bytes.length,
    'no trailing bytes — the watch walks this packet by the same offsets');
});

test('a ride recorded today is flagged so the grid can tick it', () => {
  const pkjs = loadPkjs();
  const rides = [
    { id: 11281, name: 'Abyssus', is_open: true, wait_time: 15, _distance: 120 },
    { id: 11270, name: 'Hyperion', is_open: true, wait_time: 5, _distance: 350 },
  ];

  pkjs.sendRidesToWatch(rides, true);
  let got = decodeRidesData(pkjs.__sentMessages.pop().RidesData).rides;
  assert.deepStrictEqual(got.map((r) => r.flags), [0, 0], 'nothing recorded yet');

  // A recording today for Abyssus only.
  pkjs.localStorage.setItem('coasterwatch_ride_logs', JSON.stringify([
    { id: 'r1', rideId: 11281, recordedAt: new Date().toISOString() },
  ]));
  pkjs.sendRidesToWatch(rides, true);
  got = decodeRidesData(pkjs.__sentMessages.pop().RidesData).rides;
  assert.deepStrictEqual(got.map((r) => r.flags), [1, 0], 'only the ride actually logged gets the flag');
});

test('yesterday\'s recording does not tick today\'s grid', () => {
  const pkjs = loadPkjs();
  const rides = [{ id: 11281, name: 'Abyssus', is_open: true, wait_time: 15, _distance: 120 }];

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  pkjs.localStorage.setItem('coasterwatch_ride_logs', JSON.stringify([
    { id: 'r1', rideId: 11281, recordedAt: yesterday },
  ]));

  pkjs.sendRidesToWatch(rides, true);
  const got = decodeRidesData(pkjs.__sentMessages.pop().RidesData).rides;
  assert.strictEqual(got[0].flags, 0,
    'the tick means "logged today", so it must clear over midnight rather than ' +
    'marking a ride forever after one recording');
});

test('a corrupt ride-log store degrades to no ticks rather than breaking the grid', () => {
  const pkjs = loadPkjs();
  pkjs.localStorage.setItem('coasterwatch_ride_logs', '{not json');
  const rides = [{ id: 11281, name: 'Abyssus', is_open: true, wait_time: 15, _distance: 120 }];

  pkjs.sendRidesToWatch(rides, true);
  const got = decodeRidesData(pkjs.__sentMessages.pop().RidesData).rides;
  assert.strictEqual(got[0].flags, 0);
  assert.strictEqual(got[0].name, 'Abyssus', 'the queue grid itself must still arrive');
});

test('sendRidesToWatch skips transmission when data is unchanged unless forceSend is set', () => {
  const pkjs = loadPkjs();

  const rides = [
    { id: 11281, name: 'Abyssus', is_open: true, wait_time: 15, _distance: 120 },
  ];

  pkjs.sendRidesToWatch(rides, true);
  assert.strictEqual(pkjs.__sentMessages.length, 1);

  // Calling again without forceSend and identical data should not send a message
  pkjs.sendRidesToWatch(rides, false);
  assert.strictEqual(pkjs.__sentMessages.length, 1, 'duplicate data must skip BLE send');

  // Calling with forceSend should send
  pkjs.sendRidesToWatch(rides, true);
  assert.strictEqual(pkjs.__sentMessages.length, 2, 'forceSend must send even if duplicate');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('FAIL - ' + name);
      console.log('  ' + err.message);
    }
  }

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) process.exit(1);
})();
