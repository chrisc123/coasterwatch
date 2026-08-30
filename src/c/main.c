#include <pebble.h>

// Energylandia queue times — a Metro/tile-style, continuously vertically
// scrollable grid of ride wait times, plus a per-ride detail view graphing
// today's recorded wait times, optional live distance-to-ride, and a
// per-ride queue alert (buzz when the wait drops to/below a threshold).
//
// Alerts are evaluated on every refresh regardless of which window is
// open, so an alert armed on one ride still fires while you're browsing
// another — but Pebble watchapps have no background execution, so nothing
// fires once this app isn't the one running on the watch.
//
// Navigation works two ways, side by side:
//  - Buttons: UP/DOWN move a highlighted cursor one tile at a time, scrolling
//    to keep it in view (on the grid) or adjust the alert threshold (in a
//    ride's detail view). SELECT (tap) opens the highlighted ride's graph
//    from the grid, or toggles its alert from the detail view. SELECT
//    (hold, grid only) cycles sort order through queue time, distance, and
//    alerts (rides with an armed alert pinned to the top, sub-sorted by
//    queue time; everything else below, sub-sorted by distance).
//    BACK exits / closes the graph.
//  - Touch (Pebble Time 2 / Round 2 hardware only — the CST816 touchscreen
//    support added in PebbleOS PR #1796): drag vertically to scroll the
//    list, tap a tile directly to open its graph. In the detail view, tap
//    the -/+ boxes or the label in the alert band to adjust/toggle it; tap
//    anywhere else (the graph or header) to close. (A horizontal swipe for
//    sort/refresh was tried and dropped on the grid: it was
//    ambiguous with tap — a short/slow swipe also satisfies tap's own
//    criteria — and swipe-right turned out to be intercepted by what's
//    apparently a system-level "swipe right = back" gesture that
//    window_set_touch_bridge_disabled() doesn't reach.) All of this is
//    compiled out on hardware without a touch sensor (see the
//    PBL_API_EXISTS guards below) — the buttons remain the only input there.
//
// Data comes from PebbleKit JS (src/pkjs/index.js): the live wait times, the
// phone's GPS distance to each ride (if known and available), and today's
// recorded history for the graph. queue-times.com has no historical API, so
// the graph only shows samples recorded while this app has been running
// today.

#define MAX_RIDES         40
#define MAX_GRAPH_POINTS  24
// Minutes between two consecutive graph points beyond which the connecting
// line is skipped (see detail_graph_update_proc) - well above the normal
// ~5-15 min refresh cadence (REFRESH_INTERVAL_MS below, further stretched
// on low battery), so it only fires on a real gap (app closed/backgrounded
// a while, watch put away), not just a slow refresh tick. Purely a visual
// cue that two neighbouring points aren't contiguous in time: pkjs sends
// the whole recorded day and no longer treats gaps specially at all, so
// this value is local to the drawing here and nothing else depends on it.
#define GRAPH_GAP_MINUTES 60
#define TILE_COLS         2
// Grid margin: gap from the screen edge to the outermost tile, and between
// tiles - see compute_grid_metrics(). Also used to line up the header's
// clock/sort text with the tile grid directly below it (clock_update_proc,
// header_update_proc), so the two can't silently drift out of alignment
// with each other.
#define TILE_PAD           4
#define NAME_BUF_LEN      24
// Minimum gap deliberately reserved between a text element and whatever's
// immediately next to it (a tile's own bottom edge, an adjacent layer's
// boundary) - drawing text flush against an edge, even in an otherwise
// tightly-sized box, reads as touching/cramped rather than intentionally
// placed there.
#define TEXT_EDGE_PADDING 3
#define HEADER_HEIGHT       18
#define HEADER_CLOCK_WIDTH  50
#define SETTINGS_SORT_KEY    1
#define SETTINGS_ALERTS_KEY  2
#define SETTINGS_BANDS_KEY   3
#define SETTINGS_CACHED_RIDES_COUNT_KEY 4
#define SETTINGS_CACHED_RIDES_DATA_KEY  5  // legacy blob; only deleted now
#define SETTINGS_TOUCH_LOCK_KEY 6
// Chunked ride cache. persist_write_data() caps a *single value* at
// PERSIST_DATA_MAX_LENGTH (256) and — the trap — silently returns a short
// write rather than failing, so the old single-key blob asked to store 1600
// bytes, got 256 back, and had only ever cached the first ~6 of 40 rides.
#define SETTINGS_RIDE_CACHE_BASE_KEY   10
// Sized to the realistic need, not the theoretical maximum: a 40-ride park at
// ~8 bytes plus a name each lands near 800 bytes. Whatever doesn't fit simply
// isn't cached (the pack loop stops), which costs a couple of tiles on the
// launch screen and nothing else. Aplite has 24KB of app RAM in total and the
// link fails outright at 8 chunks, so it gets a smaller cache rather than the
// feature being dropped.
#define SETTINGS_RIDE_CACHE_MAX_CHUNKS 4

// Aplite (the 2013 Pebble: 24KB of app RAM, and this app already fills it)
// cannot fit the pack/unpack code — the link overflows the APP region by
// ~190 bytes with it in, and shrinking the buffer doesn't help because it's
// the code, not the data. It gets no launch cache: an empty grid for the
// second or two before the phone answers, which is what it did before the
// cache existed at all. Everything else on aplite is unaffected.
#if defined(PBL_PLATFORM_APLITE)
#define RIDE_CACHE_SUPPORTED 0
#else
#define RIDE_CACHE_SUPPORTED 1
#endif
// Bump when the record layout below changes, so a stale cache is discarded
// instead of being read back misaligned. (Adding RideTile.flags moved
// sizeof(RideTile) 36 -> 40 and would have done exactly that.)
#define RIDE_CACHE_VERSION 1
// queue-times.com updates its data every 5 minutes, so polling more often
// than that just burns battery/network for no fresher data.
#define REFRESH_INTERVAL_MS (5 * 60 * 1000)

#define MAX_ALERTS            20
#define ALERT_STEP_MINUTES     5
#define ALERT_MAX_MINUTES    120
#define ALERT_DEFAULT_MINUTES 15
#define ALERT_BAND_HEIGHT     44

// These values are PERSISTED (SETTINGS_SORT_KEY), so they are append-only —
// the numbers must keep the meaning they shipped with. SORT_TIME_DESC is 3,
// not 1, precisely because inserting it at 1 renumbered DISTANCE and ALERTS
// underneath every watch that already had one of them saved: on the next
// launch a watch set to Distance came back on Time-descending and one set to
// Alerts came back on Distance, which reads exactly like "the setting didn't
// persist". The cycle *order* below is independent of these numbers, so
// appending costs nothing.
typedef enum {
  SORT_TIME_ASC = 0,   // shipped as SORT_TIME
  SORT_DISTANCE = 1,
  SORT_ALERTS = 2,
  SORT_TIME_DESC = 3,  // appended
  SORT_MODE_COUNT
} SortMode;

// Per-ride flag bits from the phone's RidesData packet. The phone owns the
// "is it today" decision because it owns anything timezone-aware.
#define RIDE_FLAG_LOGGED_TODAY (1 << 0)

typedef struct {
  int32_t ride_id;
  char    name[NAME_BUF_LEN];
  int16_t wait_minutes;   // -1 = closed
  int32_t distance_m;     // -1 = unknown
  uint8_t flags;          // RIDE_FLAG_*
} RideTile;

// A ride's queue alert: buzz when its wait drops to or below threshold_min.
// was_below is a run-time edge-trigger latch, not meant to survive a reload
// with a stale value — see load_alerts(), which always resets it to false.
typedef struct {
  int32_t ride_id; // 0 = empty slot
  int16_t threshold_min;
  bool    enabled;
  bool    was_below;
} AlertConfig;

// Wait-time tile colors: 3 user-configurable bands (wait < t1, t1..t2, >= t2)
// plus a separate color for "alert condition met" (overrides the band
// color). Colors are raw GColor8 ARGB8 bytes (see gcolor_definitions.h) —
// the phone sends whichever named color the user picked in settings, and
// text contrast is computed from the color's own channels rather than
// also being configured, so any color choice always renders legibly.
typedef struct {
  int16_t t1;
  int16_t t2;
  GColor  band_color[3];
  GColor  alert_color;
  // Appended at the end deliberately: this struct is persisted as a raw
  // byte blob (see save_band_config/load_band_config), and persist_read_data
  // leaves untouched bytes beyond whatever was actually stored — so a
  // pre-existing save (from before this field existed) leaves vibe_pattern
  // at its static-initializer default below rather than reading garbage.
  int8_t  vibe_pattern;
} BandConfig;

#ifdef PBL_COLOR
// Custom (not system) font: Roboto Condensed at a size tuned to occupy
// about the same tile width as the old GOTHIC_14_BOLD while standing
// taller, for legibility on the higher-res color displays. The resource
// only exists on color platforms (see package.json), so every reference
// to it — including the RESOURCE_ID itself — must stay inside this guard.
static GFont s_ride_name_font;
#endif

static Window      *s_main_window;
static Layer       *s_header_layer;
static Layer       *s_clock_layer;
static ScrollLayer *s_scroll_layer;
static Layer       *s_grid_content_layer;
static AppTimer    *s_refresh_timer;
static GRect        s_scroll_frame; // the scroll layer's frame, in window/root-layer space
#if PBL_API_EXISTS(tap_recognizer_create)
static int16_t      s_pan_base;     // committed scroll offset.y during a drag
static bool         s_pull_armed = false;
static bool         s_pulling_down = false;
static bool         s_touch_locked = false;
#endif
static bool         s_is_refreshing = false;

static Window *s_detail_window;
static Layer  *s_detail_header_layer;
static Layer  *s_detail_graph_layer;
static Layer  *s_detail_alert_layer;
static char    s_detail_header_buf[40];

static AlertConfig s_alerts[MAX_ALERTS];

// Defaults: green/orange/red bands under 10 / 10-30 / 30+ minutes, and a
// violet "alert met" color deliberately different from any band color so
// it never gets mistaken for "this ride just happens to have a short
// wait" — see PBL_COLOR guard below for the B/W fallback, which is fixed
// and not user-configurable since there's no color to configure.
static BandConfig s_band_config = {
  .t1 = 10,
  .t2 = 30,
  .band_color = { (GColor){ .argb = 204 }, (GColor){ .argb = 244 }, (GColor){ .argb = 240 } },
  .alert_color = (GColor){ .argb = 227 },
  .vibe_pattern = 0, // Standard — see VIBE_PATTERNS
};

static RideTile s_rides[MAX_RIDES];
static int      s_order[MAX_RIDES];   // indices into s_rides, current display order
static int      s_ride_count = 0;
static int      s_cursor     = 0;     // position within s_order
// The ride the user last put the cursor on (via UP/DOWN or a tap), or -1 if
// they haven't touched it yet. recompute_order() re-finds this ride after
// every re-sort so the highlight follows the *ride*, not whatever else the
// sort just moved into that grid position — which also means a background
// refresh no longer warps the cursor anywhere.
static int32_t  s_cursor_ride_id = -1;
// Ride count the in-flight refresh's TotalCount announced, or 0 when no
// stream is in flight. The old tiles keep drawing (and s_ride_count keeps
// its old value) while the refreshed list streams in over the top; only
// once the final announced ride has arrived does the count snap to the new
// total — that's what shrinks the list when the new one is shorter (park
// switch, rides deselected). Resetting the count to 0 up front instead
// (the old behavior) flashed "Loading queue times..." and reset the
// cursor/scroll on every silent 5-minute background refresh.
static int      s_pending_total = 0;
static bool     s_phone_connected = false;
static bool     s_show_error      = false;
static SortMode s_sort_mode       = SORT_TIME_ASC;

static char s_header_buf[48];
static char s_clock_buf[8];
static char s_error_buf[48];

static int32_t s_detail_ride_id = -1;
static char    s_detail_name[NAME_BUF_LEN];
static int16_t s_detail_wait = -1;
static int16_t s_graph_points[MAX_GRAPH_POINTS];
static int16_t s_graph_minute_of_day[MAX_GRAPH_POINTS]; // 0-1439, actual clock time
static int     s_graph_count       = 0;
// How many points GraphCount said to expect; 0 = no GraphCount received yet
// this window. s_graph_loading stays true until s_graph_count reaches this,
// so the graph only ever renders once with the complete, final-scaled
// dataset — rendering after each point as it streamed in (the old
// behavior) visibly jumped the y-axis scale around as later, non-closed
// samples raised the max above whatever the early (often zero/closed)
// samples had implied.
static int     s_graph_expected_count = 0;
static bool    s_graph_loading     = true;
static bool    s_graph_show_error  = false;
static char    s_graph_error_buf[48];

// ---------------------------------------------------------------------------
// Layout helpers

// Round displays (chalk/gabbro) are physically circular: tiles at the very
// top/bottom of the viewport would get clipped by the bezel, so round
// platforms use fewer, larger rows inset away from the curve. Since the list
// now scrolls, this only needs to describe one screenful at a time — the
// same margins keep whatever row is currently at the visible edge clear of
// the curve, no matter how far the list has scrolled.
// Gabbro (Round 2, 260x260) is a meaningfully bigger screen than Chalk
// (Time Round, 180x180) — treating both as uniformly "round" via
// PBL_IF_ROUND_ELSE leaves Gabbro with much larger tiles at the same fixed
// row count, and text sizes tuned for Chalk's tiles end up looking
// proportionally tiny. Gabbro gets an extra row instead (3 rows, still 2
// columns), which lands tile_h close to Chalk's rather than just
// stretching it, while keeping the same two-wide layout as every other
// platform.
static int tile_rows(void) {
#if defined(PBL_PLATFORM_GABBRO)
  return 3;
#else
  return PBL_IF_ROUND_ELSE(2, 3);
#endif
}

static int tile_cols(void) { return TILE_COLS; }

// ---------------------------------------------------------------------------
// Sort order

// Defined further down (Per-ride queue alerts) - forward-declared so
// compare_key can use it for SORT_ALERTS below.
static AlertConfig *find_alert(int32_t ride_id);

static int compare_wait_asc(int a, int b) {
  int wa = s_rides[a].wait_minutes < 0 ? 9999 : s_rides[a].wait_minutes;
  int wb = s_rides[b].wait_minutes < 0 ? 9999 : s_rides[b].wait_minutes;
  if (wa != wb) return wa < wb ? -1 : 1;
  return 0;
}

static int compare_wait_desc(int a, int b) {
  int wa = s_rides[a].wait_minutes;
  int wb = s_rides[b].wait_minutes;
  // Closed rides (< 0) always sink to the bottom
  if (wa < 0 && wb >= 0) return 1;
  if (wa >= 0 && wb < 0) return -1;
  if (wa < 0 && wb < 0) return 0;
  if (wa != wb) return wa > wb ? -1 : 1;
  return 0;
}

static int compare_distance(int a, int b) {
  int32_t da = s_rides[a].distance_m < 0 ? INT32_MAX : s_rides[a].distance_m;
  int32_t db = s_rides[b].distance_m < 0 ? INT32_MAX : s_rides[b].distance_m;
  if (da != db) return da < db ? -1 : 1;
  return 0;
}

static bool ride_alert_armed(int idx) {
  AlertConfig *a = find_alert(s_rides[idx].ride_id);
  return a && a->enabled;
}

static int compare_key(int a, int b) {
  if (s_sort_mode == SORT_ALERTS) {
    // Armed-alert rides pinned to the top (sub-sorted by queue length, so
    // the ones worth checking first surface first); everything else below,
    // sub-sorted by distance like SORT_DISTANCE on its own.
    bool aa = ride_alert_armed(a);
    bool ab = ride_alert_armed(b);
    if (aa != ab) return aa ? -1 : 1;
    return aa ? compare_wait_asc(a, b) : compare_distance(a, b);
  }
  if (s_sort_mode == SORT_DISTANCE) return compare_distance(a, b);
  if (s_sort_mode == SORT_TIME_DESC) return compare_wait_desc(a, b);
  return compare_wait_asc(a, b);
}

// Small N (<= MAX_RIDES): a plain insertion sort is simpler than qsort here
// and avoids a comparator needing access to file-static state via a global.
static void recompute_order(void) {
  for (int i = 0; i < s_ride_count; i++) s_order[i] = i;
  for (int i = 1; i < s_ride_count; i++) {
    int key = s_order[i];
    int j = i - 1;
    while (j >= 0 && compare_key(s_order[j], key) > 0) {
      s_order[j + 1] = s_order[j];
      j--;
    }
    s_order[j + 1] = key;
  }
  // The cursor tracks a ride, not a grid position, once the user has
  // actually chosen one (see s_cursor_ride_id) — so a refresh or sort-mode
  // change moves the highlight along with the ride rather than leaving it
  // on whatever the sort shuffled into that slot. A ride that vanished
  // (hidden in settings, park switched) drops back to position-based
  // clamping rather than chasing an id that no longer exists.
  if (s_cursor_ride_id >= 0) {
    int found = -1;
    for (int i = 0; i < s_ride_count; i++) {
      if (s_rides[s_order[i]].ride_id == s_cursor_ride_id) { found = i; break; }
    }
    if (found >= 0) s_cursor = found;
    else s_cursor_ride_id = -1;
  }
  if (s_cursor >= s_ride_count) s_cursor = s_ride_count > 0 ? s_ride_count - 1 : 0;
}

// Call after any *user-driven* cursor move (UP/DOWN, tap) — deliberately not
// from recompute_order itself, so passive re-sorts before the user has
// touched anything don't lock the cursor onto whichever ride happened to be
// under position 0 at the time.
static void remember_cursor_ride(void) {
  if (s_cursor < s_ride_count) {
    s_cursor_ride_id = s_rides[s_order[s_cursor]].ride_id;
  }
}

// ---------------------------------------------------------------------------
// Per-ride queue alerts. Evaluated on every data refresh regardless of which
// window is open, so an alert armed on one ride still fires while browsing
// another — but only as long as this app is the one running: Pebble
// watchapps have no background execution, so nothing fires once you leave
// the app entirely.

static AlertConfig *find_alert(int32_t ride_id) {
  for (int i = 0; i < MAX_ALERTS; i++) {
    if (s_alerts[i].ride_id == ride_id) return &s_alerts[i];
  }
  return NULL;
}

// Creates a disarmed, default-threshold slot the first time a ride's detail
// view is opened, so UP/DOWN can pre-adjust the threshold before SELECT
// arms it. Returns NULL if the table is full (not expected in practice at
// MAX_ALERTS=20 for a personal watchlist).
static AlertConfig *find_or_create_alert(int32_t ride_id) {
  AlertConfig *a = find_alert(ride_id);
  if (a) return a;
  for (int i = 0; i < MAX_ALERTS; i++) {
    if (s_alerts[i].ride_id == 0) {
      s_alerts[i] = (AlertConfig){
        .ride_id = ride_id,
        .threshold_min = ALERT_DEFAULT_MINUTES,
        .enabled = false,
        .was_below = false,
      };
      return &s_alerts[i];
    }
  }
  return NULL;
}

static void save_alerts(void) {
  persist_write_data(SETTINGS_ALERTS_KEY, s_alerts, sizeof(s_alerts));
}

static void load_alerts(void) {
  if (persist_exists(SETTINGS_ALERTS_KEY)) {
    persist_read_data(SETTINGS_ALERTS_KEY, s_alerts, sizeof(s_alerts));
  }
  // Always start a session un-latched: a stale "already notified" carried
  // over from the last session could wrongly suppress a real drop that
  // happened while the app was closed (which we'd have no way to know
  // about anyway), so re-arming fresh on launch is the safer default.
  for (int i = 0; i < MAX_ALERTS; i++) s_alerts[i].was_below = false;
}

static void save_band_config(void) {
  persist_write_data(SETTINGS_BANDS_KEY, &s_band_config, sizeof(s_band_config));
}

// The phone is authoritative for this setting (it's configured on the
// settings page) and resends it on every 'ready', but this caches the last
// value on the watch too, so a relaunch shows the user's colors right away
// instead of flashing the hardcoded defaults until the first sync lands.
static void load_band_config(void) {
  if (persist_exists(SETTINGS_BANDS_KEY)) {
    persist_read_data(SETTINGS_BANDS_KEY, &s_band_config, sizeof(s_band_config));
  }
}

// The cache exists only so the grid shows something real on launch instead of
// an empty screen while the phone is asked for fresh data. So it stores a
// compact variable-length record rather than the raw struct:
//
//   id(4) wait(2) flags(1) nameLen(1) name(nameLen)
//
// Distance is deliberately NOT cached. It's the one field guaranteed to be
// wrong by the time it's read — it's a distance from wherever you were last
// time — and the phone recomputes it from GPS on the very first refresh.
// Caching it would put a confidently stale number on screen; omitting it
// leaves format_distance() to render the -1 "unknown" case for a second or
// two instead. Every other field is preserved in full.
//
// Roughly 4+2+1+1+len bytes a ride, so a typical 40-ride park lands near
// 700-800 bytes, spread over 256-byte chunks.
static void save_cached_rides(void) {
#if !RIDE_CACHE_SUPPORTED
  return;
#else
  if (s_ride_count <= 0) return;

  uint8_t buf[SETTINGS_RIDE_CACHE_MAX_CHUNKS * PERSIST_DATA_MAX_LENGTH];
  uint32_t n = 0;
  int cached = 0;
  for (int i = 0; i < s_ride_count && i < MAX_RIDES; i++) {
    uint8_t name_len = (uint8_t)strlen(s_rides[i].name);
    if (n + 8 + name_len > sizeof(buf)) break;   // full: cache what fits
    uint32_t id = (uint32_t)s_rides[i].ride_id;
    buf[n++] = (uint8_t)(id >> 24); buf[n++] = (uint8_t)(id >> 16);
    buf[n++] = (uint8_t)(id >> 8);  buf[n++] = (uint8_t)id;
    uint16_t w = (uint16_t)s_rides[i].wait_minutes;
    buf[n++] = (uint8_t)(w >> 8);   buf[n++] = (uint8_t)w;
    buf[n++] = s_rides[i].flags;
    buf[n++] = name_len;
    memcpy(&buf[n], s_rides[i].name, name_len);
    n += name_len;
    cached++;
  }

  // Header int packs version and byte count so a partial/older write can be
  // spotted without trusting the chunks themselves.
  persist_write_int(SETTINGS_CACHED_RIDES_COUNT_KEY,
                    (int32_t)((RIDE_CACHE_VERSION << 24) | (cached << 16) | (int)n));

  uint32_t written = 0;
  for (int c = 0; c < SETTINGS_RIDE_CACHE_MAX_CHUNKS && written < n; c++) {
    uint32_t take = n - written;
    if (take > PERSIST_DATA_MAX_LENGTH) take = PERSIST_DATA_MAX_LENGTH;
    // Short write means the cache is unreadable, so record less rather than
    // leaving a header promising bytes that aren't there.
    if (persist_write_data(SETTINGS_RIDE_CACHE_BASE_KEY + c, &buf[written], take) != (int)take) {
      persist_write_int(SETTINGS_CACHED_RIDES_COUNT_KEY, 0);
      return;
    }
    written += take;
  }
#endif
}

static void load_cached_rides(void) {
#if !RIDE_CACHE_SUPPORTED
  return;
#else
  if (!persist_exists(SETTINGS_CACHED_RIDES_COUNT_KEY)) return;

  // Drop the pre-chunking blob if it's still around; it was never readable.
  if (persist_exists(SETTINGS_CACHED_RIDES_DATA_KEY)) {
    persist_delete(SETTINGS_CACHED_RIDES_DATA_KEY);
  }

  int32_t header = persist_read_int(SETTINGS_CACHED_RIDES_COUNT_KEY);
  int version = (header >> 24) & 0xFF;
  int count = (header >> 16) & 0xFF;
  uint32_t n = (uint32_t)(header & 0xFFFF);
  if (version != RIDE_CACHE_VERSION || count <= 0 || count > MAX_RIDES) return;

  uint8_t buf[SETTINGS_RIDE_CACHE_MAX_CHUNKS * PERSIST_DATA_MAX_LENGTH];
  if (n > sizeof(buf)) return;

  uint32_t got = 0;
  for (int c = 0; c < SETTINGS_RIDE_CACHE_MAX_CHUNKS && got < n; c++) {
    if (!persist_exists(SETTINGS_RIDE_CACHE_BASE_KEY + c)) return;
    uint32_t want = n - got;
    if (want > PERSIST_DATA_MAX_LENGTH) want = PERSIST_DATA_MAX_LENGTH;
    if (persist_read_data(SETTINGS_RIDE_CACHE_BASE_KEY + c, &buf[got], want) != (int)want) return;
    got += want;
  }
  if (got != n) return;

  uint32_t o = 0;
  int i = 0;
  for (; i < count && o + 8 <= n; i++) {
    s_rides[i].ride_id = (int32_t)(((uint32_t)buf[o] << 24) | ((uint32_t)buf[o + 1] << 16) |
                                   ((uint32_t)buf[o + 2] << 8) | (uint32_t)buf[o + 3]);
    o += 4;
    s_rides[i].wait_minutes = (int16_t)(((uint16_t)buf[o] << 8) | (uint16_t)buf[o + 1]);
    o += 2;
    s_rides[i].flags = buf[o++];
    uint8_t name_len = buf[o++];
    if (o + name_len > n) break;
    uint8_t copy = name_len < (NAME_BUF_LEN - 1) ? name_len : (NAME_BUF_LEN - 1);
    memcpy(s_rides[i].name, &buf[o], copy);
    s_rides[i].name[copy] = '\0';
    o += name_len;
    s_rides[i].distance_m = -1;  // not cached; the next refresh fills it in
  }

  s_ride_count = i;
  if (s_ride_count > 0) recompute_order();
#endif
}

// Pebble apps can't invoke the watch's own system alert-vibe picker (that's
// a user-facing OS setting, not an exposed API), so these are app-side
// VibePattern durations. Three of them reproduce a real PebbleOS vibe score
// exactly; the fourth is deliberately our own and named so it doesn't claim
// otherwise.
//
// Timings taken from PebbleOS itself (resources/normal/snowy/vibes/*.json at
// tag v4.36.2), not guessed. Each score is a list of notes with a duration,
// a strength (0-100) and a motor brake time; a 0-strength note is silence.
// A score whose notes are all 100% maps exactly onto VibePattern's
// alternating on/off durations, which is why only those three are here:
//   Standard (Short Pulse) - High : 250ms @100%
//   Nudge Nudge                   : 30ms @100%, 100ms silence, 30ms @100%
//   Jackhammer                    : 6 x (50ms @100% + 50ms brake)
// PebbleOS's Mario, Reveille, Pulse and Gentle all vary strength mid-score
// (Mario alone uses 40/55/76/100%), so VibePattern cannot express them —
// this app previously shipped a "Mario" and a "Heartbeat" that matched
// nothing in the OS (there is no Heartbeat score at all), and those are gone
// rather than pretending.
//
// That "cannot" is an SDK gap, not a hardware one, and is worth revisiting:
// PebbleOS gained vibes_enqueue_custom_pattern_with_amplitudes() in commit
// 03a8ac0c ("add per-segment amplitude control to public SDK", 2026-02-16),
// which takes a per-segment amplitude array and is present in firmware from
// v4.33.1 onward. It just isn't in the published SDK yet — SDK 4.33.1 (the
// newest on sdk.repebble.com as of writing) declares no such prototype and
// its libpebble.a exports no such symbol on any platform, so it can't be
// linked. When an SDK ships it, the strength-varying scores above become
// reproducible verbatim.
//
// Index here is what travels over AppMessage (VibePattern key) and gets
// persisted in BandConfig.vibe_pattern. Index 0 keeps the exact durations
// the old index 0 had, so an existing saved default still vibrates
// identically; 1-3 changed meaning, but those were the inaccurate ones.
// Append, don't reorder, from here on.
typedef struct {
  const uint32_t *durations;
  uint32_t num_segments;
} VibePatternPreset;

// Ours, not an OS score: three firm buzzes, for an alert worth not missing
// in a noisy park. Kept at index 0 both on its merits and so the stored
// default's behavior is unchanged by this correction.
static const uint32_t s_vibe_triple[]     = {400, 200, 400, 200, 400};
// PebbleOS "Standard (Short Pulse) - High" — its default for notifications.
static const uint32_t s_vibe_standard[]   = {250};
// PebbleOS "Nudge Nudge".
static const uint32_t s_vibe_nudge[]      = {30, 100, 30};
// PebbleOS "Jackhammer": 6 on-pulses, hence 11 alternating segments.
static const uint32_t s_vibe_jackhammer[] = {50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50};

static const VibePatternPreset VIBE_PATTERNS[] = {
  { s_vibe_triple,     ARRAY_LENGTH(s_vibe_triple) },     // 0: Triple Buzz (ours)
  { s_vibe_standard,   ARRAY_LENGTH(s_vibe_standard) },   // 1: Standard
  { s_vibe_nudge,      ARRAY_LENGTH(s_vibe_nudge) },      // 2: Nudge Nudge
  { s_vibe_jackhammer, ARRAY_LENGTH(s_vibe_jackhammer) }, // 3: Jackhammer
};
#define VIBE_PATTERN_COUNT ((int)(sizeof(VIBE_PATTERNS) / sizeof(VIBE_PATTERNS[0])))

static void trigger_alert_vibration(void) {
  int idx = s_band_config.vibe_pattern;
  if (idx < 0 || idx >= VIBE_PATTERN_COUNT) idx = 0;
  VibePattern pattern = {
    .durations = VIBE_PATTERNS[idx].durations,
    .num_segments = VIBE_PATTERNS[idx].num_segments
  };
  vibes_enqueue_custom_pattern(pattern);
  light_enable_interaction();
}

// Edge-triggered: only buzzes on the transition into "at or below
// threshold", not on every refresh while it stays there. The tile's own
// color while the condition holds is level-based, not edge-triggered —
// see wait_colors()'s caller in grid_update_proc.
static void check_alert_for_ride(int32_t ride_id, int16_t wait_minutes) {
  AlertConfig *a = find_alert(ride_id);
  if (!a || !a->enabled) return;
  bool now_below = (wait_minutes >= 0 && wait_minutes <= a->threshold_min);
  if (now_below && !a->was_below) {
    trigger_alert_vibration();
  }
  a->was_below = now_below;
}

// ---------------------------------------------------------------------------
// AppMessage senders

static void request_refresh(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    int req = 1;
    dict_write_int(out, MESSAGE_KEY_RequestRefresh, &req, sizeof(int), true);
    app_message_outbox_send();
  }
}

static void request_graph(int32_t ride_id) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    dict_write_int(out, MESSAGE_KEY_RequestGraph, &ride_id, sizeof(int32_t), true);
    app_message_outbox_send();
  }
}

static void refresh_timer_callback(void *data) {
  request_refresh();
  // Back off to a slower cadence on low, unplugged battery rather than
  // hitting Bluetooth/AppMessage on the usual 5-minute tick regardless.
  BatteryChargeState battery = battery_state_service_peek();
  uint32_t interval = REFRESH_INTERVAL_MS;
  if (!battery.is_charging) {
    if (battery.charge_percent <= 10) {
      interval = REFRESH_INTERVAL_MS * 4; // 20 mins on critical battery
    } else if (battery.charge_percent <= 20) {
      interval = REFRESH_INTERVAL_MS * 3; // 15 mins on low battery
    } else if (battery.charge_percent <= 30) {
      interval = (REFRESH_INTERVAL_MS * 3) / 2; // 7.5 mins on moderate battery
    }
  }
  s_refresh_timer = app_timer_register(interval, refresh_timer_callback, NULL);
}

// ---------------------------------------------------------------------------
// Main window: scrollable tile grid

static void update_header(void);

// On rect platforms the clock has its own left-aligned layer, updated
// directly here. Round platforms don't get a separate clock layer (the
// header band is only 18px tall right at the top of the bezel curve —
// already tight for one centered label, let alone a second positioned
// element) — there, the clock is folded into update_header()'s single
// string instead, so this just re-runs that.
static void update_clock(void) {
  if (s_clock_layer) {
    time_t now = time(NULL);
    struct tm *tick_time = localtime(&now);
    strftime(s_clock_buf, sizeof(s_clock_buf),
             clock_is_24h_style() ? "%H:%M" : "%I:%M", tick_time);
    layer_mark_dirty(s_clock_layer);
  } else {
    update_header();
  }
}

static void clock_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  // Background fill spans the layer's full width (flush against the
  // screen's left edge, like the rest of the header bar); the text itself
  // draws within a rect inset from that same edge - see header_update_proc
  // for why these need to be sized independently. TILE_PAD (not
  // TEXT_EDGE_PADDING) so the clock's left edge lines up with the tile
  // grid's own leftmost edge directly below it.
  GRect text_bounds = GRect(bounds.origin.x + TILE_PAD, bounds.origin.y,
                             bounds.size.w - TILE_PAD, bounds.size.h);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GSize content = graphics_text_layout_get_content_size(s_clock_buf, font, text_bounds,
                                                         GTextOverflowModeFill, GTextAlignmentLeft);
  int y = text_bounds.origin.y + (text_bounds.size.h - content.h) / 2;
  GRect draw_rect = GRect(text_bounds.origin.x, y, text_bounds.size.w, content.h);
  graphics_draw_text(ctx, s_clock_buf, font, draw_rect, GTextOverflowModeFill, GTextAlignmentLeft, NULL);
}

static void clock_tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_clock();
}

static void update_header(void) {
  char status[32];
#if PBL_API_EXISTS(tap_recognizer_create)
  if (s_pull_armed) {
    snprintf(status, sizeof(status), "Release to refresh");
  } else if (s_pulling_down) {
    snprintf(status, sizeof(status), "Pull to refresh");
  } else
#endif
  if (s_is_refreshing) {
    snprintf(status, sizeof(status), "Refreshing...");
  } else if (!s_phone_connected) {
    snprintf(status, sizeof(status), "No phone");
  } else if (s_ride_count == 0) {
    status[0] = '\0';
  } else {
    const char *sort_name = (s_sort_mode == SORT_TIME_ASC || s_sort_mode == SORT_TIME_DESC) ? "Time" :
                            (s_sort_mode == SORT_DISTANCE) ? "Distance" : "Alerts";
#if PBL_API_EXISTS(tap_recognizer_create)
    if (s_touch_locked) {
#if defined(PBL_ROUND)
      snprintf(status, sizeof(status), "[LOCK] %s", sort_name);
#else
      snprintf(status, sizeof(status), "%s", sort_name);
#endif
    } else {
      snprintf(status, sizeof(status), "Sort: %s", sort_name);
    }
#else
    snprintf(status, sizeof(status), "Sort: %s", sort_name);
#endif
  }

  if (s_clock_layer) {
    snprintf(s_header_buf, sizeof(s_header_buf), "%s", status);
  } else {
    char clock_buf[8];
    time_t now = time(NULL);
    struct tm *tick_time = localtime(&now);
    strftime(clock_buf, sizeof(clock_buf),
             clock_is_24h_style() ? "%H:%M" : "%I:%M", tick_time);
    if (status[0]) {
      snprintf(s_header_buf, sizeof(s_header_buf), "%s  %s", clock_buf, status);
    } else {
      snprintf(s_header_buf, sizeof(s_header_buf), "%s", clock_buf);
    }
  }
  if (s_header_layer) layer_mark_dirty(s_header_layer);
}

static void draw_sort_arrow(GContext *ctx, int center_x, int center_y, bool up, GColor color) {
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_fill_color(ctx, color);
  if (up) {
    // 5px wide, 3px high upward triangle
    graphics_draw_line(ctx, GPoint(center_x, center_y - 1),
                            GPoint(center_x, center_y - 1));
    graphics_draw_line(ctx, GPoint(center_x - 1, center_y),
                            GPoint(center_x + 1, center_y));
    graphics_draw_line(ctx, GPoint(center_x - 2, center_y + 1),
                            GPoint(center_x + 2, center_y + 1));
  } else {
    // 5px wide, 3px high downward triangle
    graphics_draw_line(ctx, GPoint(center_x - 2, center_y),
                            GPoint(center_x + 2, center_y));
    graphics_draw_line(ctx, GPoint(center_x - 1, center_y + 1),
                            GPoint(center_x + 1, center_y + 1));
    graphics_draw_line(ctx, GPoint(center_x, center_y + 2),
                            GPoint(center_x, center_y + 2));
  }
}

static void header_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GTextAlignment align;
  GRect text_bounds;
#if defined(PBL_ROUND)
  // One combined centered string (see update_header) - no background fill
  // needed, this sits directly on the round header's own background.
  align = GTextAlignmentCenter;
  text_bounds = bounds;
  graphics_context_set_text_color(ctx, GColorBlack);
#else
  // Right-aligned against the clock on the left (see the alignment comment
  // in main_window_load) - solid black bar spans the layer's full width,
  // but the text itself is drawn within a rect inset from the right edge
  // by TILE_PAD (not TEXT_EDGE_PADDING), so its right edge lines up with
  // the tile grid's own rightmost edge directly below it.
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);

  int right_inset = TILE_PAD;
  if (s_sort_mode == SORT_TIME_ASC || s_sort_mode == SORT_TIME_DESC) {
    right_inset += 9;
  }

#if PBL_API_EXISTS(tap_recognizer_create)
  if (s_touch_locked) {
    // 1. Draw centered [LOCK] across the full screen width
    int screen_w = bounds.size.w + HEADER_CLOCK_WIDTH;
    int center_x = (screen_w / 2) - HEADER_CLOCK_WIDTH;
    GSize lock_size = graphics_text_layout_get_content_size("[LOCK]", font, bounds,
                                                            GTextOverflowModeFill, GTextAlignmentLeft);
    int lock_x = center_x - (lock_size.w / 2);
    int lock_y = (bounds.size.h - lock_size.h) / 2;
    graphics_draw_text(ctx, "[LOCK]", font, GRect(lock_x, lock_y, lock_size.w, lock_size.h),
                       GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    // 2. Draw right-aligned sort mode
    align = GTextAlignmentRight;
    text_bounds = GRect(bounds.origin.x, bounds.origin.y, bounds.size.w - right_inset, bounds.size.h);
    GSize content = graphics_text_layout_get_content_size(s_header_buf, font, text_bounds,
                                                           GTextOverflowModeFill, align);
    int y = (bounds.size.h - content.h) / 2;
    graphics_draw_text(ctx, s_header_buf, font, GRect(text_bounds.origin.x, y, text_bounds.size.w, content.h),
                       GTextOverflowModeFill, align, NULL);
    if (s_sort_mode == SORT_TIME_ASC || s_sort_mode == SORT_TIME_DESC) {
      int ax = bounds.size.w - TILE_PAD - 2;
      int ay = 12;
      draw_sort_arrow(ctx, ax, ay, s_sort_mode == SORT_TIME_ASC, GColorWhite);
    }
    return;
  }
#endif

  align = GTextAlignmentRight;
  text_bounds = GRect(bounds.origin.x, bounds.origin.y, bounds.size.w - right_inset, bounds.size.h);
#endif
  GSize content = graphics_text_layout_get_content_size(s_header_buf, font, text_bounds,
                                                         GTextOverflowModeFill, align);
  int y = text_bounds.origin.y + (text_bounds.size.h - content.h) / 2;
  GRect draw_rect = GRect(text_bounds.origin.x, y, text_bounds.size.w, content.h);
  graphics_draw_text(ctx, s_header_buf, font, draw_rect, GTextOverflowModeFill, align, NULL);
  if (s_sort_mode == SORT_TIME_ASC || s_sort_mode == SORT_TIME_DESC) {
#if defined(PBL_ROUND)
    int ax = (bounds.size.w + content.w) / 2 + 4;
    int ay = 12;
    draw_sort_arrow(ctx, ax, ay, s_sort_mode == SORT_TIME_ASC, GColorBlack);
#else
    int ax = bounds.size.w - TILE_PAD - 2;
    int ay = 12;
    draw_sort_arrow(ctx, ax, ay, s_sort_mode == SORT_TIME_ASC, GColorWhite);
#endif
  }
}

// Picks black or white text for a given fill so any user-chosen color (not
// just a fixed hardcoded set) stays legible. GColor8's r/g/b channels are
// each 0-3; weighting green highest matches perceived luminance well enough
// for this purpose without needing float math.
static GColor contrasting_text_color(GColor bg) {
  int luminance = bg.r + bg.g * 2 + bg.b;
  return (luminance >= 5) ? GColorBlack : GColorWhite;
}

// Assigns tile fill/text colors by wait-time bucket, using the user's
// configured 3-band thresholds/colors. B/W platforms fall back to a fixed
// black/white split since there is no color channel to configure.
static void wait_colors(int16_t wait, GColor *fill, GColor *text) {
#if defined(PBL_COLOR)
  if (wait < 0) { *fill = GColorDarkGray; *text = GColorWhite; return; }
  GColor c;
  if (wait < s_band_config.t1)      c = s_band_config.band_color[0];
  else if (wait < s_band_config.t2) c = s_band_config.band_color[1];
  else                               c = s_band_config.band_color[2];
  *fill = c;
  *text = contrasting_text_color(c);
#else
  if (wait < 0) { *fill = GColorBlack; *text = GColorWhite; }
  else          { *fill = GColorWhite; *text = GColorBlack; }
#endif
}

// Metro-tile treatment for the alert band: off/armed-waiting/condition-met
// each get a distinct background. "Met" uses the same user-configured
// alert color as the grid tile override, for one consistent signal
// wherever it appears. B/W platforms only distinguish the actionable "met"
// state (inverted, matching the "closed ride" convention) since there's no
// color channel to do a three-way split with.
static void alert_band_colors(const AlertConfig *a, int16_t current_wait, GColor *fill, GColor *text) {
  bool met = a && a->enabled && current_wait >= 0 && current_wait <= a->threshold_min;
#if defined(PBL_COLOR)
  if (!a || !a->enabled) { *fill = GColorLightGray; *text = GColorBlack; }
  else if (met)          { *fill = s_band_config.alert_color; *text = contrasting_text_color(s_band_config.alert_color); }
  else                   { *fill = GColorVividCerulean; *text = GColorBlack; }
#else
  if (met) { *fill = GColorBlack; *text = GColorWhite; }
  else     { *fill = GColorWhite; *text = GColorBlack; }
#endif
}

static void format_distance(int32_t meters, char *buf, size_t buf_len) {
  if (meters < 0) {
    snprintf(buf, buf_len, "--");
  } else if (meters < 1000) {
    snprintf(buf, buf_len, "%dm", (int)meters);
  } else {
    // Avoid float printf (not linked into Pebble's minimal libc by default).
    int whole = (int)(meters / 1000);
    int tenth = (int)((meters % 1000) / 100);
    snprintf(buf, buf_len, "%d.%dkm", whole, tenth);
  }
}

// minute_of_day is 0-1439. Respects the watch's 12h/24h display setting,
// same as a normal clock face would.
static void format_minute_of_day(int minute_of_day, char *buf, size_t buf_len) {
  if (minute_of_day < 0) minute_of_day = 0;
  int hour = (minute_of_day / 60) % 24;
  int minute = minute_of_day % 60;
  if (clock_is_24h_style()) {
    snprintf(buf, buf_len, "%02d:%02d", hour, minute);
  } else {
    int display_hour = hour % 12;
    if (display_hour == 0) display_hour = 12;
    snprintf(buf, buf_len, "%d:%02d%s", display_hour, minute, hour < 12 ? "a" : "p");
  }
}

// Shared geometry so touch hit-testing and scroll-to-follow always agree
// with what got drawn. Tile size is derived from the fixed viewport size (so
// tiles look the same size as before), but row count spans the whole ride
// list, not just one screenful — that's what makes it scroll. All tile rects
// are in the content layer's own local space, which always starts at (0,0)
// regardless of where the scroll layer itself sits on screen.
typedef struct {
  int w, h; // viewport size (s_scroll_frame's size)
  int pad;
  int cols;
  int tile_w;
  int tile_h;
  int total_rows;
  int content_h;
} GridMetrics;

// queue-times.com's terms require this attribution "somewhere prominent" —
// a full-width footer tile at the end of the ride list. Height is however
// tall "Powered by Queue-Times.com" actually needs to be at this
// platform's width - one line on wider screens (emery/gabbro), wrapped to
// two on narrower ones (basalt/chalk). Measured directly rather than a
// single fixed guess, which was either wastefully tall on the wide
// platforms or clipped the wrapped second line on the narrow ones.
static int attribution_height(int width) {
  GSize content = graphics_text_layout_get_content_size(
      "Powered by Queue-Times.com", fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GRect(0, 0, width, 9999), GTextOverflowModeWordWrap, GTextAlignmentCenter);
  return content.h + 8; // a little breathing room above/below the text
}

static GridMetrics compute_grid_metrics(void) {
  GridMetrics m;
  m.w = s_scroll_frame.size.w;
  m.h = s_scroll_frame.size.h;
  m.pad = TILE_PAD;
  m.cols = tile_cols();
  int screen_rows = tile_rows();
  m.tile_w = (m.w - m.pad * (m.cols + 1)) / m.cols;
  m.tile_h = (m.h - m.pad * (screen_rows + 1)) / screen_rows;

  m.total_rows = (s_ride_count + m.cols - 1) / m.cols;
  if (m.total_rows < 1) m.total_rows = 1;
  m.content_h = m.pad + m.total_rows * (m.tile_h + m.pad) + attribution_height(m.w - 2 * m.pad) + m.pad;
  if (m.content_h < m.h) m.content_h = m.h;
  return m;
}

// slot is the tile's position in the full (scrollable) list, 0 = first.
static GRect tile_rect_for_slot(const GridMetrics *m, int slot) {
  int col = slot % m->cols;
  int row = slot / m->cols;
  return GRect(m->pad + col * (m->tile_w + m->pad),
               m->pad + row * (m->tile_h + m->pad),
               m->tile_w, m->tile_h);
}

// Footer below the last ride row, inset by m->pad on each side to match the
// tile grid's own left/right edges - same margin, same reasoning as
// TILE_PAD (see its definition).
static GRect attribution_rect(const GridMetrics *m) {
  int y = m->pad + m->total_rows * (m->tile_h + m->pad);
  int w = m->w - 2 * m->pad;
  return GRect(m->pad, y, w, attribution_height(w));
}

static void scroll_to_show_cursor(bool animated) {
  GridMetrics m = compute_grid_metrics();
  GRect tile = tile_rect_for_slot(&m, s_cursor);
  GPoint offset = scroll_layer_get_content_offset(s_scroll_layer);
  int visible_top = -offset.y;
  int visible_bottom = visible_top + m.h;
  int new_top = visible_top;

  if (s_cursor == s_ride_count - 1) {
    // Last ride: scroll all the way down so the attribution footer beneath
    // it is reachable by button navigation too, not just a touch drag.
    new_top = m.content_h - m.h;
  } else if (tile.origin.y < visible_top) {
    new_top = tile.origin.y - m.pad;
  } else if (tile.origin.y + tile.size.h > visible_bottom) {
    new_top = tile.origin.y + tile.size.h + m.pad - m.h;
  }
  if (new_top < 0) new_top = 0;

  if (new_top != visible_top) {
    scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, -new_top), animated);
  }
}

// Resizes the content layer / scroll bounds for the current ride count.
// Called whenever the ride count changes; does not move the scroll position
// itself so a background refresh never yanks the view out from under you.
static void update_grid_layout(void) {
  GridMetrics m = compute_grid_metrics();
  layer_set_frame(s_grid_content_layer, GRect(0, 0, m.w, m.content_h));
  scroll_layer_set_content_size(s_scroll_layer, GSize(m.w, m.content_h));
}

// window_point is in the main window's root-layer coordinate space (what a
// tap recognizer reports); the scroll layer's frame (s_scroll_frame) sits
// somewhere below the header, possibly inset further on round platforms, and
// its content is shifted by the current scroll offset. Only used by the
// touch tap handler below, hence the same feature guard.
#if PBL_API_EXISTS(tap_recognizer_create)
static bool hit_test_tile(GPoint window_point, int *out_order_pos) {
  if (s_ride_count == 0) return false;
  GPoint offset = scroll_layer_get_content_offset(s_scroll_layer);
  GPoint p = GPoint(window_point.x - s_scroll_frame.origin.x,
                     window_point.y - s_scroll_frame.origin.y - offset.y);
  GridMetrics m = compute_grid_metrics();
  for (int order_pos = 0; order_pos < s_ride_count; order_pos++) {
    GRect r = tile_rect_for_slot(&m, order_pos);
    if (p.x >= r.origin.x && p.x < r.origin.x + r.size.w &&
        p.y >= r.origin.y && p.y < r.origin.y + r.size.h) {
      *out_order_pos = order_pos;
      return true;
    }
  }
  return false;
}
#endif // PBL_API_EXISTS(tap_recognizer_create)

// A minimal bell glyph (body + lip + clapper) drawn from primitives, since
// this app has no image/PDC resources set up. top is the icon's top-left
// corner; it occupies roughly a 9x11px area.
static void draw_bell_icon(GContext *ctx, GPoint top, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  graphics_fill_circle(ctx, GPoint(top.x + 4, top.y + 4), 4);
  graphics_fill_rect(ctx, GRect(top.x, top.y + 7, 9, 2), 0, GCornerNone);
  graphics_fill_circle(ctx, GPoint(top.x + 4, top.y + 10), 1);
}

// A tick, drawn from two thick strokes for the same reason the bell is drawn
// from primitives — no image/PDC resources in this app. `top` is the glyph's
// top-left; it occupies roughly a 9x9px area, matching the bell so the two
// sit level in opposite corners of a tile.
//
// Stroke width is set explicitly and restored: the tile loop leaves it at 1
// but also uses 3 for the selected tile's border, and inheriting whatever the
// previous tile happened to set makes the tick randomly fat.
static void draw_tick_icon(GContext *ctx, GPoint top, GColor color) {
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_line(ctx, GPoint(top.x + 1, top.y + 5), GPoint(top.x + 3, top.y + 8));
  graphics_draw_line(ctx, GPoint(top.x + 3, top.y + 8), GPoint(top.x + 8, top.y + 1));
  graphics_context_set_stroke_width(ctx, 1);
}

// graphics_draw_text always top-anchors within the given rect. That's fine
// when the rect is already sized tightly to its content, but wherever a
// rect is deliberately taller than one line so a short string still has
// room to wrap onto a second line (grid tile names, graph status messages),
// a short one just ends up stranded near the top with a dead gap below it —
// worse the larger the rect, which is exactly what happens on the bigger
// color platforms (emery/gabbro). Centers vertically instead, by measuring
// the text's own rendered height first and offsetting the draw rect to
// match; still wraps/truncates exactly as the given overflow mode says.
//
// graphics_text_layout_get_content_size()'s returned height is the font's
// own baked-in line metric (ascent + descent + whatever headroom it
// reserves for glyphs this specific string doesn't use, e.g. accented
// capitals or descenders like g/y/p) — not a tight bounding box of the
// actual rendered ink. Centering that box is only visually accurate for
// text that fills close to the font's full vertical range; short strings
// or symbol glyphs that don't reach the top/bottom of it end up with their
// visible ink off-center within a box that's itself correctly centered.
// Pebble's public API has no way to query ascent/descent separately to
// correct for this analytically, so `y_nudge` exists as an escape hatch —
// pass 0 normally; a non-zero value should come from measuring the actual
// rendered pixels for that specific font/string (e.g. via a screenshot),
// not a guess, since the needed correction is a property of that specific
// font's own metrics and doesn't transfer to a different font/size.
static void draw_vcentered_text_nudged(GContext *ctx, const char *msg, GFont font, GRect bounds,
                                        GTextOverflowMode overflow_mode, int y_nudge) {
  GSize content = graphics_text_layout_get_content_size(msg, font, bounds, overflow_mode, GTextAlignmentCenter);
  int y = bounds.origin.y + (bounds.size.h - content.h) / 2 + y_nudge;
  if (y < bounds.origin.y) y = bounds.origin.y;
  GRect text_rect = GRect(bounds.origin.x, y, bounds.size.w, content.h);
  graphics_draw_text(ctx, msg, font, text_rect, overflow_mode, GTextAlignmentCenter, NULL);
}

static void draw_vcentered_text(GContext *ctx, const char *msg, GFont font, GRect bounds,
                                 GTextOverflowMode overflow_mode) {
  draw_vcentered_text_nudged(ctx, msg, font, bounds, overflow_mode, 0);
}

static void grid_update_proc(Layer *layer, GContext *ctx) {
  GridMetrics m = compute_grid_metrics();

  if (s_show_error || s_ride_count == 0) {
    const char *msg = s_show_error ? s_error_buf : "Loading queue times...";
    graphics_context_set_text_color(ctx, GColorBlack);
    draw_vcentered_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(0, 0, m.w, m.h),
                         GTextOverflowModeWordWrap);
    return;
  }

  int tile_h = m.tile_h;
  bool show_distance = (tile_h >= 55);
  // s_ride_name_font (custom Roboto Condensed, loaded in init()) is taller
  // than the old GOTHIC_14_BOLD at about the same tile width, for
  // legibility on the higher-res color displays (newer hardware). Kept as
  // Gothic Bold on B/W watches, where that resource doesn't even exist.
  GFont name_font = PBL_IF_COLOR_ELSE(s_ride_name_font, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  GFont dist_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  GFont wait_font;
  int wait_h;
  int dist_h = show_distance ? 14 : 0;
  if (tile_h >= 90)      { wait_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD); wait_h = 30; }
  else if (tile_h >= 55) { wait_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD); wait_h = 22; }
  else                   { wait_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD); wait_h = 20; }

  for (int order_pos = 0; order_pos < s_ride_count; order_pos++) {
    int idx = s_order[order_pos];
    GRect tile = tile_rect_for_slot(&m, order_pos);

    RideTile *r = &s_rides[idx];
    AlertConfig *ride_alert = find_alert(r->ride_id);
    bool alert_met = ride_alert && ride_alert->enabled &&
                      r->wait_minutes >= 0 && r->wait_minutes <= ride_alert->threshold_min;

    GColor fill, text_color;
    if (alert_met) {
      // Same user-configured "condition met" color as the detail view's
      // alert band — a steady color, not a timed blink, so it costs
      // nothing extra to keep showing for as long as the ride stays under
      // threshold.
      fill = PBL_IF_COLOR_ELSE(s_band_config.alert_color, GColorBlack);
      text_color = PBL_IF_COLOR_ELSE(contrasting_text_color(fill), GColorWhite);
    } else {
      wait_colors(r->wait_minutes, &fill, &text_color);
    }

    graphics_context_set_fill_color(ctx, fill);
    graphics_fill_rect(ctx, tile, 5, GCornersAll);

    bool selected = (order_pos == s_cursor);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_context_set_stroke_width(ctx, selected ? 3 : 1);
    graphics_draw_round_rect(ctx, tile, 5);
    graphics_context_set_stroke_width(ctx, 1);

    if (ride_alert && ride_alert->enabled) {
      draw_bell_icon(ctx, GPoint(tile.origin.x + tile.size.w - 12, tile.origin.y + 2), text_color);
    }
    if (r->flags & RIDE_FLAG_LOGGED_TODAY) {
      draw_tick_icon(ctx, GPoint(tile.origin.x + 3, tile.origin.y + 2), text_color);
    }

    graphics_context_set_text_color(ctx, text_color);
    GRect name_rect = GRect(tile.origin.x + 2, tile.origin.y + 1,
                             tile.size.w - 4, tile.size.h - wait_h - dist_h - 2);
    // name_rect is deliberately taller than one line (room to wrap a long
    // name), which left a short one sitting at its top with a dead gap
    // above the wait number below it - more noticeable the bigger the tile,
    // i.e. worst on exactly the platforms (emery/gabbro) this is aimed at.
    draw_vcentered_text(ctx, r->name, name_font, name_rect, GTextOverflowModeTrailingEllipsis);

    char wait_buf[8];
    if (r->wait_minutes < 0) {
      snprintf(wait_buf, sizeof(wait_buf), "Closed");
    } else {
      snprintf(wait_buf, sizeof(wait_buf), "%dm", r->wait_minutes);
    }
    GRect wait_rect = GRect(tile.origin.x, tile.origin.y + tile.size.h - wait_h - dist_h,
                             tile.size.w, wait_h);
    graphics_draw_text(ctx, wait_buf, wait_font, wait_rect,
                        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    if (show_distance) {
      char dist_buf[12];
      format_distance(r->distance_m, dist_buf, sizeof(dist_buf));
      GRect dist_rect = GRect(tile.origin.x, tile.origin.y + tile.size.h - dist_h - TEXT_EDGE_PADDING,
                               tile.size.w, dist_h);
      graphics_draw_text(ctx, dist_buf, dist_font, dist_rect,
                          GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    }
  }

  GRect attr = attribution_rect(&m);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  graphics_fill_rect(ctx, attr, 4, GCornersAll);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_round_rect(ctx, attr, 4);
  graphics_context_set_text_color(ctx, GColorBlack);
  draw_vcentered_text(ctx, "Powered by Queue-Times.com", fonts_get_system_font(FONT_KEY_GOTHIC_14), attr,
                       GTextOverflowModeWordWrap);
}

static void open_detail_window(void);

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_cursor > 0) {
    s_cursor--;
    remember_cursor_ride();
    update_header();
    scroll_to_show_cursor(true);
    layer_mark_dirty(s_grid_content_layer);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_cursor < s_ride_count - 1) {
    s_cursor++;
    remember_cursor_ride();
    update_header();
    scroll_to_show_cursor(true);
    layer_mark_dirty(s_grid_content_layer);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  open_detail_window();
}

static void cycle_sort_mode(void) {
  if (s_sort_mode == SORT_TIME_ASC) s_sort_mode = SORT_TIME_DESC;
  else if (s_sort_mode == SORT_TIME_DESC) s_sort_mode = SORT_DISTANCE;
  else if (s_sort_mode == SORT_DISTANCE) s_sort_mode = SORT_ALERTS;
  else s_sort_mode = SORT_TIME_ASC;
  persist_write_int(SETTINGS_SORT_KEY, s_sort_mode);
  recompute_order();
  update_header();
  layer_mark_dirty(s_grid_content_layer);
  vibes_short_pulse();
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  cycle_sort_mode();
}

#if PBL_API_EXISTS(tap_recognizer_create)
static void reset_pull_position(bool animated);

static void select_double_click_handler(ClickRecognizerRef recognizer, void *context) {
  s_touch_locked = !s_touch_locked;
#if PBL_API_EXISTS(app_touch_navigation_enable)
  app_touch_navigation_enable(!s_touch_locked);
#endif
  if (s_touch_locked) {
    vibes_double_pulse();
    reset_pull_position(false);
  } else {
    vibes_short_pulse();
  }
  update_header();
  persist_write_bool(SETTINGS_TOUCH_LOCK_KEY, s_touch_locked);
}
#endif

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_long_click_handler, NULL);
#if PBL_API_EXISTS(tap_recognizer_create)
  window_multi_click_subscribe(BUTTON_ID_SELECT, 2, 0, 0, true, select_double_click_handler);
#endif
}

// --- Touch (Pebble Time 2 / Round 2 only) ----------------------------------
// The whole recognizer API is macro-stubbed to a bare `(0)` on platforms
// without a touchscreen (see pebble.h), which won't even compile against a
// GPoint-typed assignment — so this entire block is compiled out there
// rather than merely being a runtime no-op. PBL_API_EXISTS is the SDK's
// documented way to detect that at compile time.
#if PBL_API_EXISTS(tap_recognizer_create)

static bool always_simultaneous(const Recognizer *recognizer, const Recognizer *simultaneous_with) {
  return true;
}

static void main_tap_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  if (event != RecognizerEvent_Completed) return;
  GPoint p = tap_recognizer_get_tap_point(recognizer);

  // Tapping the top header bar cycles sort mode
  if (p.y < s_scroll_frame.origin.y) {
    cycle_sort_mode();
    update_grid_layout();
    return;
  }

  int order_pos;
  if (hit_test_tile(p, &order_pos)) {
    vibes_short_pulse();
    s_cursor = order_pos;
    remember_cursor_ride();
    update_header();
    layer_mark_dirty(s_grid_content_layer);
    open_detail_window();
  }
}

#define PULL_TO_REFRESH_THRESHOLD 44

static PropertyAnimation *s_bounce_anim = NULL;
static Layer             *s_pull_indicator_layer = NULL;

static void pull_indicator_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  int pull_y = layer_get_frame(s_grid_content_layer).origin.y;
  if (pull_y < 8) return;

  GPoint center = GPoint(bounds.size.w / 2, pull_y / 2);
  int pull_degrees = (pull_y * 330) / PULL_TO_REFRESH_THRESHOLD;
  if (pull_degrees > 330) pull_degrees = 330;
  if (pull_degrees < 20) pull_degrees = 20;

  GColor stroke_color = s_pull_armed ?
      PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack) :
      PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack);

  graphics_context_set_stroke_color(ctx, stroke_color);
  graphics_context_set_fill_color(ctx, stroke_color);
  graphics_context_set_stroke_width(ctx, 2);

  GRect arc_rect = GRect(center.x - 8, center.y - 8, 16, 16);
  int32_t end_trig = DEG_TO_TRIGANGLE(pull_degrees);
  graphics_draw_arc(ctx, arc_rect, GOvalScaleModeFitCircle, DEG_TO_TRIGANGLE(0), end_trig);

  // Draw arrow head marker at the advancing tip of the circle
  int tip_x = center.x + (sin_lookup(end_trig) * 8) / TRIG_MAX_RATIO;
  int tip_y = center.y - (cos_lookup(end_trig) * 8) / TRIG_MAX_RATIO;
  graphics_fill_circle(ctx, GPoint(tip_x, tip_y), 2);
}

static void reset_pull_position(bool animated) {
  GridMetrics m = compute_grid_metrics();
  GRect start_frame = layer_get_frame(s_grid_content_layer);
  GRect end_frame = GRect(0, 0, m.w, m.content_h);

  if (s_bounce_anim) {
    animation_unschedule((Animation *)s_bounce_anim);
    s_bounce_anim = NULL;
  }

  if (s_pull_indicator_layer) layer_mark_dirty(s_pull_indicator_layer);

  if (!animated || start_frame.origin.y == 0) {
    layer_set_frame(s_grid_content_layer, end_frame);
    return;
  }

  s_bounce_anim = property_animation_create_layer_frame(s_grid_content_layer, &start_frame, &end_frame);
  animation_set_duration((Animation *)s_bounce_anim, 220);
  animation_set_curve((Animation *)s_bounce_anim, AnimationCurveEaseOut);
  animation_schedule((Animation *)s_bounce_anim);
}

// Vertical drag & flick scrolls the list smoothly.
// Directly shifts the content layer frame on downward pull for visible elastic stretching and bounce.
static void main_pan_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  GridMetrics m = compute_grid_metrics();
  int min_y = (m.content_h > s_scroll_frame.size.h) ? -(m.content_h - s_scroll_frame.size.h) : 0;

  switch (event) {
    case RecognizerEvent_Started:
      if (s_bounce_anim) {
        animation_unschedule((Animation *)s_bounce_anim);
        s_bounce_anim = NULL;
      }
      s_pan_base = scroll_layer_get_content_offset(s_scroll_layer).y;
      s_pull_armed = false;
      s_pulling_down = false;
      break;

    case RecognizerEvent_Updated: {
      GPoint d = pan_recognizer_get_delta_since_start(recognizer);

      // Handle pull-down elastic stretching when dragging downward at top of list
      if (s_pan_base >= 0 && d.y > 0) {
        scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, 0), false);
        int pull_y = (d.y * 2) / 3;
        if (pull_y > 60) pull_y = 60;

        layer_set_frame(s_grid_content_layer, GRect(0, pull_y, m.w, m.content_h));

        bool was_armed = s_pull_armed;
        s_pull_armed = (pull_y >= PULL_TO_REFRESH_THRESHOLD);
        s_pulling_down = (pull_y > 8);

        if (s_pull_armed && !was_armed) {
          vibes_short_pulse();
        }
        if (s_pull_indicator_layer) layer_mark_dirty(s_pull_indicator_layer);
        update_header();
      } else {
        if (layer_get_frame(s_grid_content_layer).origin.y != 0) {
          reset_pull_position(false);
        }
        if (s_pull_armed || s_pulling_down) {
          s_pull_armed = false;
          s_pulling_down = false;
          update_header();
        }
        int target_y = s_pan_base + d.y;
        scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, target_y), false);
      }
      break;
    }

    case RecognizerEvent_Completed: {
      if (s_pull_armed) {
        s_pull_armed = false;
        s_pulling_down = false;
        s_is_refreshing = true;
        update_header();
        vibes_short_pulse();
        request_refresh();
        reset_pull_position(true);
        s_pan_base = 0;
      } else if (layer_get_frame(s_grid_content_layer).origin.y > 0) {
        s_pull_armed = false;
        s_pulling_down = false;
        update_header();
        reset_pull_position(true);
        s_pan_base = 0;
      } else {
        int cur_y = scroll_layer_get_content_offset(s_scroll_layer).y;
        GPoint v = pan_recognizer_get_velocity(recognizer);

        if (cur_y < min_y) {
          scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, min_y), true);
          s_pan_base = min_y;
        } else if (v.y > 250 || v.y < -250) {
          int target_y = cur_y + (v.y * 3) / 5;
          if (target_y > 0) target_y = 0;
          if (target_y < min_y) target_y = min_y;
          scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, target_y), true);
          s_pan_base = target_y;
        } else {
          s_pan_base = cur_y;
        }
      }
      break;
    }

    case RecognizerEvent_Cancelled: {
      s_pull_armed = false;
      s_pulling_down = false;
      update_header();
      reset_pull_position(true);
      int cur_y = scroll_layer_get_content_offset(s_scroll_layer).y;
      if (cur_y < min_y) {
        scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, min_y), true);
        s_pan_base = min_y;
      } else {
        s_pan_base = cur_y;
      }
      break;
    }

    default:
      break;
  }
}

#endif // PBL_API_EXISTS(tap_recognizer_create)

// ---------------------------------------------------------------------------
// Detail window: per-ride graph

static void update_detail_header(void) {
  if (s_detail_wait < 0) {
    snprintf(s_detail_header_buf, sizeof(s_detail_header_buf), "%s: Closed", s_detail_name);
  } else {
    snprintf(s_detail_header_buf, sizeof(s_detail_header_buf), "%s: %dm", s_detail_name, s_detail_wait);
  }
  if (s_detail_header_layer) layer_mark_dirty(s_detail_header_layer);
}

static void detail_header_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  graphics_context_set_text_color(ctx, GColorWhite);
  GFont font = PBL_IF_COLOR_ELSE(s_ride_name_font, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  draw_vcentered_text(ctx, s_detail_header_buf, font, bounds, GTextOverflowModeFill);
}

static void draw_dotted_h_line(GContext *ctx, int x_start, int x_end, int y, GColor color) {
  graphics_context_set_stroke_color(ctx, color);
  for (int x = x_start; x <= x_end; x += 4) {
    int xe = (x + 1 <= x_end) ? x + 1 : x_end;
    graphics_draw_line(ctx, GPoint(x, y), GPoint(xe, y));
  }
}

static void detail_graph_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  if (s_graph_show_error || s_graph_loading) {
    const char *msg = s_graph_show_error ? s_graph_error_buf : "Loading graph...";
    graphics_context_set_text_color(ctx, GColorBlack);
    draw_vcentered_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), bounds,
                         GTextOverflowModeWordWrap);
    return;
  }

  if (s_graph_count < 2) {
    graphics_context_set_text_color(ctx, GColorBlack);
    draw_vcentered_text(ctx, "Not enough data\nrecorded yet today",
                         fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), bounds, GTextOverflowModeWordWrap);
    return;
  }

  int margin = 4;
  int gutter = 26;
  int top_headroom = 6;
  int bottom_time_h = 14 + TEXT_EDGE_PADDING;
  GRect area = GRect(bounds.origin.x + margin + gutter,
                     bounds.origin.y + margin + top_headroom,
                     bounds.size.w - 2 * margin - gutter,
                     bounds.size.h - 2 * margin - bottom_time_h - top_headroom);
  int baseline_y = area.origin.y + area.size.h;

  int16_t max_w = 10; // minimum scale span so a flat line isn't full-height
  for (int i = 0; i < s_graph_count; i++) {
    if (s_graph_points[i] > max_w) max_w = s_graph_points[i];
  }

  // Only show the threshold line while the alert is actually armed — with
  // it off, a threshold value isn't in effect, so a line/scale stretch for
  // it would just be confusing.
  AlertConfig *alert = find_alert(s_detail_ride_id);
  bool show_threshold = alert && alert->enabled;
  if (show_threshold && alert->threshold_min > max_w) max_w = alert->threshold_min;

  // 1. Reference Gridlines (subtle 1px dotted)
  GColor grid_color = PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack);
  // Baseline (0m) line
  draw_dotted_h_line(ctx, area.origin.x, area.origin.x + area.size.w, baseline_y, grid_color);
  // Top ceiling (max_w) line
  draw_dotted_h_line(ctx, area.origin.x, area.origin.x + area.size.w, area.origin.y, grid_color);

  // 5-minute aligned benchmark gridline (e.g. 15m or 30m when scale has enough vertical room)
  int benchmark_wait = 0;
  if (max_w >= 50) benchmark_wait = 30;
  else if (max_w >= 25) benchmark_wait = 15;

  if (benchmark_wait > 0 && benchmark_wait < max_w) {
    int bench_y = area.origin.y + area.size.h - (area.size.h * benchmark_wait) / max_w;
    draw_dotted_h_line(ctx, area.origin.x, area.origin.x + area.size.w, bench_y, grid_color);

    char bench_buf[10];
    snprintf(bench_buf, sizeof(bench_buf), "%dm", benchmark_wait);
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_draw_text(ctx, bench_buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(bounds.origin.x, bench_y - 7, 28, 14),
                       GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  }

#if defined(PBL_COLOR)
  // 2. Subtle 50% dither / pin-stripe area fill under the curve down to baseline
  graphics_context_set_stroke_color(ctx, GColorBabyBlueEyes);
  for (int i = 0; i < s_graph_count - 1; i++) {
    bool gapped = (s_graph_minute_of_day[i + 1] - s_graph_minute_of_day[i] > GRAPH_GAP_MINUTES);
    if (gapped) continue;

    int x1 = (s_graph_count == 1) ? area.origin.x
                                  : area.origin.x + (area.size.w * i) / (s_graph_count - 1);
    int x2 = area.origin.x + (area.size.w * (i + 1)) / (s_graph_count - 1);
    int w1 = s_graph_points[i] < 0 ? 0 : s_graph_points[i];
    int w2 = s_graph_points[i + 1] < 0 ? 0 : s_graph_points[i + 1];
    int y1 = area.origin.y + area.size.h - (area.size.h * w1) / max_w;
    int y2 = area.origin.y + area.size.h - (area.size.h * w2) / max_w;

    int dx = x2 - x1;
    if (dx <= 0) continue;

    for (int x = x1; x <= x2; x++) {
      if (x % 2 == 0) { // Alternating 1px vertical pin-stripe
        int seg_y = y1 + (y2 - y1) * (x - x1) / dx;
        if (seg_y < baseline_y) {
          graphics_draw_line(ctx, GPoint(x, seg_y), GPoint(x, baseline_y - 1));
        }
      }
    }
  }
#endif

  // 3. Alert Threshold Line (drawn ON TOP of area fill)
  if (show_threshold) {
    int threshold_y = area.origin.y + area.size.h -
                       (area.size.h * alert->threshold_min) / max_w;
    GColor line_color;
#if defined(PBL_COLOR)
    GColor unused_text;
    alert_band_colors(alert, s_detail_wait, &line_color, &unused_text);
#else
    line_color = GColorBlack;
#endif
    graphics_context_set_stroke_color(ctx, line_color);
    graphics_context_set_stroke_width(ctx, 2);
    int dash = 4, gap = 3;
    for (int dx = area.origin.x; dx < area.origin.x + area.size.w; dx += dash + gap) {
      int dx_end = dx + dash;
      if (dx_end > area.origin.x + area.size.w) dx_end = area.origin.x + area.size.w;
      graphics_draw_line(ctx, GPoint(dx, threshold_y), GPoint(dx_end, threshold_y));
    }
    graphics_context_set_stroke_width(ctx, 1);
  }

  // 4. Main Curve Line & Data Points (drawn ON TOP)
  GPoint prev = GPointZero;
  bool has_prev = false;
  int prev_minute = 0;
  GColor curve_color = PBL_IF_COLOR_ELSE(GColorCobaltBlue, GColorBlack);
  for (int i = 0; i < s_graph_count; i++) {
    int x = (s_graph_count == 1) ? area.origin.x
                                  : area.origin.x + (area.size.w * i) / (s_graph_count - 1);
    int w = s_graph_points[i] < 0 ? 0 : s_graph_points[i];
    int y = area.origin.y + area.size.h - (area.size.h * w) / max_w;
    GPoint p = GPoint(x, y);
    bool gapped = has_prev && (s_graph_minute_of_day[i] - prev_minute > GRAPH_GAP_MINUTES);
    if (has_prev && !gapped) {
      graphics_context_set_stroke_color(ctx, curve_color);
      graphics_context_set_stroke_width(ctx, 2);
      graphics_draw_line(ctx, prev, p);
    }
    graphics_context_set_fill_color(ctx, curve_color);
    graphics_fill_circle(ctx, p, 2);
    prev = p;
    prev_minute = s_graph_minute_of_day[i];
    has_prev = true;
  }
  graphics_context_set_stroke_width(ctx, 1);

  // 5. Y-Axis & X-Axis Labels
  char buf[10];
  graphics_context_set_text_color(ctx, GColorBlack);
  snprintf(buf, sizeof(buf), "%dm", max_w);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(bounds.origin.x, area.origin.y - 7, 28, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, "0m", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(bounds.origin.x, baseline_y - 7, 28, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);

  format_minute_of_day(s_graph_minute_of_day[0], buf, sizeof(buf));
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(area.origin.x, bounds.origin.y + bounds.size.h - 14 - TEXT_EDGE_PADDING, 60, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  format_minute_of_day(s_graph_minute_of_day[s_graph_count - 1], buf, sizeof(buf));
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(area.origin.x + area.size.w - 50,
                            bounds.origin.y + bounds.size.h - 14 - TEXT_EDGE_PADDING, 50, 14),
                      GTextOverflowModeFill, GTextAlignmentRight, NULL);
}

// Shared between drawing and touch hit-testing so they can never disagree.
// Rects are local to the alert band layer (origin (0,0) = band's top-left).
static void alert_band_layout(GRect band_bounds, GRect *out_minus, GRect *out_plus) {
  int h = band_bounds.size.h - 8;
  *out_minus = GRect(4, 4, 36, h);
  *out_plus  = GRect(band_bounds.size.w - 40, 4, 36, h);
}

static void detail_alert_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  AlertConfig *a = find_alert(s_detail_ride_id);
  GColor band_fill, band_text;
  alert_band_colors(a, s_detail_wait, &band_fill, &band_text);
  graphics_context_set_fill_color(ctx, band_fill);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  graphics_context_set_stroke_color(ctx, GColorBlack);
  graphics_draw_line(ctx, GPoint(0, 0), GPoint(bounds.size.w, 0));

  GRect minus_rect, plus_rect;
  alert_band_layout(bounds, &minus_rect, &plus_rect);
  graphics_draw_round_rect(ctx, minus_rect, 4);
  graphics_draw_round_rect(ctx, plus_rect, 4);
  GFont sym_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  graphics_context_set_text_color(ctx, band_text);
  graphics_draw_text(ctx, "-", sym_font, minus_rect, GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, "+", sym_font, plus_rect, GTextOverflowModeFill, GTextAlignmentCenter, NULL);

  char buf[28];
  if (a && a->enabled) {
    snprintf(buf, sizeof(buf), "Alert ON: <%dm", a->threshold_min);
  } else {
    snprintf(buf, sizeof(buf), "Alert off");
  }
  // label_rect is taller than the label needs (room for "Alert ON: <Nm" to
  // wrap to a second line on narrower screens) - top-anchoring left it
  // sitting high with a gap below. The +/- buttons above don't have this
  // problem (confirmed against a real-watch screenshot they're correct
  // as-is): minus_rect/plus_rect are sized close to what a single symbol
  // glyph actually needs, so there's no meaningful gap to begin with.
  GRect label_rect = GRect(minus_rect.origin.x + minus_rect.size.w, 4,
                            plus_rect.origin.x - (minus_rect.origin.x + minus_rect.size.w), bounds.size.h - 8);
  // Bigger font where the detail area is wide enough to spare it (emery's
  // full 200px width, gabbro's ~184px inscribed square) - basalt (144) and
  // chalk (~127px inscribed square) stay on the smaller size, since chalk's
  // width already clips "Alert ON: <Nm" onto a cut-off second line even at
  // the current size (a pre-existing, separate issue - confirmed this isn't
  // something the font change caused, see the label-font revert commit).
  // 150 sits cleanly between the two pairs.
  bool wide_enough = bounds.size.w >= 150;
  GFont label_font = fonts_get_system_font(wide_enough ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_14_BOLD);
  // Both fonts reserve unused headroom above this text's actual ink (it has
  // no descenders: "Alert ON: <Nm" / "Alert off"), which plain box-centering
  // doesn't account for - see draw_vcentered_text_nudged's comment. Each
  // measured directly against a real-watch screenshot (a different bias per
  // font, not the same value reused): GOTHIC_14_BOLD's box-centered ink sat
  // at rows 20-28 of the 44px band (center 24) against a true center of
  // 21.5, a ~2.5px low bias; GOTHIC_18_BOLD's sat at rows 20-30 (center 25),
  // a ~3.5px low bias.
  int label_nudge = wide_enough ? -4 : -3;
  draw_vcentered_text_nudged(ctx, buf, label_font, label_rect, GTextOverflowModeFill, label_nudge);
}

static void toggle_alert_for_current_ride(void) {
  AlertConfig *a = find_or_create_alert(s_detail_ride_id);
  if (!a) return; // alert table full
  a->enabled = !a->enabled;
  // Arm without an immediate buzz if it's already below threshold — only a
  // future drop should notify, not the state you're already looking at.
  a->was_below = a->enabled && s_detail_wait >= 0 && s_detail_wait <= a->threshold_min;
  save_alerts();
  vibes_short_pulse();
  if (s_detail_alert_layer) layer_mark_dirty(s_detail_alert_layer);
  // Armed state feeds into SORT_ALERTS' ordering (a no-op, cheap enough not
  // to bother guarding, in the other two sort modes) - without this the
  // grid kept showing whatever order it last computed until the next data
  // refresh happened to trigger one, even though this ride had just moved
  // to (or out of) the pinned section.
  recompute_order();
  if (s_grid_content_layer) layer_mark_dirty(s_grid_content_layer);
}

static void adjust_alert_threshold(int delta) {
  AlertConfig *a = find_or_create_alert(s_detail_ride_id);
  if (!a) return;
  int new_val = a->threshold_min + delta;
  if (new_val < 0) new_val = 0;
  if (new_val > ALERT_MAX_MINUTES) new_val = ALERT_MAX_MINUTES;
  a->threshold_min = (int16_t)new_val;
  if (a->enabled) {
    a->was_below = s_detail_wait >= 0 && s_detail_wait <= a->threshold_min;
  }
  save_alerts();
  if (s_detail_alert_layer) layer_mark_dirty(s_detail_alert_layer);
}

static void detail_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  adjust_alert_threshold(ALERT_STEP_MINUTES);
}

static void detail_down_click_handler(ClickRecognizerRef recognizer, void *context) {
  adjust_alert_threshold(-ALERT_STEP_MINUTES);
}

static void detail_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  toggle_alert_for_current_ride();
}

static void open_tracker_window(void);

static void detail_select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  open_tracker_window();
}

static void detail_click_config_provider(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 200, detail_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 200, detail_down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, detail_select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, detail_select_long_click_handler, NULL);
#if PBL_API_EXISTS(tap_recognizer_create)
  window_multi_click_subscribe(BUTTON_ID_SELECT, 2, 0, 0, true, select_double_click_handler);
#endif
}

#if PBL_API_EXISTS(tap_recognizer_create)
static void detail_tap_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  if (event != RecognizerEvent_Completed) return;
  GPoint p = tap_recognizer_get_tap_point(recognizer);
  GRect band_frame = layer_get_frame(s_detail_alert_layer); // window-space

  if (p.y >= band_frame.origin.y) {
    GPoint local = GPoint(p.x - band_frame.origin.x, p.y - band_frame.origin.y);
    GRect minus_rect, plus_rect;
    alert_band_layout(GRect(0, 0, band_frame.size.w, band_frame.size.h), &minus_rect, &plus_rect);
    vibes_short_pulse();
    if (local.x >= minus_rect.origin.x && local.x < minus_rect.origin.x + minus_rect.size.w) {
      adjust_alert_threshold(-ALERT_STEP_MINUTES);
    } else if (local.x >= plus_rect.origin.x && local.x < plus_rect.origin.x + plus_rect.size.w) {
      adjust_alert_threshold(ALERT_STEP_MINUTES);
    } else {
      toggle_alert_for_current_ride();
    }
    return;
  }
  window_stack_pop(true);
}

// Swipe Left opens Ride Tracker; Swipe Right closes back to main grid
static void detail_swipe_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  if (event != RecognizerEvent_Completed) return;
  SwipeDirection dir = swipe_recognizer_get_direction(recognizer);
  if (dir == SwipeDirection_Left) {
    open_tracker_window();
  } else {
    window_stack_pop(true);
  }
}
#endif

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  window_set_click_config_provider(window, detail_click_config_provider);

#if PBL_API_EXISTS(tap_recognizer_create)
  Recognizer *tap = tap_recognizer_create(detail_tap_handler, NULL);
  Recognizer *swipe = swipe_recognizer_create(detail_swipe_handler, NULL,
      SwipeDirection_Left | SwipeDirection_Right);
  recognizer_set_simultaneous_with(tap, always_simultaneous);
  recognizer_set_simultaneous_with(swipe, always_simultaneous);
  window_attach_recognizer(window, tap);
  window_attach_recognizer(window, swipe);
  window_set_touch_bridge_disabled(window, true);
#endif

  // On round platforms, header/graph/alert-band are all confined to the
  // largest axis-aligned square inscribed in the circular display, rather
  // than each independently trying to avoid the bezel — anything drawn
  // inside that square is guaranteed clear of the curve at every edge, top
  // and bottom included, which a full-width layout can't promise (a plain
  // GRect(0, 0, bounds.size.w, ...) header clipped its own text before this
  // — see the main grid header's near-identical fix). An inscribed square's
  // diagonal equals the circle's diameter, so side = diameter / sqrt(2).
#if defined(PBL_ROUND)
  int diameter = bounds.size.w; // both round platforms are square displays
  int square_side = (diameter * 707) / 1000; // diameter / sqrt(2)
  GRect area = GRect((bounds.size.w - square_side) / 2, (bounds.size.h - square_side) / 2,
                      square_side, square_side);
#else
  GRect area = bounds;
#endif

  s_detail_header_layer = layer_create(GRect(area.origin.x, area.origin.y, area.size.w, 34));
  layer_set_update_proc(s_detail_header_layer, detail_header_update_proc);
  layer_add_child(root, s_detail_header_layer);
  update_detail_header();

  s_detail_graph_layer = layer_create(GRect(area.origin.x, area.origin.y + 34, area.size.w,
                                             area.size.h - 34 - ALERT_BAND_HEIGHT));
  layer_set_update_proc(s_detail_graph_layer, detail_graph_update_proc);
  layer_add_child(root, s_detail_graph_layer);

  s_detail_alert_layer = layer_create(GRect(area.origin.x, area.origin.y + area.size.h - ALERT_BAND_HEIGHT,
                                             area.size.w, ALERT_BAND_HEIGHT));
  layer_set_update_proc(s_detail_alert_layer, detail_alert_update_proc);
  layer_add_child(root, s_detail_alert_layer);
}

static void detail_window_unload(Window *window) {
  layer_destroy(s_detail_alert_layer);
  s_detail_alert_layer = NULL;
  layer_destroy(s_detail_graph_layer);
  s_detail_graph_layer = NULL;
  layer_destroy(s_detail_header_layer);
  s_detail_header_layer = NULL;
  window_destroy(window);
  s_detail_window = NULL;
  s_detail_ride_id = -1;
  if (s_grid_content_layer) layer_mark_dirty(s_grid_content_layer);
}

static void open_detail_window(void) {
  if (s_ride_count == 0) return;
  RideTile *r = &s_rides[s_order[s_cursor]];

  s_detail_ride_id = r->ride_id;
  strncpy(s_detail_name, r->name, NAME_BUF_LEN - 1);
  s_detail_name[NAME_BUF_LEN - 1] = '\0';
  s_detail_wait = r->wait_minutes;
  s_graph_count = 0;
  s_graph_expected_count = 0;
  s_graph_loading = true;
  s_graph_show_error = false;

  s_detail_window = window_create();
  window_set_background_color(s_detail_window, GColorWhite);
  window_set_window_handlers(s_detail_window, (WindowHandlers) {
    .load   = detail_window_load,
    .unload = detail_window_unload,
  });
  window_stack_push(s_detail_window, true);

  request_graph(r->ride_id);
}

// ---------------------------------------------------------------------------
// Coaster Ride Tracker & Accelerometer 25Hz G-Force Engine

static uint32_t int_sqrt(uint32_t n) {
  uint32_t root = 0;
  uint32_t bit = 1u << 30;
  while (bit > n) bit >>= 2;
  while (bit != 0) {
    if (n >= root + bit) {
      n -= root + bit;
      root = (root >> 1) + bit;
    } else {
      root >>= 1;
    }
    bit >>= 2;
  }
  return root;
}

static void format_g_force(char *buf, size_t buf_len, int16_t mg) {
  bool neg = (mg < 0);
  if (neg) mg = -mg;
  int whole = mg / 1000;
  int frac = (mg % 1000) / 10;
  if (neg) {
    snprintf(buf, buf_len, "-%d.%02d G", whole, frac);
  } else {
    snprintf(buf, buf_len, "%d.%02d G", whole, frac);
  }
}

#define TRACKER_MAX_SECONDS 300

// Sample the accelerometer as fast as the SDK allows and compute every metric
// at that full rate, but only *store* one sample in TRACKER_STORE_DECIMATION.
//
// Why: at the old 25Hz request we resolved to 12.5Hz (Nyquist) and
// systematically under-read exactly the sharp spikes a coaster app exists to
// measure — a peak lasting under 40ms could be missed outright. Asking for
// 100Hz gets 104Hz of real hardware (see the ODR table below), so peak G,
// the airtime run edges and roughness all get 4x the resolution.
//
// Storage stays at the old rate, so the buffer still covers the same ~96s of
// wall clock and the exported telemetry is unchanged in size. Metric fidelity
// is free; only raw resolution costs memory, and raw resolution is the part
// nobody analyses at 100Hz anyway.
//
// The ODR ladder on the LSM6DSO (Pebble Time 2 / Pebble 2 Duo) is
// 12.5/26/52/104/208Hz and the driver rounds a requested interval *up* to the
// next rung, so ACCEL_SAMPLING_100HZ delivers 104Hz / 9615us, and the old
// ACCEL_SAMPLING_25HZ was really 26Hz / 38461us — never the 40ms this code
// used to assume. Nothing here hardcodes any of that; the real interval is
// measured from AccelData.timestamp and shipped to the phone.
#define TRACKER_SAMPLING_RATE 100
#define TRACKER_STORE_DECIMATION 4
#define TRACKER_NOMINAL_DT_MS 10
// Interval between *stored* samples, used only as the phone's fallback.
#define TRACKER_NOMINAL_STORED_DT_MS (TRACKER_NOMINAL_DT_MS * TRACKER_STORE_DECIMATION)

// Samples per callback. At 104Hz this is ~10 wake-ups a second: enough to keep
// the live G readout and the AIRTIME badge feeling immediate without waking
// the app on every single sample.
#define TRACKER_SAMPLES_PER_UPDATE 10

// The accelerometer is configured +/-4g per axis (CONFIG_ACCEL_LSM6DSO_SCALE_MG
// =4000), so anything at the rail is a floor, not a reading. Desk tests have
// already reached 3892mg, so a real coaster will clip — count it and say so
// rather than reporting a saturated peak as though it were real.
#define TRACKER_CLIP_MG 3950

// Vibration blanking. did_vibrate is set by the firmware as
// `sys_vibe_get_vibe_strength() != VIBE_STRENGTH_OFF`, i.e. it is true only
// while the motor is actually ON. It says nothing about the watch physically
// ringing down afterwards, and a wrist keeps sloshing for a good while after a
// 250ms buzz stops. Gating on the flag alone therefore leaves a tail of
// corrupted samples that can still become the reported peak G.
//
// So: skip metrics for the whole motor-on window *plus* a settle period.
// vibes_short_pulse() is 250ms (SHORT_PULSE_DURATIONS in PebbleOS), and
// recording starts with one, hence the start blank. Any vibration mid-ride —
// a system notification, say — re-arms the shorter ringdown blank.
//
// Cost: the first 400ms of a recording contributes no metrics. That is free in
// practice (you press record before the train dispatches) and much cheaper
// than a phantom 4g peak. It also conveniently covers the boxcar's warm-up,
// where the window is still part-seeded with its fictitious 1.0g.
#define TRACKER_VIBE_RINGDOWN_MS 150

// Pressing SELECT starts a countdown rather than recording immediately: it
// takes a second or two to get your arms back onto the restraints, and any
// data from that is noise at best. It also disposes of the start-buzz problem
// at the source — the last countdown buzz is a full second before recording
// begins, so the watch has completely settled by then and there is no start
// pulse to filter. The did_vibrate + ringdown blanking below stays anyway, for
// vibration the tracker doesn't control (a notification arriving mid-ride).
#define TRACKER_COUNTDOWN_SECONDS 3
#define TRACKER_SPARKLINE_POINTS 60
#define SAMPLES_PER_CHUNK 25

// What this watch can and cannot measure, because it drives every threshold
// below and a previous version of this code got it badly wrong:
//
// Available: a 3-axis accelerometer, and a *tilt-compensated magnetic heading
// scalar* (compass_service gives a bearing, not the raw magnetometer vector).
// There is no gyroscope on any Pebble — no API in any header, no symbol in
// libpebble.a on any platform — so angular rate cannot be integrated.
//
// Consequence: **inversions are not detectable.** The old code tried, using
// heading, and could never have worked. `magnetic_heading` is *yaw* — bearing
// in the horizontal plane. A vertical loop is a pitch rotation: the train
// enters and leaves on the same bearing, so heading barely moves; meanwhile a
// flat helix sweeps a full 180 with no inversion at all. So heading counts
// exactly the wrong thing. On top of that the heading is only valid while the
// watch is roughly level, so it goes invalid *during* the very manoeuvre it
// was meant to detect. And physically, inside a well-shaped loop the rider
// feels positive G the whole way round, so the accelerometer can't separate
// "upside down" from "hard flat turn" either. It's now a turn counter, which
// is what the sensor actually supports.
//
// Everything else here is deliberately computed from the acceleration
// *magnitude*, which is rotation-invariant — the one thing that stays true on
// a wrist that's free to flail about.

// Airtime: |a| below this is near free-fall. Rotation-invariant, so it holds
// regardless of how the wrist is oriented.
#define TRACKER_AIRTIME_MG 500
// A run must last this long to count as a hill rather than a wrist flick.
#define TRACKER_AIRTIME_MIN_MS 160
// Sustained heavy positive G.
#define TRACKER_HIGH_G_MG 2000
// A turn is this much accumulated yaw in one direction. Accumulated by angle,
// never by consecutive-tick runs: compass_service_set_heading_filter() only
// emits an event every 5 degrees, so heading arrives as isolated jumps
// separated by long stretches of zero change. The old detector required 8
// consecutive ticks of >=2.5 degrees each and therefore never once fired on
// real data — every candidate run died at length 1.
#define TRACKER_TURN_TENTHS 900
// Reversal bigger than this abandons the turn being accumulated.
#define TRACKER_TURN_REVERSE_TENTHS 300
// Per-sample dt is taken from AccelData.timestamp rather than assumed, but is
// clamped so one bad/batched timestamp can't blow up an integration.
#define TRACKER_DT_MIN_MS 4
#define TRACKER_DT_MAX_MS 200

typedef struct {
  int16_t x;
  int16_t y;
  int16_t z;
  uint16_t heading; // 0..3600 (0.1 degree units)
} RawSensorSample;

typedef enum {
  TRACKER_STATE_IDLE = 0,
  TRACKER_STATE_COUNTDOWN,
  TRACKER_STATE_RECORDING,
  TRACKER_STATE_SUMMARY
} TrackerState;

typedef enum {
  TRACKER_SYNC_IDLE = 0,
  TRACKER_SYNC_SENDING_START,
  TRACKER_SYNC_SENDING_CHUNKS,
  TRACKER_SYNC_SENDING_END,
  TRACKER_SYNC_DONE,
  TRACKER_SYNC_FAILED
} TrackerSyncState;

static Window *s_tracker_window = NULL;
static Layer *s_tracker_header_layer = NULL;
static Layer *s_tracker_main_layer = NULL;
static Layer *s_tracker_action_layer = NULL;

static TrackerState s_tracker_state = TRACKER_STATE_IDLE;
static int32_t s_tracker_ride_id = -1;
static char s_tracker_ride_name[NAME_BUF_LEN];

static RawSensorSample *s_tracker_raw_samples = NULL;
static uint16_t s_tracker_sample_count = 0;
static uint16_t s_tracker_allocated_capacity = 0;

static uint16_t s_tracker_current_heading = 0;
static bool s_tracker_compass_ok = false;
static TrackerSyncState s_tracker_sync_state = TRACKER_SYNC_IDLE;
static uint16_t s_tracker_sync_offset = 0;
static AppTimer *s_tracker_sync_timer = NULL;

static int16_t s_tracker_live_g = 1000;

// Extremum trackers seeded to sentinels, NOT to 1000. Seeding them at 1g meant
// a ride that never crossed 1g reported a max (or min) of exactly 1.00g that
// was never measured — and a stationary watch showed "Max 1.00 / Min 1.00",
// which looks plausible enough that the bug hid. s_tracker_metric_samples
// says whether either has been written at all.
static int16_t s_tracker_max_g = 0;
static int16_t s_tracker_min_g = INT16_MAX;
static uint32_t s_tracker_metric_samples = 0;
static uint32_t s_tracker_g_sum = 0;          // for the mean; mg * samples

static uint32_t s_tracker_airtime_ms = 0;     // sustained runs only
static uint32_t s_tracker_airtime_run_ms = 0; // the run in progress
static uint32_t s_tracker_max_airtime_ms = 0; // longest single float
static uint16_t s_tracker_airtime_hills = 0;
static uint32_t s_tracker_high_g_ms = 0;

// Ride roughness: mean |d|a|/dt| in mg per second, i.e. jerk magnitude. Also
// orientation-independent, and the one number that actually distinguishes a
// rattling old coaster from a smooth one.
//
// The sum is 64-bit deliberately. A single sample can contribute ~693000
// (a 6928mg swing over a 10ms interval), and at 104Hz a 5-minute recording is
// 31200 samples — around 2.2e10, comfortably past the 4.29e9 a uint32 holds.
// It fitted at 26Hz; raising the rate is what breaks it.
static uint64_t s_tracker_jerk_sum = 0;
static uint32_t s_tracker_jerk_samples = 0;
static int16_t s_tracker_prev_filtered_g = -1;

// Samples whose peak axis sat at the +/-4g rail.
static uint32_t s_tracker_clipped_samples = 0;

// Counts down while the watch is buzzing or still ringing from it.
static uint32_t s_tracker_vibe_blank_ms = 0;
static uint8_t s_tracker_countdown = 0;
static uint32_t s_tracker_blanked_samples = 0;

// Yaw turns, accumulated by angle (see TRACKER_TURN_TENTHS).
static uint16_t s_tracker_turn_count = 0;
static uint32_t s_tracker_rotation_tenths = 0; // total absolute yaw swept
static int32_t s_tracker_turn_accum = 0;
static uint16_t s_tracker_last_heading = 0;
static bool s_tracker_heading_valid = false;

static uint64_t s_tracker_last_ts = 0;        // previous raw sample, for dt
// First/last *stored* sample. The reported interval has to describe the stored
// series, since that's what the phone reconstructs timestamps from — spanning
// the raw series instead would understate it by the decimation factor.
static uint64_t s_tracker_first_stored_ts = 0;
static uint64_t s_tracker_last_stored_ts = 0;
static uint8_t s_tracker_decim = 0;
static uint16_t s_tracker_elapsed_sec = 0;
static bool s_tracker_buffer_full = false;

static int16_t s_tracker_window_buf[4] = {1000, 1000, 1000, 1000};
static uint8_t s_tracker_window_idx = 0;

static int16_t s_tracker_sparkline[TRACKER_SPARKLINE_POINTS];
static uint8_t s_tracker_sparkline_count = 0;

static AppTimer *s_tracker_timer = NULL;

static void stop_tracker_recording(void);

static void tracker_compass_handler(CompassHeadingData heading_data) {
  // Only Calibrating and Calibrated carry usable data. The old guard was
  // `!= CompassStatusUnavailable`, which also let CompassStatusDataInvalid (0)
  // through — the SDK documents that one as "data is invalid and should not be
  // used". s_tracker_heading_valid drops on bad data so the turn detector
  // skips that interval outright rather than treating a stale heading as a
  // real (zero) rotation, or a resync as a real jump.
  if (heading_data.compass_status == CompassStatusCalibrated ||
      heading_data.compass_status == CompassStatusCalibrating) {
    uint32_t raw_h = (uint32_t)heading_data.magnetic_heading;
    s_tracker_current_heading = (uint16_t)((raw_h * 3600) / TRIG_MAX_ANGLE);
    s_tracker_compass_ok = true;
  } else {
    s_tracker_compass_ok = false;
  }
}

static void tracker_second_tick(void *data) {
  if (s_tracker_state == TRACKER_STATE_RECORDING) {
    s_tracker_elapsed_sec++;
    if (s_tracker_elapsed_sec >= TRACKER_MAX_SECONDS) {
      stop_tracker_recording();
      return;
    }
    if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
    if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
    s_tracker_timer = app_timer_register(1000, tracker_second_tick, NULL);
  }
}

// Banks the turn currently being accumulated, if it ever got big enough to
// count. Called on a direction reversal and once more when recording stops, so
// the final turn of a ride isn't dropped for want of a reversal after it.
static void tracker_bank_turn(void) {
  int32_t abs_accum = s_tracker_turn_accum < 0 ? -s_tracker_turn_accum : s_tracker_turn_accum;
  if (abs_accum >= TRACKER_TURN_TENTHS) s_tracker_turn_count++;
  s_tracker_turn_accum = 0;
}

static void tracker_accel_data_handler(AccelData *data, uint32_t num_samples) {
  for (uint32_t i = 0; i < num_samples; i++) {
    int32_t x = data[i].x;
    int32_t y = data[i].y;
    int32_t z = data[i].z;
    int32_t sq_sum = x * x + y * y + z * z;
    int16_t inst_g = (int16_t)int_sqrt(sq_sum);

    s_tracker_live_g = inst_g;

    // 4-sample boxcar. Deliberately left at 4 samples rather than widened to
    // preserve the old time constant: at 26Hz it spanned ~154ms, which averaged
    // away genuine short airtime pops and cost real peak G; at 104Hz the same 4
    // samples span ~38ms, which still rejects single-sample sensor noise but
    // resolves events four times shorter. Measured on real rides, halving the
    // rate from 26Hz to 13Hz alone cost 22% of one ride's raw peak — the
    // reported peak is strongly rate-dependent, and this is the point of
    // sampling fast.
    s_tracker_window_buf[s_tracker_window_idx] = inst_g;
    s_tracker_window_idx = (s_tracker_window_idx + 1) % 4;
    int32_t filtered_sum = (int32_t)s_tracker_window_buf[0] + s_tracker_window_buf[1] +
                           s_tracker_window_buf[2] + s_tracker_window_buf[3];
    int16_t filtered_g = (int16_t)(filtered_sum / 4);

    if (s_tracker_state != TRACKER_STATE_RECORDING) continue;

    // Real elapsed time between samples. The old code assumed a flat 40ms;
    // AccelData carries a genuine millisecond timestamp, and using it keeps
    // the airtime/high-G integrals honest when the service batches or drops.
    uint64_t ts = data[i].timestamp;
    uint32_t dt_ms = TRACKER_NOMINAL_DT_MS;
    if (s_tracker_last_ts != 0 && ts > s_tracker_last_ts) {
      uint64_t delta = ts - s_tracker_last_ts;
      if (delta < TRACKER_DT_MIN_MS) delta = TRACKER_DT_MIN_MS;
      if (delta > TRACKER_DT_MAX_MS) delta = TRACKER_DT_MAX_MS;
      dt_ms = (uint32_t)delta;
    }
    s_tracker_last_ts = ts;

    // Decimated storage. The stored series must stay strictly uniform — the
    // phone rebuilds timestamps as (index * interval) — so a sample lands
    // whenever the counter comes round, vibration-tainted or not. Dropping one
    // would shift every timestamp after it. Taint is handled below, where it
    // belongs: by excluding the sample from the metrics.
    if (++s_tracker_decim >= TRACKER_STORE_DECIMATION) {
      s_tracker_decim = 0;
      if (s_tracker_raw_samples && s_tracker_sample_count < s_tracker_allocated_capacity) {
        s_tracker_raw_samples[s_tracker_sample_count].x = (int16_t)x;
        s_tracker_raw_samples[s_tracker_sample_count].y = (int16_t)y;
        s_tracker_raw_samples[s_tracker_sample_count].z = (int16_t)z;
        s_tracker_raw_samples[s_tracker_sample_count].heading = s_tracker_current_heading;
        s_tracker_sample_count++;
        if (s_tracker_first_stored_ts == 0) s_tracker_first_stored_ts = ts;
        s_tracker_last_stored_ts = ts;
      } else {
        // Metrics keep accumulating for the whole ride, but the raw stream
        // stops here. Surfaced rather than silent: the summary and the
        // exported CSV otherwise describe different spans with no hint.
        s_tracker_buffer_full = true;
      }
    }

    // Every metric below skips samples the watch's own vibration motor
    // corrupted. The countdown means the tracker no longer buzzes at the
    // moment recording starts, but vibration it does NOT control still
    // happens — a notification arriving mid-ride — and a sharp spike will
    // otherwise *become* the reported peak G.
    //
    // did_vibrate covers only the motor-on window; the blank extends past it
    // to cover the ringdown (see TRACKER_VIBE_RINGDOWN_MS). The sample is
    // still *stored* — the exported series has to stay uniform — it just
    // doesn't feed any metric.
    if (data[i].did_vibrate) {
      s_tracker_vibe_blank_ms = TRACKER_VIBE_RINGDOWN_MS;
      s_tracker_blanked_samples++;
      continue;
    }
    if (s_tracker_vibe_blank_ms > 0) {
      s_tracker_vibe_blank_ms = (dt_ms >= s_tracker_vibe_blank_ms)
                                    ? 0 : (s_tracker_vibe_blank_ms - dt_ms);
      s_tracker_blanked_samples++;
      continue;
    }

    s_tracker_metric_samples++;
    s_tracker_g_sum += (uint32_t)filtered_g;

    // At the rail the sensor is reporting its own limit, not the ride.
    int32_t peak_axis = x < 0 ? -x : x;
    int32_t ay = y < 0 ? -y : y;
    int32_t az = z < 0 ? -z : z;
    if (ay > peak_axis) peak_axis = ay;
    if (az > peak_axis) peak_axis = az;
    if (peak_axis >= TRACKER_CLIP_MG) s_tracker_clipped_samples++;

    if (filtered_g > s_tracker_max_g) s_tracker_max_g = filtered_g;
    if (filtered_g < s_tracker_min_g) s_tracker_min_g = filtered_g;

    if (s_tracker_prev_filtered_g >= 0) {
      int32_t d_g = (int32_t)filtered_g - s_tracker_prev_filtered_g;
      if (d_g < 0) d_g = -d_g;
      // mg per second, so the figure doesn't depend on the sample rate.
      s_tracker_jerk_sum += (uint64_t)((d_g * 1000) / (int32_t)dt_ms);
      s_tracker_jerk_samples++;
    }
    s_tracker_prev_filtered_g = filtered_g;

    if (filtered_g >= TRACKER_HIGH_G_MG) s_tracker_high_g_ms += dt_ms;

    // Airtime. A run only counts once it has lasted TRACKER_AIRTIME_MIN_MS,
    // and then the whole run counts — including the part before the threshold
    // was reached. The old version added every sub-0.5g sample to the total
    // while requiring 4 in a row for a "hill", so the two numbers described
    // different things and could not be reconciled.
    if (filtered_g < TRACKER_AIRTIME_MG) {
      uint32_t was = s_tracker_airtime_run_ms;
      s_tracker_airtime_run_ms += dt_ms;
      if (was < TRACKER_AIRTIME_MIN_MS && s_tracker_airtime_run_ms >= TRACKER_AIRTIME_MIN_MS) {
        s_tracker_airtime_hills++;
        s_tracker_airtime_ms += s_tracker_airtime_run_ms;  // backfill the run so far
      } else if (was >= TRACKER_AIRTIME_MIN_MS) {
        s_tracker_airtime_ms += dt_ms;
      }
      if (s_tracker_airtime_run_ms > s_tracker_max_airtime_ms &&
          s_tracker_airtime_run_ms >= TRACKER_AIRTIME_MIN_MS) {
        s_tracker_max_airtime_ms = s_tracker_airtime_run_ms;
      }
    } else {
      s_tracker_airtime_run_ms = 0;
    }

    // Yaw turns. Accumulate the angle itself; never require consecutive ticks.
    // A reversal past TRACKER_TURN_REVERSE_TENTHS abandons the turn in
    // progress, so a wrist waggling back and forth cannot ratchet up a count.
    if (s_tracker_compass_ok) {
      if (!s_tracker_heading_valid) {
        // First valid heading, or the first after a dropout: establish a
        // reference without charging the gap to the rider as rotation.
        s_tracker_last_heading = s_tracker_current_heading;
        s_tracker_heading_valid = true;
      } else {
        int16_t d_heading = (int16_t)s_tracker_current_heading - (int16_t)s_tracker_last_heading;
        if (d_heading > 1800) d_heading -= 3600;
        else if (d_heading < -1800) d_heading += 3600;
        s_tracker_last_heading = s_tracker_current_heading;

        if (d_heading != 0) {
          int32_t abs_dh = d_heading < 0 ? -d_heading : d_heading;
          s_tracker_rotation_tenths += (uint32_t)abs_dh;

          // A turn is banked when the yaw *reverses*, not every 90 degrees.
          // Counting per-90 would make this number a near-duplicate of
          // rotation_tenths (helix of 360 = "4 turns"); banking on reversal
          // makes the pair complementary — "7 turns, 1260 degrees swept" says
          // considerably more than either does alone, and one long helix reads
          // as the single continuous turn a rider would call it.
          bool reversing = (s_tracker_turn_accum > 0 && d_heading < 0) ||
                           (s_tracker_turn_accum < 0 && d_heading > 0);
          if (reversing && abs_dh >= TRACKER_TURN_REVERSE_TENTHS) {
            tracker_bank_turn();
            s_tracker_turn_accum = d_heading;
          } else {
            s_tracker_turn_accum += d_heading;
          }
        }
      }
    } else {
      s_tracker_heading_valid = false;
    }

    if (s_tracker_elapsed_sec >= TRACKER_MAX_SECONDS) {
      stop_tracker_recording();
      return;
    }
  }

  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
}

static void send_next_tracker_chunk(void *data);
static void tracker_chunk_timer_callback(void *data);
static void start_tracker_sync_to_phone(void);

// Summary accessors. All of them answer "nothing measured" with 0 rather than
// with the sentinel the accumulator happens to hold, so a recording that
// captured no clean samples (every one vibration-tainted, say) reports zeros
// instead of INT16_MAX.

static int16_t tracker_summary_max_g(void) {
  return s_tracker_metric_samples ? s_tracker_max_g : 0;
}

// |a|, so this bottoms out at 0 (true free-fall) and can never be negative.
// Coaster telemetry conventionally quotes *negative* G during airtime, but
// that is signed acceleration along the rider's vertical axis, and recovering
// it needs an orientation this hardware can't supply: with no gyro the only
// vertical reference is a low-passed accelerometer, which on a coaster is
// measuring sustained centripetal force rather than gravity — wrong in
// exactly the moments that matter. Reported honestly as a magnitude instead.
static int16_t tracker_summary_min_g(void) {
  return s_tracker_metric_samples ? s_tracker_min_g : 0;
}

static int16_t tracker_summary_avg_g(void) {
  if (!s_tracker_metric_samples) return 0;
  return (int16_t)(s_tracker_g_sum / s_tracker_metric_samples);
}

static uint16_t tracker_summary_roughness(void) {
  if (!s_tracker_jerk_samples) return 0;
  uint64_t r = s_tracker_jerk_sum / s_tracker_jerk_samples;
  return r > UINT16_MAX ? UINT16_MAX : (uint16_t)r;
}

// Measured mean sample interval in tenths of a millisecond, so the phone can
// timestamp the exported telemetry from what the accelerometer actually did
// rather than from a hardcoded 40ms.
static uint16_t tracker_summary_interval_tenths(void) {
  if (s_tracker_sample_count < 2 || s_tracker_last_stored_ts <= s_tracker_first_stored_ts) {
    return TRACKER_NOMINAL_STORED_DT_MS * 10;
  }
  uint64_t span = s_tracker_last_stored_ts - s_tracker_first_stored_ts;
  uint32_t interval = (uint32_t)((span * 10) / (s_tracker_sample_count - 1));
  if (interval < TRACKER_DT_MIN_MS * 10 ||
      interval > TRACKER_DT_MAX_MS * TRACKER_STORE_DECIMATION * 10) {
    return TRACKER_NOMINAL_STORED_DT_MS * 10;
  }
  return (uint16_t)interval;
}

static void tracker_sync_start_timer_callback(void *data) {
  start_tracker_sync_to_phone();
}

static void start_tracker_sync_to_phone(void) {
  if (s_tracker_sample_count == 0 || !s_tracker_raw_samples) return;
  s_tracker_sync_state = TRACKER_SYNC_SENDING_START;
  s_tracker_sync_offset = 0;
  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);

  uint32_t retry_ms = s_phone_connected ? 150 : 2000;

  DictionaryIterator *iter;
  AppMessageResult res = app_message_outbox_begin(&iter);
  if (res == APP_MSG_OK) {
    dict_write_uint8(iter, MESSAGE_KEY_RideLogStart, 1);
    dict_write_int32(iter, MESSAGE_KEY_RideLogRideId, s_tracker_ride_id);
    dict_write_cstring(iter, MESSAGE_KEY_RideLogRideName, s_tracker_ride_name);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogDuration, s_tracker_elapsed_sec);
    // Both extrema are |a| — a vector magnitude, so never negative. Sent as
    // int16 for wire compatibility, but a "min G" below zero is not a thing
    // this hardware can produce; see the note by tracker_summary_min_g().
    dict_write_int16(iter, MESSAGE_KEY_RideLogMaxG, tracker_summary_max_g());
    dict_write_int16(iter, MESSAGE_KEY_RideLogMinG, tracker_summary_min_g());
    dict_write_int16(iter, MESSAGE_KEY_RideLogAvgG, tracker_summary_avg_g());
    dict_write_uint32(iter, MESSAGE_KEY_RideLogAirtimeMs, s_tracker_airtime_ms);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogAirtimeHills, s_tracker_airtime_hills);
    dict_write_uint32(iter, MESSAGE_KEY_RideLogMaxAirtimeMs, s_tracker_max_airtime_ms);
    dict_write_uint32(iter, MESSAGE_KEY_RideLogHighGMs, s_tracker_high_g_ms);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogTurns, s_tracker_turn_count);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogRotationDeg,
                      (uint16_t)(s_tracker_rotation_tenths / 10));
    dict_write_uint16(iter, MESSAGE_KEY_RideLogRoughness, tracker_summary_roughness());
    dict_write_uint16(iter, MESSAGE_KEY_RideLogSampleIntervalMs, tracker_summary_interval_tenths());
    dict_write_uint8(iter, MESSAGE_KEY_RideLogTruncated, s_tracker_buffer_full ? 1 : 0);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogClipped,
                      s_tracker_clipped_samples > UINT16_MAX
                          ? UINT16_MAX : (uint16_t)s_tracker_clipped_samples);
    dict_write_uint16(iter, MESSAGE_KEY_RideLogTotalSamples, s_tracker_sample_count);
    AppMessageResult send_res = app_message_outbox_send();
    if (send_res != APP_MSG_OK) {
      if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = app_timer_register(retry_ms, tracker_sync_start_timer_callback, NULL);
    }
  } else {
    if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
    s_tracker_sync_timer = app_timer_register(retry_ms, tracker_sync_start_timer_callback, NULL);
  }
}

static void send_next_tracker_chunk(void *data) {
  s_tracker_sync_timer = NULL;
  if (s_tracker_sync_state != TRACKER_SYNC_SENDING_CHUNKS && s_tracker_sync_state != TRACKER_SYNC_SENDING_END) return;
  if (!s_tracker_raw_samples || s_tracker_sample_count == 0) {
    s_tracker_sync_state = TRACKER_SYNC_DONE;
    if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
    return;
  }

  uint32_t retry_ms = s_phone_connected ? 150 : 2000;

  if (s_tracker_sync_offset >= s_tracker_sample_count) {
    s_tracker_sync_state = TRACKER_SYNC_SENDING_END;
    DictionaryIterator *iter;
    AppMessageResult res = app_message_outbox_begin(&iter);
    if (res == APP_MSG_OK) {
      dict_write_uint8(iter, MESSAGE_KEY_RideLogEnd, 1);
      dict_write_uint16(iter, MESSAGE_KEY_RideLogTotalSamples, s_tracker_sample_count);
      AppMessageResult send_res = app_message_outbox_send();
      if (send_res != APP_MSG_OK) {
        if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
        s_tracker_sync_timer = app_timer_register(retry_ms, tracker_chunk_timer_callback, NULL);
      }
    } else {
      if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = app_timer_register(retry_ms, tracker_chunk_timer_callback, NULL);
    }
    return;
  }

  uint16_t remaining = s_tracker_sample_count - s_tracker_sync_offset;
  uint8_t count = remaining > SAMPLES_PER_CHUNK ? SAMPLES_PER_CHUNK : (uint8_t)remaining;

  uint8_t chunk_buf[3 + (SAMPLES_PER_CHUNK * 8)];
  chunk_buf[0] = (uint8_t)(s_tracker_sync_offset >> 8);
  chunk_buf[1] = (uint8_t)(s_tracker_sync_offset & 0xFF);
  chunk_buf[2] = count;

  uint16_t byte_idx = 3;
  for (uint8_t i = 0; i < count; i++) {
    RawSensorSample *s = &s_tracker_raw_samples[s_tracker_sync_offset + i];
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->x >> 8);
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->x & 0xFF);
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->y >> 8);
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->y & 0xFF);
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->z >> 8);
    chunk_buf[byte_idx++] = (uint8_t)((uint16_t)s->z & 0xFF);
    chunk_buf[byte_idx++] = (uint8_t)(s->heading >> 8);
    chunk_buf[byte_idx++] = (uint8_t)(s->heading & 0xFF);
  }

  DictionaryIterator *iter;
  AppMessageResult res = app_message_outbox_begin(&iter);
  if (res == APP_MSG_OK) {
    dict_write_data(iter, MESSAGE_KEY_RideLogChunk, chunk_buf, byte_idx);
    AppMessageResult send_res = app_message_outbox_send();
    if (send_res == APP_MSG_OK) {
      s_tracker_sync_offset += count;
    } else {
      if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = app_timer_register(retry_ms, tracker_chunk_timer_callback, NULL);
    }
  } else {
    if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
    s_tracker_sync_timer = app_timer_register(retry_ms, tracker_chunk_timer_callback, NULL);
  }
}

static void begin_tracker_recording(void) {
  if (s_tracker_state == TRACKER_STATE_RECORDING) return;

  if (s_tracker_sync_timer) {
    app_timer_cancel(s_tracker_sync_timer);
    s_tracker_sync_timer = NULL;
  }
  s_tracker_sync_state = TRACKER_SYNC_IDLE;

  if (!s_tracker_raw_samples) {
#if defined(PBL_PLATFORM_EMERY)
    static const uint16_t try_caps[] = { 4000, 3000, 2000, 1000, 500 };
#elif defined(PBL_PLATFORM_APLITE)
    static const uint16_t try_caps[] = { 300, 150, 0 };
#else
    static const uint16_t try_caps[] = { 2500, 2000, 1500, 1000, 600, 300 };
#endif
    s_tracker_allocated_capacity = 0;
    for (size_t c = 0; c < sizeof(try_caps)/sizeof(try_caps[0]); c++) {
      if (try_caps[c] == 0) break;
      s_tracker_raw_samples = malloc(try_caps[c] * sizeof(RawSensorSample));
      if (s_tracker_raw_samples) {
        s_tracker_allocated_capacity = try_caps[c];
        break;
      }
    }
  }
  s_tracker_sample_count = 0;
  s_tracker_buffer_full = false;
  s_tracker_live_g = 1000;
  s_tracker_max_g = 0;
  s_tracker_min_g = INT16_MAX;
  s_tracker_metric_samples = 0;
  s_tracker_g_sum = 0;
  s_tracker_airtime_ms = 0;
  s_tracker_airtime_run_ms = 0;
  s_tracker_max_airtime_ms = 0;
  s_tracker_airtime_hills = 0;
  s_tracker_high_g_ms = 0;
  s_tracker_jerk_sum = 0;
  s_tracker_jerk_samples = 0;
  s_tracker_prev_filtered_g = -1;
  s_tracker_clipped_samples = 0;
  s_tracker_decim = 0;
  s_tracker_vibe_blank_ms = 0;
  s_tracker_blanked_samples = 0;
  s_tracker_turn_count = 0;
  s_tracker_rotation_tenths = 0;
  s_tracker_turn_accum = 0;
  s_tracker_heading_valid = false;
  s_tracker_last_ts = 0;
  s_tracker_first_stored_ts = 0;
  s_tracker_last_stored_ts = 0;
  s_tracker_elapsed_sec = 0;
  s_tracker_sparkline_count = 0;
  for (int i = 0; i < 4; i++) s_tracker_window_buf[i] = 1000;
  s_tracker_window_idx = 0;

  s_tracker_state = TRACKER_STATE_RECORDING;
  // Deliberately no buzz here. The countdown's final pulse fired a second ago,
  // which is both the "go" signal and long enough for the watch to stop
  // ringing — buzzing now would put a ~4g spike into the first samples of
  // every recording, which is exactly the bug this replaced.

  if (s_tracker_timer) {
    app_timer_cancel(s_tracker_timer);
    s_tracker_timer = NULL;
  }
  s_tracker_timer = app_timer_register(1000, tracker_second_tick, NULL);

  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
  if (s_tracker_action_layer) layer_mark_dirty(s_tracker_action_layer);
}

static void tracker_countdown_tick(void *data) {
  s_tracker_timer = NULL;
  if (s_tracker_state != TRACKER_STATE_COUNTDOWN) return;

  if (s_tracker_countdown > 0) s_tracker_countdown--;

  if (s_tracker_countdown == 0) {
    begin_tracker_recording();
    return;
  }

  vibes_short_pulse();
  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
  s_tracker_timer = app_timer_register(1000, tracker_countdown_tick, NULL);
}

static void start_tracker_countdown(void) {
  if (s_tracker_state == TRACKER_STATE_COUNTDOWN ||
      s_tracker_state == TRACKER_STATE_RECORDING) return;

  s_tracker_state = TRACKER_STATE_COUNTDOWN;
  s_tracker_countdown = TRACKER_COUNTDOWN_SECONDS;
  vibes_short_pulse();

  if (s_tracker_timer) app_timer_cancel(s_tracker_timer);
  s_tracker_timer = app_timer_register(1000, tracker_countdown_tick, NULL);

  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
  if (s_tracker_action_layer) layer_mark_dirty(s_tracker_action_layer);
}

// Abandoning the countdown before it fires, so a mistimed press isn't a
// committed recording.
static void cancel_tracker_countdown(void) {
  if (s_tracker_state != TRACKER_STATE_COUNTDOWN) return;
  if (s_tracker_timer) {
    app_timer_cancel(s_tracker_timer);
    s_tracker_timer = NULL;
  }
  s_tracker_state = TRACKER_STATE_IDLE;
  s_tracker_countdown = 0;
  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
  if (s_tracker_action_layer) layer_mark_dirty(s_tracker_action_layer);
}

static void stop_tracker_recording(void) {
  if (s_tracker_state != TRACKER_STATE_RECORDING) return;

  s_tracker_state = TRACKER_STATE_SUMMARY;
  tracker_bank_turn();
  APP_LOG(APP_LOG_LEVEL_INFO,
          "tracker: %u metric samples, %u blanked (vibe), %u clipped, %u stored",
          (unsigned)s_tracker_metric_samples, (unsigned)s_tracker_blanked_samples,
          (unsigned)s_tracker_clipped_samples, (unsigned)s_tracker_sample_count);
  // Safe here: state is already SUMMARY, so the handler ignores what follows.
  vibes_double_pulse();

  if (s_tracker_timer) {
    app_timer_cancel(s_tracker_timer);
    s_tracker_timer = NULL;
  }

  if (s_tracker_sample_count > 0 && s_tracker_raw_samples) {
    uint8_t target_pts = TRACKER_SPARKLINE_POINTS;
    if (s_tracker_sample_count < target_pts) target_pts = (uint8_t)s_tracker_sample_count;
    s_tracker_sparkline_count = target_pts;

    for (uint8_t i = 0; i < target_pts; i++) {
      uint32_t idx = (i * (s_tracker_sample_count - 1)) / (target_pts - 1 > 0 ? target_pts - 1 : 1);
      int32_t sx = s_tracker_raw_samples[idx].x;
      int32_t sy = s_tracker_raw_samples[idx].y;
      int32_t sz = s_tracker_raw_samples[idx].z;
      s_tracker_sparkline[i] = (int16_t)int_sqrt(sx * sx + sy * sy + sz * sz);
    }
  }

  start_tracker_sync_to_phone();

  if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
  if (s_tracker_main_layer) layer_mark_dirty(s_tracker_main_layer);
  if (s_tracker_action_layer) layer_mark_dirty(s_tracker_action_layer);
}

static void tracker_header_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  char left_buf[48];
  char right_buf[32];
  left_buf[0] = '\0';
  right_buf[0] = '\0';

  if (s_tracker_state == TRACKER_STATE_IDLE) {
    snprintf(left_buf, sizeof(left_buf), "[LOGGER] %s", s_tracker_ride_name);
    snprintf(right_buf, sizeof(right_buf), "Ready");
  } else if (s_tracker_state == TRACKER_STATE_COUNTDOWN) {
    snprintf(left_buf, sizeof(left_buf), "%s", s_tracker_ride_name);
    snprintf(right_buf, sizeof(right_buf), "Get set");
  } else if (s_tracker_state == TRACKER_STATE_RECORDING) {
    snprintf(left_buf, sizeof(left_buf), "REC");
    int min = s_tracker_elapsed_sec / 60;
    int sec = s_tracker_elapsed_sec % 60;
    snprintf(right_buf, sizeof(right_buf), "%02d:%02d/5m", min, sec);
  } else if (s_tracker_state == TRACKER_STATE_SUMMARY) {
    snprintf(left_buf, sizeof(left_buf), "%s", s_tracker_ride_name);
    if (s_tracker_sync_state == TRACKER_SYNC_SENDING_START || s_tracker_sync_state == TRACKER_SYNC_SENDING_CHUNKS) {
      snprintf(right_buf, sizeof(right_buf), "Syncing...");
    } else if (s_tracker_sync_state == TRACKER_SYNC_DONE) {
      snprintf(right_buf, sizeof(right_buf), "Saved");
    } else {
      snprintf(right_buf, sizeof(right_buf), "Summary");
    }
  }

  graphics_context_set_text_color(ctx, GColorWhite);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);

  graphics_draw_text(ctx, left_buf, font,
      GRect(bounds.origin.x + 4, bounds.origin.y + 1, bounds.size.w - 74, bounds.size.h - 2),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  graphics_draw_text(ctx, right_buf, font,
      GRect(bounds.origin.x + bounds.size.w - 70, bounds.origin.y + 1, 66, bounds.size.h - 2),
      GTextOverflowModeFill, GTextAlignmentRight, NULL);
}

static void tracker_main_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  if (s_tracker_state == TRACKER_STATE_IDLE) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    char g_str[16];
    format_g_force(g_str, sizeof(g_str), s_tracker_live_g);

    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "RIDE G-TRACKER", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
        GRect(bounds.origin.x, bounds.origin.y + 8, bounds.size.w, 22),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack));
    graphics_draw_text(ctx, g_str, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
        GRect(bounds.origin.x, bounds.origin.y + 32, bounds.size.w, 32),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_draw_text(ctx, "Current Resting G-Force", fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(bounds.origin.x, bounds.origin.y + 64, bounds.size.w, 18),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "Press SELECT to Start\n(Max 5m duration)", fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x + 8, bounds.origin.y + 86, bounds.size.w - 16, 36),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

  } else if (s_tracker_state == TRACKER_STATE_COUNTDOWN) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "GET READY", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
        GRect(bounds.origin.x, bounds.origin.y + 6, bounds.size.w, 22),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    char count_buf[4];
    snprintf(count_buf, sizeof(count_buf), "%d", (int)s_tracker_countdown);
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
    graphics_draw_text(ctx, count_buf, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD),
        GRect(bounds.origin.x, bounds.origin.y + 28, bounds.size.w, 46),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "Hands on the restraints\nRecording starts at 0",
        fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(bounds.origin.x + 6, bounds.origin.y + 78, bounds.size.w - 12, 36),
        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);

  } else if (s_tracker_state == TRACKER_STATE_RECORDING) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    char g_str[16];
    format_g_force(g_str, sizeof(g_str), s_tracker_live_g);

    GColor g_color = PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack);
    const char *badge_text = "LIVE G-FORCE";

    if (s_tracker_live_g < 500) {
      g_color = PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack);
      badge_text = "AIRTIME!";
    } else if (s_tracker_live_g > 3000) {
      g_color = PBL_IF_COLOR_ELSE(GColorRed, GColorBlack);
      badge_text = "EXTREME G!";
    } else if (s_tracker_live_g > 2000) {
      g_color = PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorBlack);
      badge_text = "HIGH G-FORCE";
    }

    graphics_context_set_text_color(ctx, g_color);
    graphics_draw_text(ctx, badge_text, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x, bounds.origin.y + 4, bounds.size.w, 18),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_draw_text(ctx, g_str, fonts_get_system_font(FONT_KEY_BITHAM_30_BLACK),
        GRect(bounds.origin.x, bounds.origin.y + 20, bounds.size.w, 36),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    int bar_x = bounds.origin.x + 12;
    int bar_y = bounds.origin.y + 60;
    int bar_w = bounds.size.w - 24;
    int bar_h = 10;

    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
    graphics_fill_rect(ctx, GRect(bar_x, bar_y, bar_w, bar_h), 2, GCornersAll);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_round_rect(ctx, GRect(bar_x, bar_y, bar_w, bar_h), 2);

    int fill_w = (s_tracker_live_g * (bar_w - 2)) / 5000;
    if (fill_w < 0) fill_w = 0;
    if (fill_w > bar_w - 2) fill_w = bar_w - 2;

    if (fill_w > 0) {
      graphics_context_set_fill_color(ctx, g_color);
      graphics_fill_rect(ctx, GRect(bar_x + 1, bar_y + 1, fill_w, bar_h - 2), 1, GCornersAll);
    }

    int tick_x = bar_x + (1000 * (bar_w - 2)) / 5000;
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_line(ctx, GPoint(tick_x, bar_y), GPoint(tick_x, bar_y + bar_h));

    char ribbon_buf[48];
    int air_sec = s_tracker_airtime_ms / 1000;
    int air_dec = (s_tracker_airtime_ms % 1000) / 100;
    char max_g_buf[16];
    format_g_force(max_g_buf, sizeof(max_g_buf), tracker_summary_max_g());

    snprintf(ribbon_buf, sizeof(ribbon_buf), "Max:%s | Air:%d.%ds", max_g_buf, air_sec, air_dec);
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, ribbon_buf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x + 4, bounds.origin.y + 76, bounds.size.w - 8, 20),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

  } else if (s_tracker_state == TRACKER_STATE_SUMMARY) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    char max_buf[16], min_buf[16];
    format_g_force(max_buf, sizeof(max_buf), tracker_summary_max_g());
    format_g_force(min_buf, sizeof(min_buf), tracker_summary_min_g());

    int air_sec = s_tracker_airtime_ms / 1000;
    int air_dec = (s_tracker_airtime_ms % 1000) / 100;
    int best_air_sec = s_tracker_max_airtime_ms / 1000;
    int best_air_dec = (s_tracker_max_airtime_ms % 1000) / 100;

    int dur_min = s_tracker_elapsed_sec / 60;
    int dur_sec = s_tracker_elapsed_sec % 60;

    // The watch shows the headline numbers; avg G, roughness, high-G time and
    // total rotation all still go to the phone and into the exported CSV/JSON,
    // which is where anyone actually comparing rides will be looking.
    char row1[48], row2[48], row3[48];
    snprintf(row1, sizeof(row1), "Max %s  Min %s", max_buf, min_buf);
    snprintf(row2, sizeof(row2), "Air %d.%ds (%d) best %d.%ds",
             air_sec, air_dec, s_tracker_airtime_hills, best_air_sec, best_air_dec);
    // "Turns", not "Inversions" — see the sensor note at the top of this
    // section. Truncation is called out because the summary covers the whole
    // ride while the exported telemetry stops at the buffer.
    snprintf(row3, sizeof(row3), "%d turns  %d:%02d%s",
             s_tracker_turn_count, dur_min, dur_sec,
             s_tracker_buffer_full ? " (part)" : "");

    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, row1, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x + 4, bounds.origin.y + 1, bounds.size.w - 8, 15),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_draw_text(ctx, row2, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x + 4, bounds.origin.y + 15, bounds.size.w - 8, 15),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    graphics_draw_text(ctx, row3, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(bounds.origin.x + 4, bounds.origin.y + 29, bounds.size.w - 8, 15),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    int graph_x = bounds.origin.x + 6;
    int graph_y = bounds.origin.y + 47;
    int graph_w = bounds.size.w - 12;
    int graph_h = bounds.size.h - 49;

    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
    graphics_fill_rect(ctx, GRect(graph_x, graph_y, graph_w, graph_h), 2, GCornersAll);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_draw_round_rect(ctx, GRect(graph_x, graph_y, graph_w, graph_h), 2);

    int ref_y = graph_y + graph_h - (1000 * graph_h) / 5000;
    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    for (int x = graph_x + 2; x < graph_x + graph_w - 2; x += 4) {
      graphics_draw_pixel(ctx, GPoint(x, ref_y));
    }

    if (s_tracker_sparkline_count >= 2) {
      for (uint8_t i = 1; i < s_tracker_sparkline_count; i++) {
        int x0 = graph_x + 2 + ((i - 1) * (graph_w - 4)) / (s_tracker_sparkline_count - 1);
        int x1 = graph_x + 2 + (i * (graph_w - 4)) / (s_tracker_sparkline_count - 1);

        int16_t mg0 = s_tracker_sparkline[i - 1];
        int16_t mg1 = s_tracker_sparkline[i];

        int y0 = graph_y + graph_h - 2 - (mg0 * (graph_h - 4)) / 5000;
        int y1 = graph_y + graph_h - 2 - (mg1 * (graph_h - 4)) / 5000;

        if (y0 < graph_y + 2) y0 = graph_y + 2;
        if (y0 > graph_y + graph_h - 2) y0 = graph_y + graph_h - 2;
        if (y1 < graph_y + 2) y1 = graph_y + 2;
        if (y1 > graph_y + graph_h - 2) y1 = graph_y + graph_h - 2;

        if (mg1 < 800) {
          graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack));
        } else if (mg1 > 2500) {
          graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorBlack));
        } else {
          graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGreen, GColorBlack));
        }
        graphics_draw_line(ctx, GPoint(x0, y0), GPoint(x1, y1));
      }
    }
  }
}

static void tracker_action_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  const char *action_text = "Press SELECT to Start";
  if (s_tracker_state == TRACKER_STATE_COUNTDOWN) {
    action_text = "SELECT to Cancel";
  } else if (s_tracker_state == TRACKER_STATE_RECORDING) {
    action_text = "Stop Recording (SELECT)";
  } else if (s_tracker_state == TRACKER_STATE_SUMMARY) {
    action_text = "Record Again (SELECT)";
  }

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, action_text, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
      GRect(bounds.origin.x, bounds.origin.y + 1, bounds.size.w, bounds.size.h - 2),
      GTextOverflowModeFill, GTextAlignmentCenter, NULL);
}

static void tracker_select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_tracker_state == TRACKER_STATE_IDLE ||
      s_tracker_state == TRACKER_STATE_SUMMARY) {
    start_tracker_countdown();
  } else if (s_tracker_state == TRACKER_STATE_COUNTDOWN) {
    cancel_tracker_countdown();
  } else if (s_tracker_state == TRACKER_STATE_RECORDING) {
    stop_tracker_recording();
  }
}

static void tracker_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, tracker_select_click_handler);
}

#if PBL_API_EXISTS(tap_recognizer_create)
static void tracker_tap_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  if (event != RecognizerEvent_Completed) return;

  if (s_tracker_state == TRACKER_STATE_IDLE ||
      s_tracker_state == TRACKER_STATE_SUMMARY) {
    start_tracker_countdown();
  } else if (s_tracker_state == TRACKER_STATE_COUNTDOWN) {
    cancel_tracker_countdown();
  } else if (s_tracker_state == TRACKER_STATE_RECORDING) {
    stop_tracker_recording();
  }
}

static void tracker_swipe_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (s_touch_locked) return;
  if (event != RecognizerEvent_Completed) return;
  window_stack_pop(true);
}
#endif

static void tracker_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  window_set_click_config_provider(window, tracker_click_config_provider);

#if PBL_API_EXISTS(tap_recognizer_create)
  Recognizer *tap = tap_recognizer_create(tracker_tap_handler, NULL);
  Recognizer *swipe = swipe_recognizer_create(tracker_swipe_handler, NULL,
      SwipeDirection_Right);
  recognizer_set_simultaneous_with(tap, always_simultaneous);
  recognizer_set_simultaneous_with(swipe, always_simultaneous);
  window_attach_recognizer(window, tap);
  window_attach_recognizer(window, swipe);
  window_set_touch_bridge_disabled(window, true);
#endif

#if defined(PBL_ROUND)
  int diameter = bounds.size.w;
  int square_side = (diameter * 707) / 1000;
  GRect area = GRect((bounds.size.w - square_side) / 2, (bounds.size.h - square_side) / 2,
                      square_side, square_side);
#else
  GRect area = bounds;
#endif

  s_tracker_header_layer = layer_create(GRect(area.origin.x, area.origin.y, area.size.w, 20));
  layer_set_update_proc(s_tracker_header_layer, tracker_header_update_proc);
  layer_add_child(root, s_tracker_header_layer);

  s_tracker_action_layer = layer_create(GRect(area.origin.x, area.origin.y + area.size.h - 22,
                                              area.size.w, 22));
  layer_set_update_proc(s_tracker_action_layer, tracker_action_update_proc);
  layer_add_child(root, s_tracker_action_layer);

  s_tracker_main_layer = layer_create(GRect(area.origin.x, area.origin.y + 20, area.size.w,
                                            area.size.h - 20 - 22));
  layer_set_update_proc(s_tracker_main_layer, tracker_main_update_proc);
  layer_add_child(root, s_tracker_main_layer);

  // Subscribe FIRST, then set the rate. The sampling rate is a property of an
  // active accel session, so setting it before subscribing is a no-op — and
  // the call returns a status this code used to throw away. With the rate not
  // taking, the service ran at whatever the default was, which is exactly the
  // kind of thing the old hardcoded "25Hz = 40ms per sample" assumption could
  // never have revealed.
  accel_data_service_subscribe(TRACKER_SAMPLES_PER_UPDATE, tracker_accel_data_handler);
  int rate_res = accel_service_set_sampling_rate(ACCEL_SAMPLING_100HZ);
  if (rate_res != 0) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "accel rate set failed (%d); running at default", rate_res);
  }

  // 5 degrees. Coarse, but it is the compass service's own event threshold, so
  // heading arrives as sparse jumps rather than a smooth signal — which is why
  // the turn detector accumulates angle instead of requiring consecutive ticks.
  compass_service_set_heading_filter(TRIG_MAX_ANGLE / 72);
  compass_service_subscribe(tracker_compass_handler);
}

static void tracker_window_unload(Window *window) {
  accel_data_service_unsubscribe();
  compass_service_unsubscribe();

  if (s_tracker_timer) {
    app_timer_cancel(s_tracker_timer);
    s_tracker_timer = NULL;
  }

  // If sync is not actively in progress, free samples immediately.
  // If sync is still streaming chunks to the phone in the background, leave
  // the buffer and timer intact — tracker_free_samples_if_unused(), called
  // from outbox_sent_callback when the sync finishes, frees them then.
  if (s_tracker_sync_state == TRACKER_SYNC_IDLE || s_tracker_sync_state == TRACKER_SYNC_DONE) {
    if (s_tracker_sync_timer) {
      app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = NULL;
    }
    if (s_tracker_raw_samples) {
      free(s_tracker_raw_samples);
      s_tracker_raw_samples = NULL;
    }
    s_tracker_allocated_capacity = 0;
    s_tracker_sample_count = 0;
    s_tracker_sync_state = TRACKER_SYNC_IDLE;
  }

  layer_destroy(s_tracker_header_layer);
  s_tracker_header_layer = NULL;
  layer_destroy(s_tracker_main_layer);
  s_tracker_main_layer = NULL;
  layer_destroy(s_tracker_action_layer);
  s_tracker_action_layer = NULL;

  window_destroy(window);
  s_tracker_window = NULL;
  s_tracker_ride_id = -1;
}

static void open_tracker_window(void) {
  if (s_detail_ride_id < 0) return;

  s_tracker_ride_id = s_detail_ride_id;
  strncpy(s_tracker_ride_name, s_detail_name, NAME_BUF_LEN - 1);
  s_tracker_ride_name[NAME_BUF_LEN - 1] = '\0';
  s_tracker_state = TRACKER_STATE_IDLE;
  s_tracker_live_g = 1000;
  s_tracker_max_g = 1000;
  s_tracker_min_g = 1000;
  s_tracker_airtime_ms = 0;
  s_tracker_airtime_hills = 0;
  s_tracker_elapsed_sec = 0;

  // Deliberately NOT resetting s_tracker_sample_count here. Backing out of
  // the tracker leaves an unfinished sync streaming in the background (see
  // tracker_window_unload), and that sync reads the count to know where the
  // buffer ends. Zeroing it on re-entry made send_next_tracker_chunk take its
  // "nothing to send" path: it jumped to TRACKER_SYNC_DONE without ever
  // sending RideLogEnd, so the phone kept a half-filled session forever and
  // never uploaded it. Nothing in the IDLE view reads the count anyway, and
  // begin_tracker_recording() zeroes it at the point it's actually safe to.

  s_tracker_window = window_create();
  window_set_background_color(s_tracker_window, GColorWhite);
  window_set_window_handlers(s_tracker_window, (WindowHandlers) {
    .load   = tracker_window_load,
    .unload = tracker_window_unload,
  });
  window_stack_push(s_tracker_window, true);
}

// ---------------------------------------------------------------------------
// AppMessage receiving

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *t_rides_data = dict_find(iter, MESSAGE_KEY_RidesData);
  if (t_rides_data && t_rides_data->type == TUPLE_BYTE_ARRAY) {
    const uint8_t *bytes = t_rides_data->value->data;
    uint32_t len = t_rides_data->length;
    if (len >= 1) {
      int count = bytes[0];
      if (count > MAX_RIDES) count = MAX_RIDES;
      uint32_t offset = 1;
      int valid_rides = 0;
      for (int i = 0; i < count && offset < len; i++) {
        if (offset + 12 > len) break;
        int32_t id = (int32_t)(((uint32_t)bytes[offset] << 24) | ((uint32_t)bytes[offset + 1] << 16) | ((uint32_t)bytes[offset + 2] << 8) | (uint32_t)bytes[offset + 3]);
        offset += 4;
        int16_t wait = (int16_t)(((uint16_t)bytes[offset] << 8) | (uint16_t)bytes[offset + 1]);
        offset += 2;
        int32_t dist = (int32_t)(((uint32_t)bytes[offset] << 24) | ((uint32_t)bytes[offset + 1] << 16) | ((uint32_t)bytes[offset + 2] << 8) | (uint32_t)bytes[offset + 3]);
        offset += 4;
        uint8_t flags = bytes[offset++];
        uint8_t name_len = bytes[offset++];
        if (offset + name_len > len) break;

        s_rides[i].ride_id = id;
        s_rides[i].wait_minutes = wait;
        s_rides[i].distance_m = dist;
        s_rides[i].flags = flags;
        uint8_t copy_len = name_len < (NAME_BUF_LEN - 1) ? name_len : (NAME_BUF_LEN - 1);
        memcpy(s_rides[i].name, &bytes[offset], copy_len);
        s_rides[i].name[copy_len] = '\0';
        offset += name_len;
        valid_rides++;

        if (s_rides[i].ride_id == s_detail_ride_id) {
          s_detail_wait = s_rides[i].wait_minutes;
          update_detail_header();
          if (s_detail_alert_layer) layer_mark_dirty(s_detail_alert_layer);
          if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
        }
        check_alert_for_ride(s_rides[i].ride_id, s_rides[i].wait_minutes);
      }

      s_ride_count = valid_rides;
      s_pending_total = 0;
      s_show_error = false;
      s_is_refreshing = false;
      recompute_order();
      update_grid_layout();
      update_header();
      if (window_stack_get_top_window() == s_main_window) {
        layer_mark_dirty(s_grid_content_layer);
      }
      save_cached_rides();
    }
    return;
  }

  Tuple *t_total = dict_find(iter, MESSAGE_KEY_TotalCount);
  if (t_total) {
    // Deliberately does NOT reset s_ride_count/s_cursor here: the current
    // tiles keep drawing while the refreshed list streams in over the top
    // (each ride overwrites its slot in place as it arrives, in order).
    // Resetting up front made every silent 5-minute background refresh
    // flash "Loading queue times..." and warp the cursor back to the first
    // tile. See s_pending_total's declaration for how a *shorter* new list
    // still shrinks correctly once its last ride lands.
    s_pending_total = t_total->value->int32;
    s_show_error = false;
    return;
  }

  Tuple *t_idx  = dict_find(iter, MESSAGE_KEY_RideIndex);
  Tuple *t_id   = dict_find(iter, MESSAGE_KEY_RideId);
  Tuple *t_name = dict_find(iter, MESSAGE_KEY_RideName);
  Tuple *t_wait = dict_find(iter, MESSAGE_KEY_RideWait);
  if (t_idx && t_id && t_name && t_wait) {
    int idx = t_idx->value->int32;
    if (idx >= 0 && idx < MAX_RIDES) {
      Tuple *t_dist = dict_find(iter, MESSAGE_KEY_RideDistance);
      s_rides[idx].ride_id = t_id->value->int32;
      strncpy(s_rides[idx].name, t_name->value->cstring, NAME_BUF_LEN - 1);
      s_rides[idx].name[NAME_BUF_LEN - 1] = '\0';
      s_rides[idx].wait_minutes = (int16_t)t_wait->value->int32;
      s_rides[idx].distance_m = t_dist ? t_dist->value->int32 : -1;
      if (idx + 1 > s_ride_count) s_ride_count = idx + 1;
      // Last announced ride has arrived: snap to the new total, which is
      // what actually shrinks the list when the refresh carried fewer rides
      // than are currently showing (park switch, rides deselected) — until
      // then the old tail keeps drawing rather than blanking out.
      if (s_pending_total > 0 && idx + 1 >= s_pending_total) {
        s_ride_count = s_pending_total;
        s_pending_total = 0;
      }
      s_show_error = false;
      recompute_order();
      update_grid_layout();
      update_header();
      layer_mark_dirty(s_grid_content_layer);
      // If this ride's detail view is open right now, its header wait and
      // the alert band's met/waiting coloring (and the graph's threshold
      // line color) are all driven by s_detail_wait — without this they
      // kept showing the stale wait from when the view was opened, so the
      // alert could buzz (check_alert_for_ride below uses fresh data)
      // while the band still showed "armed, waiting". The detail view is
      // exactly where someone sits watching for that alert to fire.
      if (s_rides[idx].ride_id == s_detail_ride_id) {
        s_detail_wait = s_rides[idx].wait_minutes;
        update_detail_header();
        if (s_detail_alert_layer) layer_mark_dirty(s_detail_alert_layer);
        if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
      }
      check_alert_for_ride(s_rides[idx].ride_id, s_rides[idx].wait_minutes);
    }
    return;
  }

  Tuple *t_err = dict_find(iter, MESSAGE_KEY_ErrorMsg);
  if (t_err) {
    // Only surface the error full-screen if there's no cached data to keep
    // showing; a failed background refresh with existing tiles stays silent.
    if (s_ride_count == 0) {
      strncpy(s_error_buf, t_err->value->cstring, sizeof(s_error_buf) - 1);
      s_error_buf[sizeof(s_error_buf) - 1] = '\0';
      s_show_error = true;
      layer_mark_dirty(s_grid_content_layer);
    }
    s_is_refreshing = false;
    update_header();
    APP_LOG(APP_LOG_LEVEL_ERROR, "CoasterWatch error: %s", t_err->value->cstring);
    return;
  }

  Tuple *t_gdata = dict_find(iter, MESSAGE_KEY_GraphData);
  if (t_gdata) {
    int total_points = t_gdata->length / 3;
    if (total_points > MAX_GRAPH_POINTS) total_points = MAX_GRAPH_POINTS;
    const uint8_t *bytes = t_gdata->value->data;
    for (int i = 0; i < total_points; i++) {
      uint8_t w = bytes[i * 3];
      s_graph_points[i] = (w == 255) ? -1 : (int16_t)w;
      s_graph_minute_of_day[i] = (int16_t)((bytes[i * 3 + 1] << 8) | bytes[i * 3 + 2]);
    }
    s_graph_count = total_points;
    s_graph_expected_count = total_points;
    s_graph_loading = false;
    s_graph_show_error = false;
    if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
    return;
  }

  Tuple *t_gcount = dict_find(iter, MESSAGE_KEY_GraphCount);
  if (t_gcount) {
    s_graph_count = 0;
    s_graph_expected_count = t_gcount->value->int32;
    s_graph_loading = true;
    s_graph_show_error = false;
    if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
    return;
  }

  Tuple *t_gi = dict_find(iter, MESSAGE_KEY_GraphIndex);
  Tuple *t_gw = dict_find(iter, MESSAGE_KEY_GraphWait);
  Tuple *t_gm = dict_find(iter, MESSAGE_KEY_GraphMinuteOfDay);
  if (t_gi && t_gw && t_gm) {
    int gi = t_gi->value->int32;
    // Only accept a point that exactly fills the next slot (gi == count).
    // pkjs normally streams strictly in order, but if the user opens another
    // ride's detail view before the previous one's points finished sending,
    // a straggler from the old stream can still arrive after this one's
    // GraphCount reset. Accepting anything other than the exact next index
    // (a stale duplicate, or a gap from a dropped point) risks s_graph_count
    // claiming a contiguous run that's actually got an untouched — and
    // therefore still holding the *previous* ride's — slot in the middle.
    if (gi == s_graph_count && gi < MAX_GRAPH_POINTS) {
      s_graph_points[gi] = (int16_t)t_gw->value->int32;
      s_graph_minute_of_day[gi] = (int16_t)t_gm->value->int32;
      s_graph_count = gi + 1;
      // Stay in "loading" (and skip the redraw) until every expected point
      // has arrived, so the graph renders exactly once with its final
      // scale/shape rather than visibly rescaling itself point by point.
      if (s_graph_expected_count > 0 && s_graph_count >= s_graph_expected_count) {
        s_graph_loading = false;
        if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
      }
    }
    return;
  }

  Tuple *t_gerr = dict_find(iter, MESSAGE_KEY_GraphError);
  if (t_gerr) {
    strncpy(s_graph_error_buf, t_gerr->value->cstring, sizeof(s_graph_error_buf) - 1);
    s_graph_error_buf[sizeof(s_graph_error_buf) - 1] = '\0';
    s_graph_show_error = true;
    s_graph_loading = false;
    if (s_detail_graph_layer) layer_mark_dirty(s_detail_graph_layer);
    return;
  }

  Tuple *t_c0 = dict_find(iter, MESSAGE_KEY_BandColor0);
  if (t_c0) {
    Tuple *t_t1 = dict_find(iter, MESSAGE_KEY_BandThreshold1);
    Tuple *t_t2 = dict_find(iter, MESSAGE_KEY_BandThreshold2);
    Tuple *t_c1 = dict_find(iter, MESSAGE_KEY_BandColor1);
    Tuple *t_c2 = dict_find(iter, MESSAGE_KEY_BandColor2);
    Tuple *t_ca = dict_find(iter, MESSAGE_KEY_AlertColor);
    if (t_t1 && t_t2 && t_c1 && t_c2 && t_ca) {
      s_band_config.t1 = (int16_t)t_t1->value->int32;
      s_band_config.t2 = (int16_t)t_t2->value->int32;
      s_band_config.band_color[0] = (GColor){ .argb = (uint8_t)t_c0->value->int32 };
      s_band_config.band_color[1] = (GColor){ .argb = (uint8_t)t_c1->value->int32 };
      s_band_config.band_color[2] = (GColor){ .argb = (uint8_t)t_c2->value->int32 };
      s_band_config.alert_color = (GColor){ .argb = (uint8_t)t_ca->value->int32 };
      Tuple *t_vibe = dict_find(iter, MESSAGE_KEY_VibePattern);
      if (t_vibe) s_band_config.vibe_pattern = (int8_t)t_vibe->value->int32;
      save_band_config();
      layer_mark_dirty(s_grid_content_layer);
      if (s_detail_alert_layer) layer_mark_dirty(s_detail_alert_layer);
    }
    return;
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Inbox dropped: %d", (int)reason);
}

static int32_t s_pending_graph_retry_id = 0;

static void retry_request_refresh_callback(void *data) {
  request_refresh();
}

static void retry_request_graph_callback(void *data) {
  // Only still relevant if the detail window is still open on the same
  // ride the failed send was for — the graph response protocol has no
  // ride id of its own (just index/wait/minute), so a stale retry firing
  // after the user has since switched rides (or backed out entirely, which
  // resets s_detail_ride_id to -1) would get misread as fresh data for
  // whatever's open now, corrupting that ride's graph with this one's.
  if (s_pending_graph_retry_id != s_detail_ride_id) return;
  request_graph(s_pending_graph_retry_id);
}

static void tracker_chunk_timer_callback(void *data) {
  send_next_tracker_chunk(NULL);
}

// Releases the raw-sample buffer (up to ~20KB — by far this app's largest
// allocation) once nothing needs it any more: the sync has finished and the
// tracker window is closed. Backing out mid-sync deliberately keeps the buffer
// alive so the transfer can finish, and this is what reclaims it afterwards;
// without it that memory stayed leaked for the rest of the app's life. While
// the window is still open the buffer stays put, so "Record Again" doesn't
// have to gamble on a fresh allocation succeeding.
static void tracker_free_samples_if_unused(void) {
  if (s_tracker_window) return;
  if (s_tracker_sync_state != TRACKER_SYNC_DONE &&
      s_tracker_sync_state != TRACKER_SYNC_IDLE &&
      s_tracker_sync_state != TRACKER_SYNC_FAILED) return;
  if (s_tracker_sync_timer) {
    app_timer_cancel(s_tracker_sync_timer);
    s_tracker_sync_timer = NULL;
  }
  if (s_tracker_raw_samples) {
    free(s_tracker_raw_samples);
    s_tracker_raw_samples = NULL;
  }
  s_tracker_allocated_capacity = 0;
  s_tracker_sample_count = 0;
  s_tracker_sync_state = TRACKER_SYNC_IDLE;
}

static void outbox_sent_callback(DictionaryIterator *iter, void *context) {
  if (s_tracker_sync_state == TRACKER_SYNC_SENDING_START) {
    s_tracker_sync_state = TRACKER_SYNC_SENDING_CHUNKS;
    if (s_tracker_sync_timer) {
      app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = NULL;
    }
    s_tracker_sync_timer = app_timer_register(30, tracker_chunk_timer_callback, NULL);
  } else if (s_tracker_sync_state == TRACKER_SYNC_SENDING_CHUNKS) {
    if (s_tracker_sync_timer) {
      app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = NULL;
    }
    s_tracker_sync_timer = app_timer_register(30, tracker_chunk_timer_callback, NULL);
  } else if (s_tracker_sync_state == TRACKER_SYNC_SENDING_END) {
    s_tracker_sync_state = TRACKER_SYNC_DONE;
    if (s_tracker_header_layer) layer_mark_dirty(s_tracker_header_layer);
    tracker_free_samples_if_unused();
  }
}

static void outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox failed: %d", (int)reason);

  if (s_tracker_sync_state == TRACKER_SYNC_SENDING_CHUNKS ||
      s_tracker_sync_state == TRACKER_SYNC_SENDING_START ||
      s_tracker_sync_state == TRACKER_SYNC_SENDING_END) {
    if (s_tracker_sync_timer) {
      app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = NULL;
    }
    if (s_tracker_sync_state == TRACKER_SYNC_SENDING_START) {
      s_tracker_sync_timer = app_timer_register(250, tracker_sync_start_timer_callback, NULL);
    } else {
      s_tracker_sync_timer = app_timer_register(250, tracker_chunk_timer_callback, NULL);
    }
    return;
  }

  if (!iter) return;

  Tuple *t_refresh = dict_find(iter, MESSAGE_KEY_RequestRefresh);
  if (t_refresh) {
    app_timer_register(3000, retry_request_refresh_callback, NULL);
    return;
  }
  Tuple *t_graph = dict_find(iter, MESSAGE_KEY_RequestGraph);
  if (t_graph) {
    s_pending_graph_retry_id = t_graph->value->int32;
    app_timer_register(3000, retry_request_graph_callback, NULL);
  }
}

static void connection_handler(bool connected) {
  s_phone_connected = connected;
  update_header();

  if (connected) {
    if (s_tracker_sync_state == TRACKER_SYNC_SENDING_START) {
      if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = app_timer_register(100, tracker_sync_start_timer_callback, NULL);
    } else if (s_tracker_sync_state == TRACKER_SYNC_SENDING_CHUNKS || s_tracker_sync_state == TRACKER_SYNC_SENDING_END) {
      if (s_tracker_sync_timer) app_timer_cancel(s_tracker_sync_timer);
      s_tracker_sync_timer = app_timer_register(100, tracker_chunk_timer_callback, NULL);
    }
  }
}

// ---------------------------------------------------------------------------
// App lifecycle

static void main_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // A full-width black bar clips oddly at the very top of a round bezel, so
  // round platforms get a plain label instead of a banner — and skip the
  // separate clock layer entirely (see update_clock()'s comment).
  //
  // The header itself is also shifted down from y=0: right at the top of a
  // round display, the visible chord is much narrower than the full screen
  // width (the bezel obscures the corners — see
  // developer.repebble.com/guides/user-interfaces/round-app-ui/), so a
  // full-width, y=0 header clips its own text. Confirmed on-device/emulator
  // (chalk): the clock read ".s:25" instead of "23:25" before this offset.
#if defined(PBL_ROUND)
  static const int ROUND_HEADER_Y_OFFSET = 14;
#endif
  // s_scroll_frame is in root-layer (window) space — it positions the whole
  // scrollable viewport, inset on round platforms so it clears the bezel
  // regardless of which row is currently scrolled to the top/bottom edge.
  s_scroll_frame = GRect(0, HEADER_HEIGHT, bounds.size.w, bounds.size.h - HEADER_HEIGHT);
#if defined(PBL_ROUND)
  int inset_x = 20;
  int inset_top = 16;
  int inset_bottom = 34;
  s_scroll_frame = GRect(s_scroll_frame.origin.x + inset_x,
                          s_scroll_frame.origin.y + inset_top,
                          s_scroll_frame.size.w - 2 * inset_x,
                          s_scroll_frame.size.h - inset_top - inset_bottom);
#endif

  s_scroll_layer = scroll_layer_create(s_scroll_frame);
  scroll_layer_set_shadow_hidden(s_scroll_layer, true);

#if PBL_API_EXISTS(tap_recognizer_create)
  s_pull_indicator_layer = layer_create(GRect(0, 0, s_scroll_frame.size.w, 70));
  layer_set_update_proc(s_pull_indicator_layer, pull_indicator_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_pull_indicator_layer);
#endif

  s_grid_content_layer = layer_create(GRect(0, 0, s_scroll_frame.size.w, s_scroll_frame.size.h));
  layer_set_update_proc(s_grid_content_layer, grid_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_grid_content_layer);
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));

#if defined(PBL_ROUND)
  s_clock_layer = NULL;
  s_header_layer = layer_create(GRect(0, ROUND_HEADER_Y_OFFSET, bounds.size.w, HEADER_HEIGHT));
#else
  s_clock_layer = layer_create(GRect(0, 0, HEADER_CLOCK_WIDTH, HEADER_HEIGHT));
  layer_set_update_proc(s_clock_layer, clock_update_proc);
  layer_add_child(root, s_clock_layer);

  // Full remaining width: the background fill needs to reach the screen's
  // true right edge (see header_update_proc for how the text itself still
  // gets an inset from it, without shrinking the fill to match).
  s_header_layer = layer_create(GRect(HEADER_CLOCK_WIDTH, 0, bounds.size.w - HEADER_CLOCK_WIDTH, HEADER_HEIGHT));
#endif
  layer_set_update_proc(s_header_layer, header_update_proc);
  layer_add_child(root, s_header_layer);

  tick_timer_service_subscribe(MINUTE_UNIT, clock_tick_handler);
  update_clock();
  // Deliberately not using scroll_layer_set_click_config_onto_window(): that
  // wires UP/DOWN straight to raw pixel scrolling, which would bypass our
  // own tile-cursor model. Our click_config_provider drives scrolling
  // manually instead, to keep the highlighted tile in view.

  update_grid_layout();

#if PBL_API_EXISTS(tap_recognizer_create)
  // The window owns attached recognizers and destroys them on unload, so
  // there's nothing to clean up here. Disabling the system touch bridge
  // stops it from ALSO synthesizing button presses from the same taps/swipes
  // our own recognizers just handled.
  Recognizer *tap = tap_recognizer_create(main_tap_handler, NULL);
  Recognizer *pan = pan_recognizer_create(main_pan_handler, NULL, PanAxis_Vertical);
  recognizer_set_simultaneous_with(tap, always_simultaneous);
  recognizer_set_simultaneous_with(pan, always_simultaneous);
  window_attach_recognizer(window, tap);
  window_attach_recognizer(window, pan);
  window_set_touch_bridge_disabled(window, true);
#endif

  update_header();
}

static void main_window_unload(Window *window) {
  tick_timer_service_unsubscribe();
#if PBL_API_EXISTS(tap_recognizer_create)
  if (s_bounce_anim) {
    animation_unschedule((Animation *)s_bounce_anim);
    s_bounce_anim = NULL;
  }
  if (s_pull_indicator_layer) layer_destroy(s_pull_indicator_layer);
#endif
  layer_destroy(s_grid_content_layer);
  scroll_layer_destroy(s_scroll_layer);
  layer_destroy(s_header_layer);
  if (s_clock_layer) layer_destroy(s_clock_layer);
}

static void init(void) {
  if (persist_exists(SETTINGS_SORT_KEY)) {
    int sm = persist_read_int(SETTINGS_SORT_KEY);
    if (sm >= 0 && sm < SORT_MODE_COUNT) {
      s_sort_mode = (SortMode)sm;
    }
  }
  load_alerts();
  load_band_config();
  load_cached_rides();
#if PBL_API_EXISTS(tap_recognizer_create)
  if (persist_exists(SETTINGS_TOUCH_LOCK_KEY)) {
    s_touch_locked = persist_read_bool(SETTINGS_TOUCH_LOCK_KEY);
  }
#endif

#ifdef PBL_COLOR
  s_ride_name_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_RIDE_NAME_FONT_16));
#endif

#if PBL_API_EXISTS(app_touch_navigation_enable)
  // Third-party apps are opt-out of touch by default; without this call it's
  // unclear from the SDK docs whether even our own recognizers receive
  // anything. Harmless to call unconditionally on touch-capable hardware.
  app_touch_navigation_enable(!s_touch_locked);
#endif

  s_main_window = window_create();
  window_set_background_color(s_main_window, GColorWhite);
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load   = main_window_load,
    .unload = main_window_unload,
  });
  window_set_click_config_provider(s_main_window, click_config_provider);
  window_stack_push(s_main_window, true);

  // Assume connected at launch rather than trusting peek() here: right at
  // app start it can transiently report false even when the phone link is
  // fine, showing a misleading "No phone" flash alongside the completely
  // normal "Loading queue times..." state. A genuine disconnect is still
  // caught almost immediately by the subscribed handler below.
  s_phone_connected = true;
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = connection_handler,
  });

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_register_outbox_sent(outbox_sent_callback);
  app_message_open(2048, 512);

  request_refresh();
  s_refresh_timer = app_timer_register(REFRESH_INTERVAL_MS, refresh_timer_callback, NULL);
}

static void deinit(void) {
  if (s_refresh_timer) app_timer_cancel(s_refresh_timer);
  window_destroy(s_main_window);
#ifdef PBL_COLOR
  fonts_unload_custom_font(s_ride_name_font);
#endif
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
