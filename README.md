# CoasterWatch

Live roller-coaster queue times on your Pebble, powered by
[Queue-Times.com](https://queue-times.com/en-US).

<p>
  <a href="https://apps.rePebble.com/702bd7b27ec8456280b5ab7a">Pebble appstore listing</a>
</p>

## Features

- **Metro-tile grid** of every tracked ride's current wait time, colour-coded
  by band (short / medium / long), with a header showing the clock and
  current sort order.
- **Touch support** on Pebble Time 2 and Round 2 (tap a tile, drag to
  scroll), with full button navigation as the universal fallback on every
  other Pebble.
- **Per-ride detail view**: a graph of today's recorded wait times (there's
  no historical API, so the app records samples itself while running),
  GPS distance to the ride, and a queue alert you can arm right there.
- **Configurable queue alerts** — set a wait-time threshold per ride and get
  buzzed the moment it drops below it. Pick a vibration pattern (Standard,
  Nudge, Mario, Heartbeat), a highlight colour, and the tile/graph reflect
  the armed/triggered state live.
- **Multi-park support** — currently Energylandia (Poland) and Thorpe Park
  (UK), each remembering its own ride selection independently.
- **Settings page** built with [Clay](https://github.com/pebble-dev/clay):
  pick your park, choose which rides to track (with a Coasterpedia/park-site
  info link per ride so you can check it out before enabling it), set tile
  colours and thresholds, and configure the alert vibration pattern — all
  from your phone.
- Round-display-aware layout: the header and per-ride detail view are kept
  clear of the bezel, and Gabbro (Round 2's larger screen) gets an extra
  grid row instead of just stretching everything.

## Project layout

```
src/c/main.c        Watch-side app (C, Pebble SDK)
src/pkjs/index.js   Phone-side companion (PebbleKit JS): fetches queue data,
                     builds the Clay settings page, talks to the watch
test/               jsdom-based tests for the settings page (no phone/watch
                     needed to run them)
resources/          Watch app icon + the embedded custom font
store-assets/        Appstore listing icon exports
```

## Building and running

Uses the [rePebble](https://developer.repebble.com) `pebble` CLI (SDK 4.x).

```bash
pebble build
pebble install --emulator basalt      # or chalk/emery/gabbro/aplite/diorite/flint
pebble install --phone <watch-ip>     # real hardware, with Developer Mode on
```

Settings-page tests (no watch/phone required):

```bash
npm test
```

## Publishing

```bash
pebble login
pebble publish
```

See `pebble publish --help` for non-interactive flags (screenshots, icons,
category, etc.) if updating an existing listing.

## Attribution

Queue time data is provided by [Queue-Times.com](https://queue-times.com/en-US),
credited in-app per their terms.
