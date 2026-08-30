// Tests for the ride-log pipeline: the watch's RideLogStart/Chunk/End
// AppMessages -> a session on the phone -> localStorage -> the settings page's
// history list -> the GitHub sync.
//
// These drive the REAL src/pkjs/index.js through its real `appmessage`
// handler. An earlier version of this file re-declared its own private copies
// of handleRideLogStart/Chunk/End and asserted against those, so it stayed
// green through two bugs that broke the feature completely on device:
//
//   1. handleRideLogStart read an `s_cached_location` that was never declared
//      in index.js -> ReferenceError on the very first message, so no session
//      was ever created, nothing was persisted and nothing was ever uploaded.
//   2. toByteArray dispatched on `typeof data === 'object'`, but the emulator
//      hands byte arrays over as STPyV8's `JSArray`, whose typeof is
//      "function" -> every chunk decoded to zero samples.
//
// Neither is reachable by a test that owns its own copy of the code. Import
// the module; don't reimplement it.
'use strict';

const assert = require('assert');
const { loadPkjs, renderSettingsPage } = require('./pkjs-harness');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (e) {
    failures.push({ name, e });
    console.log('FAIL - ' + name + '\n    ' + (e && e.message));
  }
}

// The message-key ids the watch actually writes (package.json `messageKeys`),
// for the raw-numeric-payload case.
const KEY = {
  RideLogStart: 10023, RideLogChunk: 10024, RideLogEnd: 10025,
  RideLogRideName: 10026, RideLogRideId: 10027, RideLogDuration: 10028,
  RideLogMaxG: 10029, RideLogMinG: 10030, RideLogAirtimeMs: 10031,
  RideLogAirtimeHills: 10032, RideLogTurns: 10033, RideLogTotalSamples: 10034,
  RideLogAvgG: 10035, RideLogMaxAirtimeMs: 10036, RideLogHighGMs: 10037,
  RideLogRotationDeg: 10038, RideLogRoughness: 10039,
  RideLogSampleIntervalMs: 10040, RideLogTruncated: 10041, RideLogClipped: 10042,
};

// Stands in for STPyV8's `JSArray`, the shape byte arrays actually arrive in
// under the emulator's pkjs: array-like (length + numeric indices, works with
// Array.prototype.slice) but `Array.isArray()` is false and `typeof` reports
// "function", not "object". A function object is the only ordinary way to get
// that combination in Node. `length` needs defineProperty because
// Function.prototype.length is non-writable — a plain assignment silently
// no-ops and the mock would report length 0, hiding the very thing under test.
function asEmulatorByteArray(arr) {
  const f = function () {};
  arr.forEach((v, i) => { f[i] = v; });
  Object.defineProperty(f, 'length', { value: arr.length, writable: true, configurable: true });
  return f;
}

function startMsg(over) {
  return Object.assign({
    RideLogStart: 1,
    RideLogRideId: 101,
    RideLogRideName: 'Zadra',
    RideLogDuration: 110,
    RideLogMaxG: 4250,
    RideLogMinG: 80,
    RideLogAvgG: 1340,
    RideLogAirtimeMs: 3500,
    RideLogAirtimeHills: 4,
    RideLogMaxAirtimeMs: 1400,
    RideLogHighGMs: 6800,
    RideLogTurns: 7,
    RideLogRotationDeg: 1260,
    RideLogRoughness: 480,
    RideLogSampleIntervalMs: 400,
    RideLogTotalSamples: 3,
  }, over || {});
}

// seq is a *sample* offset, not a chunk index — the watch writes
// s_tracker_sync_offset straight into the header, and the phone turns it back
// into a timestamp as (seq + i) * 40ms.
function chunkBytes(seq, samples) {
  const b = [(seq >> 8) & 0xFF, seq & 0xFF, samples.length];
  samples.forEach(([x, y, z, headingTenths]) => {
    b.push((x >> 8) & 0xFF, x & 0xFF, (y >> 8) & 0xFF, y & 0xFF,
           (z >> 8) & 0xFF, z & 0xFF, (headingTenths >> 8) & 0xFF, headingTenths & 0xFF);
  });
  return b;
}

// A full watch->phone exchange. `wrap` decides which byte-array
// representation the chunks arrive in.
function recordRide(pkjs, { start, chunks, wrap = asEmulatorByteArray } = {}) {
  const am = pkjs.__handlers.appmessage;
  am({ payload: start || startMsg() });
  (chunks || []).forEach((c) => am({ payload: { RideLogChunk: wrap(c) } }));
  am({ payload: { RideLogEnd: 1, RideLogTotalSamples: 3 } });
}

function savedLogs(pkjs) {
  return JSON.parse(pkjs.localStorage.getItem('coasterwatch_ride_logs') || '[]');
}

// Three samples with hand-checked decodes:
//   (100, -200, 1000) @ 180.0deg  -> |g| = 1.02
//   (-500, 300, 2500) @ 270.0deg  -> |g| = 2.57
//   (0, 0, 1000)      @ 0.0deg    -> |g| = 1
const SAMPLES_A = [[100, -200, 1000, 1800], [-500, 300, 2500, 2700]];
const SAMPLES_B = [[0, 0, 1000, 0]];

console.log('Testing Ride Logger:');

test('a RideLogStart AppMessage creates a session and persists it immediately', () => {
  const pkjs = loadPkjs();
  pkjs.__handlers.appmessage({ payload: startMsg() });

  const logs = savedLogs(pkjs);
  assert.strictEqual(logs.length, 1, 'the start message alone should persist a session, ' +
    'so a ride that never finishes syncing still leaves a record');
  assert.strictEqual(logs[0].rideName, 'Zadra');
  assert.strictEqual(logs[0].durationSec, 110);
  assert.deepStrictEqual(logs[0].summary, {
    maxG: 4.25, minG: 0.08, avgG: 1.34,
    airtimeSec: 3.5, airtimeHills: 4, maxAirtimeSec: 1.4, highGSec: 6.8,
    turns: 7, rotationDeg: 1260, roughness: 480, totalSamples: 3,
  });
});

test('minG is carried as a magnitude — the watch cannot report negative G', () => {
  const pkjs = loadPkjs();
  // Even if something upstream sent a negative, nothing in the pipeline should
  // be manufacturing one: the watch computes sqrt(x^2+y^2+z^2), which floors
  // at 0. This pins the honest contract the settings card now advertises.
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });
  const sm = savedLogs(pkjs)[0].summary;
  assert.ok(sm.minG >= 0, 'minG must never be negative, got ' + sm.minG);
  assert.ok(sm.maxG >= sm.minG, 'maxG must not be below minG');
});

test('the sample interval measured by the watch drives the exported timestamps', () => {
  const pkjs = loadPkjs();
  // 20ms per sample (50Hz), reported as tenths of a ms.
  recordRide(pkjs, {
    start: startMsg({ RideLogSampleIntervalMs: 200 }),
    chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)],
  });

  const ride = savedLogs(pkjs)[0];
  assert.strictEqual(ride.sampleIntervalMs, 20);
  assert.strictEqual(ride.sampleRateHz, 50);
  assert.deepStrictEqual(ride.samples.map((x) => x[0]), [0, 20, 40],
    'timestamps must follow the measured interval, not a hardcoded 40ms');
});

test('a missing or absurd sample interval falls back to 40ms', () => {
  const pkjs = loadPkjs();
  const start = startMsg();
  delete start.RideLogSampleIntervalMs;
  recordRide(pkjs, { start, chunks: [chunkBytes(0, SAMPLES_A)] });

  const ride = savedLogs(pkjs)[0];
  assert.strictEqual(ride.sampleIntervalMs, 40);
  assert.deepStrictEqual(ride.samples.map((x) => x[0]), [0, 40]);
});

test('samples that hit the accelerometer rail are counted and surfaced', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, {
    start: startMsg({ RideLogClipped: 37 }),
    chunks: [chunkBytes(0, SAMPLES_A)],
  });
  assert.strictEqual(savedLogs(pkjs)[0].clippedSamples, 37);

  const { document } = renderSettingsPage(pkjs);
  const card = document.querySelector('#rideLogsContainer .rl-card');
  assert.ok(card.querySelector('.rl-warn'), 'a clipped ride needs a warning row');
  assert.ok(card.querySelector('.rl-warn').textContent.indexOf('±4g sensor limit') !== -1,
    'a clipped peak is a floor, not a measurement, and must say so: ' + card.textContent);
});

test('a clean ride carries no clipping warning', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });
  assert.strictEqual(savedLogs(pkjs)[0].clippedSamples, 0);

  const { document } = renderSettingsPage(pkjs);
  assert.strictEqual(document.querySelector('#rideLogsContainer .rl-card .rl-warn'), null,
    'a clean ride should carry no warning row at all');
});

test('the decimated store interval, not the raw sample rate, drives timestamps', () => {
  const pkjs = loadPkjs();
  // The watch samples at ~104Hz but stores 1 in 4, so it reports the ~38.5ms
  // interval of the STORED series. Reporting the 9.6ms raw rate here would
  // compress every exported timestamp by 4x.
  recordRide(pkjs, {
    start: startMsg({ RideLogSampleIntervalMs: 385 }),
    chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)],
  });
  const ride = savedLogs(pkjs)[0];
  assert.strictEqual(ride.sampleIntervalMs, 38.5);
  assert.strictEqual(ride.sampleRateHz, 26);
  assert.deepStrictEqual(ride.samples.map((x) => x[0]), [0, 39, 77]);
});

test('a truncated recording is flagged through to the settings card', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, {
    start: startMsg({ RideLogTruncated: 1 }),
    chunks: [chunkBytes(0, SAMPLES_A)],
  });
  assert.strictEqual(savedLogs(pkjs)[0].truncated, true);

  const { document } = renderSettingsPage(pkjs);
  const card = document.querySelector('#rideLogsContainer .rl-card');
  assert.ok(card.querySelector('.rl-warn').textContent.indexOf('Sample buffer filled') !== -1,
    'a ride whose buffer filled must say so — the summary and the samples ' +
    'otherwise silently describe different spans: ' + card.textContent);
});

test('the chunk decoder accepts the emulator\'s JSArray, whose typeof is "function"', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  const ride = savedLogs(pkjs)[0];
  assert.strictEqual(ride.samples.length, 3,
    'chunks arriving as a JSArray must decode; falling through toByteArray\'s ' +
    'dispatch chain silently yields a ride with metadata but no telemetry');
});

test('the chunk decoder also accepts a plain Array, as a real phone sends', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)], wrap: (a) => a });

  assert.strictEqual(savedLogs(pkjs)[0].samples.length, 3);
});

test('the chunk decoder also accepts a Uint8Array', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, {
    chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)],
    wrap: (a) => new Uint8Array(a),
  });

  assert.strictEqual(savedLogs(pkjs)[0].samples.length, 3);
});

test('chunks decode 16-bit signed accelerations, heading, and derived total g', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  const [s0, s1] = savedLogs(pkjs)[0].samples;
  assert.deepStrictEqual(s0, [0, 100, -200, 1000, 1.02, 180], 'sample 0: t, x, y, z, |g|, heading');
  assert.deepStrictEqual(s1, [40, -500, 300, 2500, 2.57, 270], 'sample 1 sits 40ms later at 25Hz');
});

test('a chunk\'s seq header is a sample offset, so later chunks keep absolute timestamps', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  const samples = savedLogs(pkjs)[0].samples;
  assert.deepStrictEqual(samples.map((s) => s[0]), [0, 40, 80],
    'the third sample belongs at 80ms, not back at 0 — seq counts samples, not chunks');
});

test('RideLogEnd persists the completed session with all of its samples', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  const logs = savedLogs(pkjs);
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].rideName, 'Zadra');
  assert.strictEqual(logs[0].samples.length, 3);
});

test('a payload keyed by raw numeric message ids decodes the same as a named one', () => {
  const pkjs = loadPkjs();
  pkjs.__handlers.appmessage({ payload: {
    [KEY.RideLogStart]: 1,
    [KEY.RideLogRideId]: 202,
    [KEY.RideLogRideName]: 'Hyperion',
    [KEY.RideLogDuration]: 85,
    [KEY.RideLogMaxG]: 4800,
    [KEY.RideLogMinG]: -500,
    [KEY.RideLogAirtimeMs]: 4500,
    [KEY.RideLogAirtimeHills]: 5,
    [KEY.RideLogTurns]: 4,
    [KEY.RideLogTotalSamples]: 2,
  } });
  pkjs.__handlers.appmessage({ payload: { [KEY.RideLogChunk]: asEmulatorByteArray(chunkBytes(0, SAMPLES_A)) } });
  pkjs.__handlers.appmessage({ payload: { [KEY.RideLogEnd]: 1 } });

  const ride = savedLogs(pkjs)[0];
  assert.strictEqual(ride.rideName, 'Hyperion');
  assert.strictEqual(ride.summary.maxG, 4.8);
  assert.strictEqual(ride.summary.minG, -0.5);
  assert.strictEqual(ride.summary.airtimeHills, 5);
  assert.strictEqual(ride.summary.turns, 4);
  assert.strictEqual(ride.samples.length, 2);
});

test('two recorded rides both survive, newest first', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });
  recordRide(pkjs, { start: startMsg({ RideLogRideName: 'Hyperion', RideLogRideId: 202 }),
                     chunks: [chunkBytes(0, SAMPLES_B)] });

  assert.deepStrictEqual(savedLogs(pkjs).map((r) => r.rideName), ['Hyperion', 'Zadra']);
});

test('a ride is stamped with the last GPS fix, and survives never having had one', () => {
  const pkjs = loadPkjs();

  // No fix yet: gps must be null rather than throwing (the previous
  // ReferenceError here killed the whole feature).
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });
  assert.strictEqual(savedLogs(pkjs)[0].gps, null, 'no fix yet -> gps null, not a throw');

  // A queue refresh takes a fix; the next ride should carry it.
  pkjs.navigator.geolocation = {
    getCurrentPosition: (ok) => ok({ coords: { latitude: 49.9972, longitude: 19.4081 } }),
  };
  pkjs.getLocation(() => {});

  recordRide(pkjs, { start: startMsg({ RideLogRideName: 'Abyssus' }), chunks: [chunkBytes(0, SAMPLES_A)] });
  assert.deepStrictEqual(savedLogs(pkjs)[0].gps, { lat: 49.9972, lon: 19.4081 });
});

test('buildCsvString emits a header plus one row per sample, with the ride\'s GPS', () => {
  const pkjs = loadPkjs();
  pkjs.navigator.geolocation = {
    getCurrentPosition: (ok) => ok({ coords: { latitude: 49.9972, longitude: 19.4081 } }),
  };
  pkjs.getLocation(() => {});
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  const lines = pkjs.buildCsvString(savedLogs(pkjs)[0]).trim().split('\n');
  assert.deepStrictEqual(lines, [
    'timestamp_ms,accel_x,accel_y,accel_z,total_g,heading_deg,latitude,longitude',
    '0,100,-200,1000,1.02,180,49.9972,19.4081',
    '40,-500,300,2500,2.57,270,49.9972,19.4081',
    '80,0,0,1000,1,0,49.9972,19.4081',
  ]);
});

test('utf8ToBase64 round-trips a CSV body (the fallback encoder, with no btoa)', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  const csv = pkjs.buildCsvString(savedLogs(pkjs)[0]);
  assert.strictEqual(Buffer.from(pkjs.utf8ToBase64(csv), 'base64').toString('utf8'), csv);
});

// --- GitHub sync -----------------------------------------------------------

// Captures the PUTs uploadRideToGitHub issues, answering each with `status`.
function captureGitHub(pkjs, status = 201) {
  const requests = [];
  pkjs.XMLHttpRequest = function () {
    const self = this;
    this.setRequestHeader = (k, v) => { (self._headers = self._headers || {})[k] = v; };
    this.open = (method, url) => { self._method = method; self._url = url; };
    this.send = (body) => {
      requests.push({ method: self._method, url: self._url, headers: self._headers || {}, body });
      self.status = status;
      self.responseText = '{}';
      if (self.onload) self.onload();
    };
  };
  return requests;
}

test('finishing a ride uploads a CSV and a JSON to the configured repo', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const requests = captureGitHub(pkjs);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  assert.strictEqual(requests.length, 2, 'expected one CSV upload and one JSON upload');
  requests.forEach((r) => {
    assert.strictEqual(r.method, 'PUT');
    assert.ok(r.url.indexOf('https://api.github.com/repos/me/telemetry/contents/rides/') === 0, r.url);
    assert.strictEqual(r.headers.Authorization, 'Bearer ghp_faketoken');
  });
  assert.ok(/\/zadra_[^/]+\.csv$/.test(requests[0].url), requests[0].url);
  assert.ok(/\/zadra_[^/]+\.json$/.test(requests[1].url), requests[1].url);

  // The uploaded CSV must be the real telemetry, not an empty shell.
  const uploaded = Buffer.from(JSON.parse(requests[0].body).content, 'base64').toString('utf8');
  assert.strictEqual(uploaded.trim().split('\n').length, 4, 'header + 3 samples');

  assert.strictEqual(savedLogs(pkjs)[0].githubSynced, true,
    'a synced ride is marked so the settings page can show it as uploaded');
});

test('a token already carrying its own scheme prefix is not double-prefixed', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'token ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const requests = captureGitHub(pkjs);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  assert.strictEqual(requests[0].headers.Authorization, 'token ghp_faketoken');
});

test('with no token configured the ride is still saved locally, and nothing is uploaded', () => {
  const pkjs = loadPkjs();
  const requests = captureGitHub(pkjs);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  assert.strictEqual(requests.length, 0, 'no token -> no upload attempt');
  assert.strictEqual(savedLogs(pkjs)[0].samples.length, 2,
    'the local record must survive regardless — GitHub is a mirror, not the store');
});

test('a failed CSV upload does not go on to upload the JSON, and leaves the ride unsynced', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const requests = captureGitHub(pkjs, 401);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  assert.strictEqual(requests.length, 1, 'a rejected CSV should abort the pair');
  assert.notStrictEqual(savedLogs(pkjs)[0].githubSynced, true);
});

test('cloud sync off keeps the ride locally and uploads nothing', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
    github_sync_enabled: '0',
  } });
  const requests = captureGitHub(pkjs);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  assert.strictEqual(requests.length, 0, 'sync disabled -> no upload, even with a valid token');
  assert.strictEqual(savedLogs(pkjs)[0].samples.length, 2,
    'the local record must survive regardless — the toggle governs the mirror, not the recording');
});

test('cloud sync defaults ON so an already-configured install keeps working', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const requests = captureGitHub(pkjs);

  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A)] });

  assert.strictEqual(requests.length, 2,
    'absent the key entirely, sync must stay on — introducing the toggle must ' +
    'not silently stop an install that was syncing before it existed');
});

test('the sync toggle round-trips through save, including turning it off', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const save = (enabled) => pkjs.__handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({
      githubSync: { value: { enabled, token: 'ghp_faketoken', repo: 'me/telemetry' } },
    })),
  });

  save(false);
  assert.strictEqual(pkjs.localStorage.getItem('github_sync_enabled'), '0',
    'false is a real value here — a truthiness check would make the toggle ' +
    'impossible to turn off');

  save(true);
  assert.strictEqual(pkjs.localStorage.getItem('github_sync_enabled'), '1');
});

// --- Settings page ---------------------------------------------------------

test('a recorded ride appears as a card in the settings page history list', () => {
  const pkjs = loadPkjs();
  recordRide(pkjs, { chunks: [chunkBytes(0, SAMPLES_A), chunkBytes(2, SAMPLES_B)] });

  const { document } = renderSettingsPage(pkjs);
  const cards = document.querySelectorAll('#rideLogsContainer .rl-card');
  assert.strictEqual(cards.length, 1, 'the ride recorded above must show up in Recorded Rides');
  assert.strictEqual(document.querySelector('#rideLogsCount').textContent, '1');

  const text = cards[0].textContent;
  assert.strictEqual(cards[0].querySelector('.rl-name').textContent, 'Zadra');
  assert.ok(cards[0].querySelector('.rl-count').textContent.indexOf('3 samples @ 25Hz') !== -1,
    'the card should report the samples that actually arrived: ' + text);

  // Read the stat grid as label -> value rather than matching concatenated
  // text, so restyling the card doesn't break the test but renaming a stat
  // does.
  const stats = {};
  cards[0].querySelectorAll('.rl-cell').forEach((c) => {
    stats[c.querySelector('.rl-lab').textContent] = c.querySelector('.rl-val').textContent;
  });
  assert.strictEqual(stats['Peak'], '4.25G');
  assert.strictEqual(stats['Min'], '0.08G');
  assert.strictEqual(stats['Turns · 1260°'], '7', 'turns, not inversions: ' + JSON.stringify(stats));
  assert.ok(text.indexOf('Inversion') === -1,
    'the app must not claim inversions — no gyro, and a compass bearing ' +
    'cannot see a loop: ' + text);
});

// --- Deleting rides --------------------------------------------------------

// Records `names` as separate rides and returns the rendered page.
function pageWithRides(pkjs, names) {
  names.forEach((n, i) => recordRide(pkjs, {
    start: startMsg({ RideLogRideName: n, RideLogRideId: 100 + i }),
    chunks: [chunkBytes(0, SAMPLES_A)],
  }));
  return renderSettingsPage(pkjs);
}

function cardNamed(document, name) {
  return [].slice.call(document.querySelectorAll('.rl-card'))
    .find((c) => c.querySelector('.rl-name').textContent === name);
}

function clickIn(card, sel) {
  const el = card.querySelector(sel);
  el.dispatchEvent(new card.ownerDocument.defaultView.MouseEvent(
    'click', { bubbles: true, cancelable: true }));
  return el;
}

// Exactly what Clay's serialize() does: call the item's get() for its
// messageKey. Going through the DOM rather than a hand-built list is the
// point — it proves the component actually reports its pending deletions.
function saveWithDeletions(pkjs, document) {
  const ids = [].slice.call(document.querySelectorAll('.rl-card[data-doomed="1"]'))
    .map((c) => c.getAttribute('data-ride-id'));
  pkjs.__handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({ deletedRideLogs: { value: ids } })),
  });
  return ids;
}

test('deleting a ride removes only that ride, and only once Save is tapped', () => {
  const pkjs = loadPkjs();
  const { document } = pageWithRides(pkjs, ['Zadra', 'Hyperion', 'Abyssus']);

  clickIn(cardNamed(document, 'Hyperion'), '.rl-btn-del');

  assert.deepStrictEqual(savedLogs(pkjs).map((r) => r.rideName), ['Abyssus', 'Hyperion', 'Zadra'],
    'marking must not delete anything yet — the webview cannot reach PKJS storage, ' +
    'so nothing may vanish until the save response carries the ids home');

  saveWithDeletions(pkjs, document);
  assert.deepStrictEqual(savedLogs(pkjs).map((r) => r.rideName), ['Abyssus', 'Zadra']);
});

test('a marked ride can be un-marked before saving', () => {
  const pkjs = loadPkjs();
  const { document } = pageWithRides(pkjs, ['Zadra', 'Hyperion']);
  const card = cardNamed(document, 'Hyperion');

  clickIn(card, '.rl-btn-del');
  assert.strictEqual(card.getAttribute('data-doomed'), '1');
  assert.strictEqual(card.querySelector('.rl-btn-del').textContent, 'Undo');

  clickIn(card, '.rl-btn-del');
  assert.strictEqual(card.getAttribute('data-doomed'), '0');
  assert.strictEqual(card.querySelector('.rl-btn-del').textContent, 'Delete');

  assert.deepStrictEqual(saveWithDeletions(pkjs, document), [], 'nothing should be sent');
  assert.strictEqual(savedLogs(pkjs).length, 2);
});

test('the pending notice appears with a count and says GitHub is untouched', () => {
  const pkjs = loadPkjs();
  const { document } = pageWithRides(pkjs, ['Zadra', 'Hyperion']);
  const notice = document.querySelector('#rlPending');
  assert.strictEqual(notice.style.display, 'none', 'no notice until something is marked');

  clickIn(cardNamed(document, 'Hyperion'), '.rl-btn-del');
  assert.notStrictEqual(notice.style.display, 'none');
  assert.ok(notice.textContent.indexOf('1 ride will be deleted') !== -1, notice.textContent);
  assert.ok(notice.textContent.indexOf('GitHub stays') !== -1,
    'must say the repo copy survives — otherwise deleting from the phone reads ' +
    'as destroying the archive: ' + notice.textContent);

  clickIn(cardNamed(document, 'Zadra'), '.rl-btn-del');
  assert.ok(notice.textContent.indexOf('2 rides will be deleted') !== -1, notice.textContent);
});

test('"Delete all" marks everything, and tapping it again unmarks everything', () => {
  const pkjs = loadPkjs();
  const { document } = pageWithRides(pkjs, ['Zadra', 'Hyperion', 'Abyssus']);
  const all = document.querySelector('#rlClearAll');
  const doomedCount = () => document.querySelectorAll('.rl-card[data-doomed="1"]').length;

  all.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(doomedCount(), 3);

  all.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(doomedCount(), 0, 'a second tap must undo, so a stray tap is recoverable');

  all.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
  saveWithDeletions(pkjs, document);
  assert.deepStrictEqual(savedLogs(pkjs), []);
});

test('deleting rides leaves the GitHub sync settings alone', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  captureGitHub(pkjs);
  const { document } = pageWithRides(pkjs, ['Zadra']);

  clickIn(cardNamed(document, 'Zadra'), '.rl-btn-del');
  saveWithDeletions(pkjs, document);

  assert.strictEqual(savedLogs(pkjs).length, 0);
  assert.strictEqual(pkjs.localStorage.getItem('github_sync_token'), 'ghp_faketoken',
    'a save carrying only deletions must not clear the credentials');
  assert.strictEqual(pkjs.localStorage.getItem('github_sync_repo'), 'me/telemetry');
});

// --- Settings page layout --------------------------------------------------

// Top-level Clay sections, ignoring the ride picker's own per-land sections.
function sectionHeadings(document) {
  return [].slice.call(document.querySelectorAll('.section'))
    .filter((s) => !s.closest('.rl-park'))
    .map((s) => { const h = s.querySelector('h4'); return h ? h.textContent.trim() : '(none)'; });
}

test('sections appear in the intended order, with recordings last', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  assert.deepStrictEqual(sectionHeadings(document),
    ['Park', 'Rides', 'Tile Colours', 'Alerts', 'Ride Recordings']);
});

test('recordings and cloud sync are one section, not two separated by the ride picker', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const rec = [].slice.call(document.querySelectorAll('.section'))
    .find((s) => { const h = s.querySelector('h4'); return h && h.textContent.trim() === 'Ride Recordings'; });

  assert.ok(rec.querySelector('#rideLogsContainer'), 'the recordings list belongs in this section');
  assert.ok(rec.querySelector('#ghSyncEnabled'),
    'cloud sync belongs with the recordings it serves — separating them put the ' +
    'whole 69-row ride picker between the two');
});

test('the custom components are not double-wrapped in .section', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  // Their templates used to declare `section` while buildClayConfig wrapped
  // them in one too, giving doubled padding/borders that made them read as
  // sub-parts of Rides rather than peers of it.
  assert.strictEqual(document.querySelectorAll('#rideLogsSection.section').length, 0,
    'the ride-logs root must not carry .section itself');
  assert.strictEqual(document.querySelectorAll('.component-githubsync.section').length, 0,
    'the github-sync root must not carry .section itself');
});

test('every top-level section titles itself the same way (a real Clay heading)', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  assert.ok(sectionHeadings(document).every((h) => h !== '(none)'),
    'a section using its own div for a title renders at a different weight ' +
    'than the stock ones: ' + JSON.stringify(sectionHeadings(document)));
});

test('the sync credentials stay hidden until asked for, and the summary says what will happen', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const { document } = renderSettingsPage(pkjs);
  const creds = document.querySelector('#ghCreds');
  const disclose = document.querySelector('#ghDisclose');
  const summary = document.querySelector('#ghSummary');
  const click = (el) => el.dispatchEvent(
    new document.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

  assert.strictEqual(creds.style.display, 'none', 'set-once config should start collapsed');
  assert.ok(summary.textContent.indexOf('me/telemetry') !== -1,
    'the collapsed state must still say where rides go: ' + summary.textContent);

  click(disclose);
  assert.notStrictEqual(creds.style.display, 'none', 'tapping Set up reveals them');
  click(disclose);
  assert.strictEqual(creds.style.display, 'none', 'and tapping again hides them');
});

test('the summary reflects sync being off, and a missing token', () => {
  const pkjs = loadPkjs({ storageSeed: {
    github_sync_token: 'ghp_faketoken', github_sync_repo: 'me/telemetry',
  } });
  const { document } = renderSettingsPage(pkjs);
  const cb = document.querySelector('#ghSyncEnabled');
  const summary = document.querySelector('#ghSummary');

  cb.checked = false; cb.onchange();
  assert.ok(summary.textContent.indexOf('stay on this phone') !== -1, summary.textContent);

  cb.checked = true; cb.onchange();
  const tok = document.querySelector('#ghSyncToken');
  tok.value = ''; tok.oninput();
  assert.ok(summary.textContent.indexOf('no token') !== -1,
    'sync on with no token is a real state and must not look configured: ' + summary.textContent);
});

test('the settings page shows the empty state when nothing has been recorded', () => {
  const pkjs = loadPkjs();

  const { document } = renderSettingsPage(pkjs);
  assert.strictEqual(document.querySelectorAll('#rideLogsContainer .rl-card').length, 0);
  assert.ok(document.querySelector('#rideLogsContainer').textContent.indexOf('No rides recorded yet') !== -1);
});

if (failures.length) {
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  failures.forEach((f) => { console.log('\n--- ' + f.name); console.log(f.e && f.e.stack); });
  process.exit(1);
}
console.log('\nAll ' + passed + ' ride logger tests passed!');
