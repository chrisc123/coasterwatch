// Regression tests for the Clay-based settings webview (src/pkjs/index.js's
// buildClayConfig(), the custom RIDE_LIST_COMPONENT, and the webviewclosed
// handler) — the thing that's been hardest to get right by eyeballing code
// and round-tripping to a real watch/phone.
// Run with: node test/settings-webview.test.js
'use strict';

const assert = require('assert');
const {
  loadPkjs, renderSettingsPage, closeSettingsPage, click,
} = require('./pkjs-harness');

let passed = 0;
const failures = [];
const tests = [];

// fn may be sync or return a Promise (e.g. tests waiting on a 'popstate'
// event, which fires asynchronously even in real browsers) — queued rather
// than run immediately so the async ones can be awaited in order below.
function test(name, fn) {
  tests.push({ name, fn });
}

// A ride known to have an infoUrl in the real roster (Abyssus, Energylandia).
const RIDE_ID_WITH_INFO = 11281;

function infoLinkFor(document, rideId) {
  const checkbox = document.querySelector('input[data-id="' + rideId + '"]');
  assert.ok(checkbox, 'expected a checkbox for ride ' + rideId);
  return { checkbox, infoLink: checkbox.closest('label').querySelector('.infolink') };
}

test('a ride info icon is a real <a> carrying its infoUrl in data-url', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const { infoLink } = infoLinkFor(document, RIDE_ID_WITH_INFO);
  assert.ok(infoLink, 'expected an .infolink anchor next to the checkbox');
  assert.strictEqual(infoLink.tagName, 'A', 'info link must be a real <a> — only anchors are exempt from a ' +
    "<label>'s default click-anywhere-toggles-the-checkbox behavior; a <span> is not");
  assert.ok(infoLink.getAttribute('data-url').indexOf('http') === 0,
    'data-url should be a real URL: ' + infoLink.getAttribute('data-url'));
});

test('clicking a ride info icon does not toggle its checkbox (relies on native <label> anchor exemption)', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const { checkbox, infoLink } = infoLinkFor(document, RIDE_ID_WITH_INFO);
  const wasChecked = checkbox.checked;

  click(infoLink);

  assert.strictEqual(checkbox.checked, wasChecked, 'checkbox state must not change from tapping the info icon');
});

test('clicking a ride info icon opens the overlay iframe on the ride URL without navigating the page away', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const { infoLink } = infoLinkFor(document, RIDE_ID_WITH_INFO);
  const url = infoLink.getAttribute('data-url');
  const overlay = document.getElementById('infoOverlay');
  assert.ok(!overlay.classList.contains('open'), 'overlay should start closed');

  click(infoLink);

  assert.ok(overlay.classList.contains('open'), 'overlay should be open after tapping the info icon');
  assert.strictEqual(document.getElementById('infoFrame').src, url, 'iframe should be pointed at the ride URL');
});

// The close button goes through history.back() (so a real back-swipe/back-
// button gesture and this button converge on the same popstate-driven
// close path — see the production code's comment) — popstate fires
// asynchronously even in real browsers, so this test has to be too.
test('closing the info overlay leaves all settings state (e.g. checkbox picks) exactly as it was', async () => {
  const pkjs = loadPkjs();
  const { window, document } = renderSettingsPage(pkjs);
  const { checkbox, infoLink } = infoLinkFor(document, RIDE_ID_WITH_INFO);
  checkbox.checked = !checkbox.checked;
  const flippedState = checkbox.checked;

  click(infoLink);
  const closed = new Promise((resolve) => window.addEventListener('popstate', resolve));
  document.getElementById('infoOverlayClose').click();
  await closed;

  assert.ok(!document.getElementById('infoOverlay').classList.contains('open'), 'overlay should close');
  assert.strictEqual(checkbox.checked, flippedState,
    'a checkbox toggled before opening the info overlay must still reflect that choice after closing it — ' +
    'nothing ever navigated away, so nothing should have reset');
});

// Simulates the actual back-swipe/back-button gesture this feature is for —
// the phone's own gesture (not our "Back to Settings" button) popping the
// history entry we pushed when the overlay opened.
test('a back-gesture-style history pop (not the Back button) also closes the overlay', async () => {
  const pkjs = loadPkjs();
  const { window, document } = renderSettingsPage(pkjs);
  const { infoLink } = infoLinkFor(document, RIDE_ID_WITH_INFO);

  click(infoLink);
  assert.ok(document.getElementById('infoOverlay').classList.contains('open'), 'sanity check: overlay should be open');

  const closed = new Promise((resolve) => window.addEventListener('popstate', resolve));
  window.history.back();
  await closed;

  assert.ok(!document.getElementById('infoOverlay').classList.contains('open'),
    'a bare history-pop (standing in for a real back-swipe) should close the overlay too, not just our own button');
});

// Rules out a logic bug on repeat use (reported symptom: back-swipe closes
// the overlay fine the first time, then shows a blank screen on a second
// ride's info page). What jsdom can verify is that our own state — which
// overlay/iframe is open, the history entry we manage — stays correct
// across two full open/close cycles; a real WKWebView's back-gesture
// snapshot rendering on repeat same-document navigations is outside what
// jsdom can reproduce, so this can't confirm the on-device symptom is
// fixed, only that nothing on our side gets confused by a second round.
test('opening a second ride after closing the first behaves the same as the first time', async () => {
  const pkjs = loadPkjs();
  const { window, document } = renderSettingsPage(pkjs);
  const first = infoLinkFor(document, RIDE_ID_WITH_INFO);
  const second = infoLinkFor(document, 11280); // Light Explorers — a different ride with its own infoUrl

  click(first.infoLink);
  let closed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
  window.history.back();
  await closed;
  assert.ok(!document.getElementById('infoOverlay').classList.contains('open'), 'first overlay should have closed');

  click(second.infoLink);
  assert.ok(document.getElementById('infoOverlay').classList.contains('open'), 'second overlay should open');
  assert.strictEqual(document.getElementById('infoFrame').src, second.infoLink.getAttribute('data-url'),
    'second overlay should show the second ride\'s URL, not a stale first one');

  closed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
  window.history.back();
  await closed;
  assert.ok(!document.getElementById('infoOverlay').classList.contains('open'), 'second overlay should also close');
});

// Guards against a regression the "always push a fresh entry after closing"
// fix could easily introduce: if that push happened unconditionally on
// every popstate rather than only when an overlay was actually open, a
// genuine exit-swipe on the plain settings page (no overlay ever opened)
// would get perpetually trapped by our own history entries instead of
// ever being allowed to actually leave Settings.
test('a popstate with no overlay open does not push another history entry', async () => {
  const pkjs = loadPkjs();
  const { window } = renderSettingsPage(pkjs);
  const lengthBefore = window.history.length;

  const handled = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
  window.dispatchEvent(new window.PopStateEvent('popstate', {}));
  await handled;

  assert.strictEqual(window.history.length, lengthBefore,
    'no overlay was open, so this popstate must not push a new guard entry — otherwise a real exit-swipe ' +
    'on the plain settings page would never reach the settings webview\'s own close handling');
});

test('quick-action buttons only affect the currently active park', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const rideList = document.querySelector('.component-ridelist');
  const noneBtn = rideList.querySelector('.rl-btn-none');

  click(noneBtn);

  const activeChecked = rideList.querySelector('.rl-park:not(.hide) input[type=checkbox]:checked');
  assert.strictEqual(activeChecked, null, 'None should uncheck every box in the active park');
});

test('a preset button highlights itself when tapped, and only itself', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const rideList = document.querySelector('.component-ridelist');
  const allBtn = rideList.querySelector('.rl-btn-all');
  const noneBtn = rideList.querySelector('.rl-btn-none');
  const defaultBtn = rideList.querySelector('.rl-btn-default');

  click(noneBtn);
  assert.ok(noneBtn.classList.contains('active'), 'None should highlight itself when tapped');
  assert.ok(!allBtn.classList.contains('active'), 'tapping None should not highlight All');

  click(allBtn);
  assert.ok(allBtn.classList.contains('active'), 'All should highlight itself when tapped');
  assert.ok(!noneBtn.classList.contains('active'), 'tapping All should clear None\'s highlight');
  assert.ok(!defaultBtn.classList.contains('active'), 'Coasters should never have been highlighted here');
});

test('manually ticking a checkbox after a preset clears its highlight', () => {
  const pkjs = loadPkjs();
  const { document } = renderSettingsPage(pkjs);
  const rideList = document.querySelector('.component-ridelist');
  const noneBtn = rideList.querySelector('.rl-btn-none');

  click(noneBtn);
  assert.ok(noneBtn.classList.contains('active'), 'sanity check: None should be highlighted right after tapping it');

  const checkbox = rideList.querySelector('.rl-park:not(.hide) input[type=checkbox]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

  assert.ok(!noneBtn.classList.contains('active'),
    "a manual tick means the checkboxes no longer necessarily match 'None', so the highlight should clear");
});

test('switching park clears any preset highlight', () => {
  const pkjs = loadPkjs();
  const { window, document } = renderSettingsPage(pkjs);
  const rideList = document.querySelector('.component-ridelist');
  const noneBtn = rideList.querySelector('.rl-btn-none');
  click(noneBtn);
  assert.ok(noneBtn.classList.contains('active'), 'sanity check: None should be highlighted right after tapping it');

  const select = document.querySelector('select');
  select.value = '2';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.ok(!noneBtn.classList.contains('active'), 'switching park should clear the previous park\'s highlight');
});

test('switching the park <select> shows only that park\'s ride list', () => {
  const pkjs = loadPkjs();
  const { window, document } = renderSettingsPage(pkjs);
  const select = document.querySelector('select');
  const energylandiaGroup = document.querySelector('.rl-park[data-park="317"]');
  const thorpeGroup = document.querySelector('.rl-park[data-park="2"]');
  assert.ok(!energylandiaGroup.classList.contains('hide'), 'Energylandia should be the initially active park');
  assert.ok(thorpeGroup.classList.contains('hide'), 'Thorpe Park should start hidden');

  select.value = '2';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.ok(energylandiaGroup.classList.contains('hide'), 'Energylandia should hide after switching away from it');
  assert.ok(!thorpeGroup.classList.contains('hide'), 'Thorpe Park should show once selected');
});

test('full save round-trip: park switch and band colors persist and survive a reopen', () => {
  const pkjs = loadPkjs();
  let page = renderSettingsPage(pkjs);

  // Switch to Thorpe Park.
  const select = page.document.querySelector('select');
  select.value = '2';
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));

  // Pick a distinctive color for the "short wait" band (pure red == 0xFF0000).
  const c0Hidden = page.document.querySelectorAll('.component-color input[type=hidden]')[0];
  c0Hidden.value = String(0xFF0000);

  closeSettingsPage(pkjs, page);

  assert.strictEqual(pkjs.getSelectedParkId(), 2, 'park selection should have persisted as Thorpe Park');
  const bands = pkjs.getBandConfig();
  assert.strictEqual(bands.c0, pkjs.rgb24ToArgb8(0xFF0000), 'the picked color should round-trip to the right GColor8 byte');

  // Reopen from scratch, as happens after any webview close.
  page = renderSettingsPage(pkjs);
  const reopenedSelect = page.document.querySelector('select');
  assert.strictEqual(reopenedSelect.value, '2', 'Park select should reopen showing Thorpe Park');
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
