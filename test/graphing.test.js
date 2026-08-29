// Regression tests for the graphing/history pipeline in src/pkjs/index.js:
// history sampling and downsampling for the watch's graph, the
// queue-times.com-is-wrong-about-is_open workaround (cross-checked against a
// mocked themeparks.wiki schedule), and the ride-switch race that used to let
// two graph requests' AppMessage streams interleave. No real phone/watch or
// network needed — queue-times.com and themeparks.wiki responses are mocked.
// Run with: node test/graphing.test.js
'use strict';

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

// getGraphPoints' history comes from real appendHistory() calls (real
// nowMinutes()) in every other test here; these three need specific,
// artificial minute-of-day gaps, so they seed queueHistory_v1 directly
// instead. localTodayStr() duplicates todayStr()'s exact (unpadded) format
// so the seeded entry reads as fresh, not stale-and-reset.
function localTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

test('getGraphPoints drops an earlier session separated by a long gap, keeping only the current one', () => {
  const pkjs = loadPkjs({
    storageSeed: {
      queueHistory_v1: JSON.stringify({
        date: localTodayStr(),
        rides: {
          [RIDE_A]: [
            [2, 0], [5, 0], [8, 0], // messing around with the app around midnight
            [600, 20], [605, 25], [610, 30], [615, 28], // today's actual session, from 10:00
          ],
        },
      }),
    },
  });
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.ok(points, 'expected a valid graph after trimming to the current session');
  assert.strictEqual(points.length, 4, "only the current session's samples should remain");
  assert.strictEqual(points[0].minuteOfDay, 600,
    "the graph should start at the current session's first sample, not the midnight cluster");
  assert.deepStrictEqual([...points.map((p) => p.wait)], [20, 25, 30, 28]);
});

test('getGraphPoints keeps everything when no gap exceeds the session threshold', () => {
  const pkjs = loadPkjs({
    storageSeed: {
      queueHistory_v1: JSON.stringify({
        date: localTodayStr(),
        rides: { [RIDE_A]: [[600, 10], [610, 15], [620, 20]] }, // normal ~10 min refresh spacing
      }),
    },
  });
  const points = pkjs.getGraphPoints(RIDE_A);
  assert.strictEqual(points.length, 3, 'nothing should be trimmed when every gap is within the normal refresh cadence');
});

test('getGraphPoints returns null if the current session alone has fewer than 2 samples', () => {
  const pkjs = loadPkjs({
    storageSeed: {
      queueHistory_v1: JSON.stringify({
        date: localTodayStr(),
        rides: { [RIDE_A]: [[2, 0], [5, 0], [600, 20]] }, // only 1 sample survives the trim
      }),
    },
  });
  assert.strictEqual(pkjs.getGraphPoints(RIDE_A), null);
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
