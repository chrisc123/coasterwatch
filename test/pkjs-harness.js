// Loads src/pkjs/index.js into a sandboxed VM context, standing in for the
// phone-side PebbleKit JS environment (Pebble, localStorage, XHR, geolocation,
// and now Clay) without needing a real phone/watch. Used by test/*.test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const PKJS_PATH = path.join(__dirname, '..', 'src', 'pkjs', 'index.js');

function makeLocalStorage(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

// Loads the PKJS module fresh into its own VM context. `storageSeed` presets
// localStorage entries (e.g. { selectedParkId: '2' }) as if a prior save had
// already happened, so tests can start from an arbitrary saved state.
function loadPkjs(storageSeed) {
  const src = fs.readFileSync(PKJS_PATH, 'utf8');
  const openedUrls = [];
  const handlers = {};
  const sandbox = {
    console,
    localStorage: makeLocalStorage(storageSeed),
    Pebble: {
      addEventListener: (event, fn) => { handlers[event] = fn; },
      sendAppMessage: () => {},
      openURL: (url) => openedUrls.push(url),
      getActiveWatchInfo: () => null,
      getAccountToken: () => '',
      getWatchToken: () => '',
    },
    XMLHttpRequest: function XMLHttpRequestStub() {
      this.open = () => {};
      this.send = () => {};
    },
    navigator: { geolocation: null },
  };
  vm.createContext(sandbox);

  // @rebble/clay's published package has no usable "main" as installed —
  // its top-level index.js requires a gulp-built ./tmp/config-page.html
  // that isn't shipped in the npm tarball. The real `pebble build` resolves
  // a bare require('@rebble/clay') to this prebuilt bundle instead
  // (confirmed by inspecting actual build output), so this harness points
  // at the same file directly. It must execute INSIDE this sandbox (not via
  // a plain top-level require in this harness file) so its internal
  // `Pebble`/`localStorage` globals bind to THIS context's fakes rather
  // than Node's real ones — every loadPkjs() call gets fully isolated state.
  let clayExports;
  sandbox.require = function (id) {
    if (id === 'message_keys') {
      // Only used by Clay to map messageKey strings to real numeric
      // AppMessage ids, which this app's webviewclosed handler bypasses
      // entirely (it reads Clay's response in raw/unconverted mode).
      return {};
    }
    if (id === '@rebble/clay') return clayExports;
    throw new Error('pkjs-harness: unexpected require(' + id + ')');
  };
  const clayBundleSrc = fs.readFileSync(require.resolve('@rebble/clay/src/js/index.js'), 'utf8');
  // The bundle's UMD wrapper checks `typeof exports === 'object'` too, not
  // just `module` — without a separate `exports` global it falls through to
  // a different branch (assigning to a global `rebbleclay` instead).
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(clayBundleSrc, sandbox, { filename: 'clay-bundle.js' });
  clayExports = sandbox.module.exports;
  delete sandbox.module;
  delete sandbox.exports;

  vm.runInContext(src, sandbox, { filename: 'index.js' });
  sandbox.__openedUrls = openedUrls;
  sandbox.__handlers = handlers;
  return sandbox;
}

// Builds the actual settings page HTML the phone would show — constructs a
// real Clay instance from the loaded context's own buildClayConfig() +
// component registrations, exactly like the showConfiguration handler does,
// then decodes the generated data: URI back to a string.
function buildSettingsHtml(pkjsCtx) {
  const clay = new pkjsCtx.Clay(pkjsCtx.buildClayConfig(), pkjsCtx.claySettingsCustomFn, { autoHandleEvents: false });
  clay.registerComponent(pkjsCtx.RIDE_LIST_COMPONENT);
  const url = clay.generateUrl();
  return decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));
}

// Renders that HTML into a real DOM (jsdom, scripts executing) — this is
// the actual settings webview a user taps through, not just a string.
function renderSettingsPage(pkjsCtx) {
  const html = buildSettingsHtml(pkjsCtx);
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://el-queues.test/' });
  dom.window.alert = () => {}; // jsdom doesn't implement alert(); silence its warning
  return { dom, window: dom.window, document: dom.window.document };
}

// Builds the exact JSON shape Clay's own webview-side serialize() produces
// at submit time ({ messageKey: { value: ... }, ... }) from a rendered
// page's current DOM state.
//
// This deliberately re-derives each value with plain DOM queries rather
// than calling RIDE_LIST_COMPONENT's own get() function: it's written to
// run *inside the rendered page* (it's tosource()'d into it, same as the
// customFn), so its bare `document` references bind to the page's own
// global scope. Called cross-context — e.g. against the pkjsCtx sandbox it
// was loaded into — `document` would resolve to that sandbox's globals
// instead (it has none), not the rendered page's. Querying the rendered
// page's DOM directly sidesteps that mismatch entirely, and is exactly
// what that function does anyway.
function serializeSettingsPage(page) {
  const response = {};

  response.park = { value: page.document.querySelector('select').value };

  const activeGroup = page.document.querySelector('.rl-park:not(.hide)');
  const checkedIds = [];
  if (activeGroup) {
    activeGroup.querySelectorAll('input[type=checkbox]:checked').forEach((cb) => {
      checkedIds.push(parseInt(cb.getAttribute('data-id'), 10));
    });
  }
  response.visibleRideIds = { value: checkedIds };

  const sliders = page.document.querySelectorAll('input.slider');
  response.t1 = { value: sliders[0].value };
  response.t2 = { value: sliders[1].value };

  const colorHiddenInputs = page.document.querySelectorAll('.component-color input[type=hidden]');
  response.c0 = { value: colorHiddenInputs[0].value };
  response.c1 = { value: colorHiddenInputs[1].value };
  response.c2 = { value: colorHiddenInputs[2].value };
  response.cAlert = { value: colorHiddenInputs[3].value };

  return response;
}

// Fires the webviewclosed handler exactly as PKJS would on a real device,
// given a rendered page's current state (see serializeSettingsPage above).
function closeSettingsPage(pkjsCtx, page) {
  const response = serializeSettingsPage(page);
  pkjsCtx.__handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify(response)) });
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
}

module.exports = {
  loadPkjs, renderSettingsPage, serializeSettingsPage, closeSettingsPage, click, makeLocalStorage,
};
