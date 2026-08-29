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

test('getGraphPoints compresses an earlier, disconnected session down to 2 marker points', () => {
  const midnightTesting = [[2, 0], [5, 0], [8, 0], [11, 0], [14, 0], [17, 0], [20, 0], [23, 0]];
  const currentSession = [[600, 20], [605, 25], [610, 30], [615, 28]];
  const pkjs = seedHistory(RIDE_A, midnightTesting.concat(currentSession));

  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 2 + currentSession.length,
    "the older session should contribute exactly 2 points, not all " + midnightTesting.length);
  assert.strictEqual(points[0].minuteOfDay, 2, "the older session's marker points should be its first...");
  assert.strictEqual(points[1].minuteOfDay, 23, "...and last sample, not an arbitrary pick");
  // The full current session must survive untouched (well under budget).
  assert.deepStrictEqual([...points.slice(2).map((p) => p.wait)], [20, 25, 30, 28]);
});

test('getGraphPoints does not compress anything when there is no gap', () => {
  const pkjs = seedHistory(RIDE_A, [[600, 10], [610, 15], [620, 20]]); // normal ~10 min spacing
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 3, 'a single continuous session should pass through untouched');
});

test('getGraphPoints spends most of its budget on the current session even when it alone exceeds ' +
  'MAX_GRAPH_POINTS', () => {
  const oldSession = [[2, 0], [5, 0], [8, 0]];
  const currentSession = [];
  for (let m = 600; m < 600 + 40 * 5; m += 5) currentSession.push([m, m - 600]); // 40 samples
  const pkjs = seedHistory(RIDE_A, oldSession.concat(currentSession));

  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 24, 'total must still respect MAX_GRAPH_POINTS');
  assert.strictEqual(points[0].minuteOfDay, 2, 'old session start marker');
  assert.strictEqual(points[1].minuteOfDay, 8, 'old session end marker');
  // The remaining 22 slots should span the current session's full range,
  // not be crowded out by the (already just 2-point) old session.
  assert.strictEqual(points[2].minuteOfDay, 600, "current session's first sample must be kept");
  assert.strictEqual(points[points.length - 1].minuteOfDay, currentSession[currentSession.length - 1][0],
    "current session's last sample must be kept");
});

test('getGraphPoints never exceeds MAX_GRAPH_POINTS even with many separate older sessions', () => {
  // 15 older sessions (2 samples each, 90 min apart so each is its own
  // session) would contribute 30 raw marker points before any capping -
  // comfortably more than MAX_GRAPH_POINTS on their own, which is exactly
  // what used to let the total sent to the watch overflow MAX_GRAPH_POINTS
  // (the watch silently drops anything past that, so s_graph_count could
  // never reach GraphCount and the graph got stuck loading forever).
  const samples = [];
  for (let s = 0; s < 15; s++) samples.push([s * 90, 0], [s * 90 + 5, 0]);
  samples.push([1350, 15], [1360, 20]); // current session, well past the last older one (gap > 60)

  const pkjs = seedHistory(RIDE_A, samples);
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.ok(points.length <= 24, 'must never exceed MAX_GRAPH_POINTS: got ' + points.length);
  assert.strictEqual(points[points.length - 1].minuteOfDay, 1360,
    "the current session's last sample must still make it through");
  assert.strictEqual(points[points.length - 2].minuteOfDay, 1350,
    "the current session's first sample must still make it through");
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

  const sentWaits = pkjs.__sentMessages.filter((m) => 'RideWait' in m).map((m) => m.RideWait);
  assert.ok(sentWaits.length > 0, 'expected at least one RideWait to have been sent');
  assert.ok(sentWaits.every((w) => w === -1),
    'every ride must be forced closed (-1) once the park schedule says it is not open: got ' + JSON.stringify(sentWaits));
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

  const byId = {};
  pkjs.__sentMessages.forEach((m) => { if ('RideId' in m) byId[m.RideId] = m; });
  assert.strictEqual(byId[RIDE_A].RideWait, 25, 'an open ride\'s real wait must pass through unchanged');
  assert.strictEqual(byId[RIDE_B].RideWait, -1, 'a ride queue-times.com itself already reports closed must stay closed');
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

test('opening a second ride\'s graph before the first one finished streaming does not leak its points', async () => {
  const pkjs = loadPkjs({
    // Defer every AppMessage "ack" asynchronously (rather than the harness
    // default of resolving inline) so sendGraph(RIDE_A)'s recursive point
    // chain is still mid-flight — genuinely in progress, not just
    // theoretically interruptible — when sendGraph(RIDE_B) starts, the same
    // way a real Bluetooth round-trip leaves a window open.
    sendAppMessageHandler: (dict, onSuccess) => { setImmediate(() => { if (onSuccess) onSuccess(); }); },
  });

  // Distinct, unmistakable wait values per ride so a leaked point is
  // identifiable by value alone, without needing to inspect pkjs internals.
  for (let i = 0; i < 10; i++) pkjs.appendHistory([{ id: RIDE_A, name: 'A', is_open: true, wait_time: 111 }]);
  for (let i = 0; i < 10; i++) pkjs.appendHistory([{ id: RIDE_B, name: 'B', is_open: true, wait_time: 222 }]);

  pkjs.sendGraph(RIDE_A);
  await new Promise((resolve) => setImmediate(resolve)); // let RIDE_A's GraphCount + first point go out
  pkjs.sendGraph(RIDE_B); // supersedes RIDE_A's still-in-flight stream
  await new Promise((resolve) => setTimeout(resolve, 50)); // let everything settle

  const secondGraphCountIndex = pkjs.__sentMessages
    .map((m, i) => ('GraphCount' in m ? i : -1)).filter((i) => i !== -1)[1];
  assert.ok(secondGraphCountIndex !== undefined, 'expected a second GraphCount once RIDE_B was requested');

  const afterSwitch = pkjs.__sentMessages.slice(secondGraphCountIndex);
  const leakedRideAPoint = afterSwitch.find((m) => m.GraphWait === 111);
  assert.strictEqual(leakedRideAPoint, undefined,
    'no point from the superseded RIDE_A stream should ever be sent after RIDE_B\'s GraphCount');
});

test('a superseded ride-list stream stops instead of interleaving with the newer one', async () => {
  const pkjs = loadPkjs({
    // Same async-ack setup as the graph test above: the first
    // sendRidesToWatch chain is genuinely mid-flight when the second starts.
    sendAppMessageHandler: (dict, onSuccess) => { setImmediate(() => { if (onSuccess) onSuccess(); }); },
  });

  // Distinct wait values per batch so a leaked ride is identifiable by
  // value alone — modeled on a park switch, where the stale chain's rides
  // belong to a different park entirely.
  const oldParkRides = [];
  const newParkRides = [];
  for (let i = 0; i < 10; i++) {
    oldParkRides.push({ id: 1000 + i, name: 'Old ' + i, is_open: true, wait_time: 111, _distance: -1 });
    newParkRides.push({ id: 2000 + i, name: 'New ' + i, is_open: true, wait_time: 222, _distance: -1 });
  }

  pkjs.sendRidesToWatch(oldParkRides);
  await new Promise((resolve) => setImmediate(resolve)); // let TotalCount + the first ride go out
  pkjs.sendRidesToWatch(newParkRides); // supersedes the still-in-flight stream
  await new Promise((resolve) => setTimeout(resolve, 50)); // let everything settle

  const secondTotalIndex = pkjs.__sentMessages
    .map((m, i) => ('TotalCount' in m ? i : -1)).filter((i) => i !== -1)[1];
  assert.ok(secondTotalIndex !== undefined, 'expected a second TotalCount once the new batch started');

  const afterSwitch = pkjs.__sentMessages.slice(secondTotalIndex);
  const leakedOldRide = afterSwitch.find((m) => m.RideWait === 111);
  assert.strictEqual(leakedOldRide, undefined,
    'no ride from the superseded stream should ever be sent after the new stream\'s TotalCount');
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
