# Watchapp starter template

A minimal, correct Pebble C watchapp: a window with a title and a SELECT-button
counter, wired up with the create/destroy memory pattern.

## Use it

1. Copy this directory to a new project location and `cd` into it.
2. Set a unique UUID in `package.json`:
   ```bash
   uuidgen | tr 'A-Z' 'a-z'   # paste into pebble.uuid
   ```
   Also update `name`, `author`, and `pebble.displayName`.
3. Build and run:
   ```bash
   pebble build
   pebble install --emulator basalt --logs
   ```
   Then drive it from another terminal and check the result:
   ```bash
   pebble emu-button click select        # press SELECT — counter increments
   pebble screenshot out.png --no-open   # capture the screen to verify
   ```
   (The first `install --emulator` may print "Connection refused" while QEMU
   boots — just run it again.)

## What it shows

- `init()` → `app_event_loop()` → `deinit()` structure
- A `Window` with `.load`/`.unload` handlers creating and destroying every layer
- A `ClickConfigProvider` subscribing the SELECT button
- A `static char` buffer behind `text_layer_set_text` (it stores the pointer)
- Layout from `layer_get_bounds()` with `PBL_IF_ROUND_ELSE` / `PBL_IF_COLOR_ELSE`

## Next steps

- Add a list UI → see `references/interaction.md` (MenuLayer).
- Talk to the phone / add settings → `references/communication-and-data.md`
  (AppMessage, PebbleKit JS, Clay). Remember to declare `messageKeys` in
  `package.json` and, for a config page, add `"capabilities": ["configurable"]`.
- Add images/fonts → declare them in `resources.media` (see
  `references/cli-and-project.md`) and place files under `resources/`.
- Make it a watchface instead → set `watchapp.watchface` to `true` and subscribe
  to `tick_timer_service_subscribe(MINUTE_UNIT, ...)`.
