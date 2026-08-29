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
//    (hold, grid only) toggles sort order between queue time and distance.
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
// Fallback graph x-axis start (08:00) for when the phone hasn't sent a
// per-park peg yet (see s_graph_peg_minute) - the real peg is "30 min
// before this park's opening time", computed phone-side since that's where
// the park's actual schedule/timezone is known.
#define GRAPH_START_MINUTE (8 * 60)
#define TILE_COLS         2
#define NAME_BUF_LEN      24
#define HEADER_HEIGHT       18
#define HEADER_CLOCK_WIDTH  50
#define SETTINGS_SORT_KEY    1
#define SETTINGS_ALERTS_KEY  2
#define SETTINGS_BANDS_KEY   3
// queue-times.com updates its data every 5 minutes, so polling more often
// than that just burns battery/network for no fresher data.
#define REFRESH_INTERVAL_MS (5 * 60 * 1000)

#define MAX_ALERTS            20
#define ALERT_STEP_MINUTES     5
#define ALERT_MAX_MINUTES    120
#define ALERT_DEFAULT_MINUTES 15
#define ALERT_BAND_HEIGHT     44
// queue-times.com's terms require this attribution "somewhere prominent" —
// a full-width footer tile at the end of the ride list.
#define ATTRIBUTION_HEIGHT    34

typedef enum { SORT_TIME = 0, SORT_DISTANCE = 1 } SortMode;

typedef struct {
  int32_t ride_id;
  char    name[NAME_BUF_LEN];
  int16_t wait_minutes;   // -1 = closed
  int32_t distance_m;     // -1 = unknown
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
static TextLayer   *s_header_layer;
static TextLayer   *s_clock_layer;
static ScrollLayer *s_scroll_layer;
static Layer       *s_grid_content_layer;
static AppTimer    *s_refresh_timer;
static GRect        s_scroll_frame; // the scroll layer's frame, in window/root-layer space
#if PBL_API_EXISTS(tap_recognizer_create)
static int16_t      s_pan_base;     // committed scroll offset.y during a drag
#endif

static Window    *s_detail_window;
static TextLayer *s_detail_header_layer;
static Layer     *s_detail_graph_layer;
static Layer     *s_detail_alert_layer;

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
static bool     s_phone_connected = false;
static bool     s_show_error      = false;
static SortMode s_sort_mode       = SORT_TIME;

static char s_header_buf[40];
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
// -1 = not received yet (phone hasn't fetched a park schedule this session);
// falls back to GRAPH_START_MINUTE below. Otherwise the phone's own
// pre-computed "30 min before this park's opening time, converted to the
// phone's local wall clock" - see graphPegMinuteOfDay() in pkjs, which is
// where the actual park/phone timezone handling happens (the watch just
// plots whatever minute-of-day it's told, same as every other graph point).
static int16_t s_graph_peg_minute = -1;

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

static int compare_key(int a, int b) {
  if (s_sort_mode == SORT_DISTANCE) {
    int32_t da = s_rides[a].distance_m < 0 ? INT32_MAX : s_rides[a].distance_m;
    int32_t db = s_rides[b].distance_m < 0 ? INT32_MAX : s_rides[b].distance_m;
    if (da != db) return da < db ? -1 : 1;
    return 0;
  } else {
    int wa = s_rides[a].wait_minutes < 0 ? 9999 : s_rides[a].wait_minutes;
    int wb = s_rides[b].wait_minutes < 0 ? 9999 : s_rides[b].wait_minutes;
    if (wa != wb) return wa < wb ? -1 : 1;
    return 0;
  }
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
  if (s_cursor >= s_ride_count) s_cursor = s_ride_count > 0 ? s_ride_count - 1 : 0;
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

// Pebble apps can't invoke the watch's own system alert-vibe picker (that's
// a user-facing OS setting, not an exposed API) — these are our own custom
// VibePattern durations instead, just named in that same recognizable
// style. Index here is what travels over AppMessage (VibePattern key) and
// gets persisted in BandConfig.vibe_pattern — append, don't reorder, so a
// previously saved index keeps meaning the same pattern.
typedef struct {
  const uint32_t *durations;
  uint32_t num_segments;
} VibePatternPreset;

static const uint32_t s_vibe_standard[]  = {400, 200, 400, 200, 400};
static const uint32_t s_vibe_nudge[]     = {100, 100, 100};
static const uint32_t s_vibe_mario[]     = {60, 60, 60, 60, 60, 60, 180};
static const uint32_t s_vibe_heartbeat[] = {100, 150, 100, 400};

static const VibePatternPreset VIBE_PATTERNS[] = {
  { s_vibe_standard,  ARRAY_LENGTH(s_vibe_standard) },  // 0: Standard
  { s_vibe_nudge,     ARRAY_LENGTH(s_vibe_nudge) },     // 1: Nudge
  { s_vibe_mario,     ARRAY_LENGTH(s_vibe_mario) },     // 2: Mario
  { s_vibe_heartbeat, ARRAY_LENGTH(s_vibe_heartbeat) }, // 3: Heartbeat
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
  if (!battery.is_charging && battery.charge_percent <= 20) {
    interval = REFRESH_INTERVAL_MS * 3;
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
    static char s_clock_buf[8];
    time_t now = time(NULL);
    struct tm *tick_time = localtime(&now);
    strftime(s_clock_buf, sizeof(s_clock_buf),
             clock_is_24h_style() ? "%H:%M" : "%I:%M", tick_time);
    text_layer_set_text(s_clock_layer, s_clock_buf);
  } else {
    update_header();
  }
}

static void clock_tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_clock();
}

static void update_header(void) {
  char status[24];
  if (!s_phone_connected) {
    snprintf(status, sizeof(status), "No phone");
  } else if (s_ride_count == 0) {
    status[0] = '\0';
  } else {
    snprintf(status, sizeof(status), "Sort: %s",
             s_sort_mode == SORT_DISTANCE ? "Distance" : "Time");
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
  text_layer_set_text(s_header_layer, s_header_buf);
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

static GridMetrics compute_grid_metrics(void) {
  GridMetrics m;
  m.w = s_scroll_frame.size.w;
  m.h = s_scroll_frame.size.h;
  m.pad = 4;
  m.cols = tile_cols();
  int screen_rows = tile_rows();
  m.tile_w = (m.w - m.pad * (m.cols + 1)) / m.cols;
  m.tile_h = (m.h - m.pad * (screen_rows + 1)) / screen_rows;

  m.total_rows = (s_ride_count + m.cols - 1) / m.cols;
  if (m.total_rows < 1) m.total_rows = 1;
  m.content_h = m.pad + m.total_rows * (m.tile_h + m.pad) + ATTRIBUTION_HEIGHT + m.pad;
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

// Full-width footer below the last ride row.
static GRect attribution_rect(const GridMetrics *m) {
  int y = m->pad + m->total_rows * (m->tile_h + m->pad);
  return GRect(0, y, m->w, ATTRIBUTION_HEIGHT);
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

static void grid_update_proc(Layer *layer, GContext *ctx) {
  GridMetrics m = compute_grid_metrics();

  if (s_show_error || s_ride_count == 0) {
    const char *msg = s_show_error ? s_error_buf : "Loading queue times...";
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                        GRect(0, 0, m.w, m.h),
                        GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
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

    graphics_context_set_text_color(ctx, text_color);
    GRect name_rect = GRect(tile.origin.x + 2, tile.origin.y + 1,
                             tile.size.w - 4, tile.size.h - wait_h - dist_h - 2);
    graphics_draw_text(ctx, r->name, name_font, name_rect,
                        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

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
      GRect dist_rect = GRect(tile.origin.x, tile.origin.y + tile.size.h - dist_h - 1,
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
  graphics_draw_text(ctx, "Powered by Queue-Times.com", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      attr, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
}

static void open_detail_window(void);

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_cursor > 0) {
    s_cursor--;
    update_header();
    scroll_to_show_cursor(true);
    layer_mark_dirty(s_grid_content_layer);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_cursor < s_ride_count - 1) {
    s_cursor++;
    update_header();
    scroll_to_show_cursor(true);
    layer_mark_dirty(s_grid_content_layer);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  open_detail_window();
}

static void toggle_sort_mode(void) {
  s_sort_mode = (s_sort_mode == SORT_TIME) ? SORT_DISTANCE : SORT_TIME;
  persist_write_int(SETTINGS_SORT_KEY, s_sort_mode);
  recompute_order();
  update_header();
  layer_mark_dirty(s_grid_content_layer);
  vibes_short_pulse();
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  toggle_sort_mode();
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_long_click_handler, NULL);
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
  if (event != RecognizerEvent_Completed) return;
  GPoint p = tap_recognizer_get_tap_point(recognizer);
  int order_pos;
  if (hit_test_tile(p, &order_pos)) {
    vibes_short_pulse();
    s_cursor = order_pos;
    update_header();
    layer_mark_dirty(s_grid_content_layer);
    open_detail_window();
  }
}

// Vertical drag scrolls the list. Pattern per the SDK's own ScrollLayer +
// pan-recognizer example: a bare ScrollLayer doesn't scroll by touch on its
// own, so this drives it manually from a pan recognizer's delta.
static void main_pan_handler(const Recognizer *recognizer, RecognizerEvent event) {
  switch (event) {
    case RecognizerEvent_Updated: {
      GPoint d = pan_recognizer_get_delta_since_start(recognizer);
      scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, s_pan_base + d.y), false);
      break;
    }
    case RecognizerEvent_Completed:
      s_pan_base = scroll_layer_get_content_offset(s_scroll_layer).y;
      break;
    case RecognizerEvent_Cancelled:
      scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, s_pan_base), true);
      break;
    default:
      break;
  }
}

#endif // PBL_API_EXISTS(tap_recognizer_create)

// ---------------------------------------------------------------------------
// Detail window: per-ride graph

static void update_detail_header(void) {
  static char buf[40];
  if (s_detail_wait < 0) {
    snprintf(buf, sizeof(buf), "%s: Closed", s_detail_name);
  } else {
    snprintf(buf, sizeof(buf), "%s: %dm", s_detail_name, s_detail_wait);
  }
  text_layer_set_text(s_detail_header_layer, buf);
}

static void detail_graph_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  if (s_graph_show_error || s_graph_loading) {
    const char *msg = s_graph_show_error ? s_graph_error_buf : "Loading graph...";
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, msg, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                        bounds, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }

  if (s_graph_count < 2) {
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, "Not enough data\nrecorded yet today",
                        fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                        bounds, GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
    return;
  }

  int margin = 6;
  GRect area = GRect(bounds.origin.x + margin + 26, bounds.origin.y + margin,
                      bounds.size.w - 2 * margin - 26, bounds.size.h - 2 * margin - 14);

  // x-axis is pegged to 30 minutes before the park's own opening time
  // (s_graph_peg_minute, already converted to the phone's local wall clock —
  // see graphPegMinuteOfDay() in pkjs) rather than whichever minute the
  // earliest recorded sample happens to land on, so the graph reads the same
  // shape day to day instead of its start drifting with whenever the phone
  // first fetched today. Falls back to a fixed 08:00 if the phone hasn't
  // sent a peg yet, and further falls back to the old dynamic start if there
  // isn't yet 2+ samples at/after the peg (e.g. checking before the park
  // could plausibly be open) so the graph isn't left empty.
  int peg_minute = (s_graph_peg_minute >= 0) ? s_graph_peg_minute : GRAPH_START_MINUTE;
  int start_idx = s_graph_count;
  for (int i = 0; i < s_graph_count; i++) {
    if (s_graph_minute_of_day[i] >= peg_minute) { start_idx = i; break; }
  }
  bool pegged = (start_idx < s_graph_count) && (s_graph_count - start_idx >= 2);
  if (!pegged) start_idx = 0;
  int graph_start = pegged ? peg_minute : s_graph_minute_of_day[start_idx];
  int graph_end = s_graph_minute_of_day[s_graph_count - 1];
  if (graph_end <= graph_start) graph_end = graph_start + 1; // guard against a zero/negative span

  int16_t max_w = 10; // minimum scale span so a flat line isn't full-height
  for (int i = start_idx; i < s_graph_count; i++) {
    if (s_graph_points[i] > max_w) max_w = s_graph_points[i];
  }

  // Only show the threshold line while the alert is actually armed — with
  // it off, a threshold value isn't in effect, so a line/scale stretch for
  // it would just be confusing.
  AlertConfig *alert = find_alert(s_detail_ride_id);
  bool show_threshold = alert && alert->enabled;
  if (show_threshold && alert->threshold_min > max_w) max_w = alert->threshold_min;

  if (show_threshold) {
    int threshold_y = area.origin.y + area.size.h -
                       (area.size.h * alert->threshold_min) / max_w;
    // Same state-based coloring as the alert band below: vivid cerulean
    // while armed-but-waiting, the alert-met color once the wait actually
    // reaches it — one consistent signal, not a fixed color. B/W platforms
    // override to always-black: alert_band_colors()'s "armed" B/W fallback
    // is white, correct for a filled tile background, but invisible for a
    // thin line against this graph's white background.
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

  GPoint prev = GPointZero;
  bool has_prev = false;
  for (int i = start_idx; i < s_graph_count; i++) {
    int x = area.origin.x + (area.size.w * (s_graph_minute_of_day[i] - graph_start)) / (graph_end - graph_start);
    if (x < area.origin.x) x = area.origin.x;
    if (x > area.origin.x + area.size.w) x = area.origin.x + area.size.w;
    int w = s_graph_points[i] < 0 ? 0 : s_graph_points[i];
    int y = area.origin.y + area.size.h - (area.size.h * w) / max_w;
    GPoint p = GPoint(x, y);
    if (has_prev) {
      graphics_context_set_stroke_color(ctx, GColorBlue);
      graphics_context_set_stroke_width(ctx, 2);
      graphics_draw_line(ctx, prev, p);
    }
    graphics_context_set_fill_color(ctx, GColorBlue);
    graphics_fill_circle(ctx, p, 2);
    prev = p;
    has_prev = true;
  }
  graphics_context_set_stroke_width(ctx, 1);

  char buf[10];
  graphics_context_set_text_color(ctx, GColorBlack);
  snprintf(buf, sizeof(buf), "%dm", max_w);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(bounds.origin.x, area.origin.y - 2, 28, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, "0m", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(bounds.origin.x, area.origin.y + area.size.h - 12, 28, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);

  format_minute_of_day(graph_start, buf, sizeof(buf));
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(area.origin.x, bounds.origin.y + bounds.size.h - 14, 60, 14),
                      GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  format_minute_of_day(s_graph_minute_of_day[s_graph_count - 1], buf, sizeof(buf));
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(area.origin.x + area.size.w - 50,
                            bounds.origin.y + bounds.size.h - 14, 50, 14),
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
  GRect label_rect = GRect(minus_rect.origin.x + minus_rect.size.w, 4,
                            plus_rect.origin.x - (minus_rect.origin.x + minus_rect.size.w), bounds.size.h - 8);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), label_rect,
                      GTextOverflowModeFill, GTextAlignmentCenter, NULL);
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

static void detail_click_config_provider(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 200, detail_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 200, detail_down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, detail_select_click_handler);
}

#if PBL_API_EXISTS(tap_recognizer_create)
static void detail_tap_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (event != RecognizerEvent_Completed) return;
  GPoint p = tap_recognizer_get_tap_point(recognizer);
  GRect band_frame = layer_get_frame(s_detail_alert_layer); // window-space

  if (p.y >= band_frame.origin.y) {
    GPoint local = GPoint(p.x - band_frame.origin.x, p.y - band_frame.origin.y);
    GRect minus_rect, plus_rect;
    alert_band_layout(GRect(0, 0, band_frame.size.w, band_frame.size.h), &minus_rect, &plus_rect);
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

// Either horizontal direction closes — permissive on purpose, since this
// window has no other use for a horizontal swipe to compete with.
static void detail_swipe_handler(const Recognizer *recognizer, RecognizerEvent event) {
  if (event != RecognizerEvent_Completed) return;
  window_stack_pop(true);
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

  s_detail_header_layer = text_layer_create(GRect(area.origin.x, area.origin.y, area.size.w, 34));
  text_layer_set_background_color(s_detail_header_layer, GColorBlack);
  text_layer_set_text_color(s_detail_header_layer, GColorWhite);
  text_layer_set_font(s_detail_header_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_detail_header_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_detail_header_layer));
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
  text_layer_destroy(s_detail_header_layer);
  s_detail_header_layer = NULL;
  window_destroy(window);
  s_detail_window = NULL;
  s_detail_ride_id = -1;
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
  s_graph_peg_minute = -1;

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
// AppMessage receiving

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  Tuple *t_total = dict_find(iter, MESSAGE_KEY_TotalCount);
  if (t_total) {
    s_ride_count = 0;
    s_cursor     = 0;
    s_show_error = false;
    update_grid_layout();
    update_header();
    layer_mark_dirty(s_grid_content_layer);
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
      s_show_error = false;
      recompute_order();
      update_grid_layout();
      update_header();
      layer_mark_dirty(s_grid_content_layer);
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
    APP_LOG(APP_LOG_LEVEL_ERROR, "CoasterWatch error: %s", t_err->value->cstring);
    return;
  }

  Tuple *t_gcount = dict_find(iter, MESSAGE_KEY_GraphCount);
  if (t_gcount) {
    s_graph_count = 0;
    s_graph_expected_count = t_gcount->value->int32;
    s_graph_loading = true;
    s_graph_show_error = false;
    Tuple *t_gpeg = dict_find(iter, MESSAGE_KEY_GraphPegMinuteOfDay);
    s_graph_peg_minute = t_gpeg ? (int16_t)t_gpeg->value->int32 : -1;
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
  request_graph(s_pending_graph_retry_id);
}

static void outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Outbox failed: %d", (int)reason);

  // Phone-to-watch sends already retry via sendNext() in pkjs; these
  // watch-initiated requests just got silently dropped before. Retry once
  // after a short delay instead of waiting for the next periodic refresh
  // tick, or making the user back out and reopen a ride's detail view.
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
  s_clock_layer = NULL;
  s_header_layer = text_layer_create(GRect(0, ROUND_HEADER_Y_OFFSET, bounds.size.w, HEADER_HEIGHT));
  text_layer_set_background_color(s_header_layer, GColorClear);
  text_layer_set_text_color(s_header_layer, GColorBlack);
#else
  s_clock_layer = text_layer_create(GRect(0, 0, HEADER_CLOCK_WIDTH, HEADER_HEIGHT));
  text_layer_set_background_color(s_clock_layer, GColorBlack);
  text_layer_set_text_color(s_clock_layer, GColorWhite);
  text_layer_set_font(s_clock_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_clock_layer, GTextAlignmentLeft);
  layer_add_child(root, text_layer_get_layer(s_clock_layer));

  s_header_layer = text_layer_create(GRect(HEADER_CLOCK_WIDTH, 0,
                                            bounds.size.w - HEADER_CLOCK_WIDTH - 4, HEADER_HEIGHT));
  text_layer_set_background_color(s_header_layer, GColorBlack);
  text_layer_set_text_color(s_header_layer, GColorWhite);
#endif
  text_layer_set_font(s_header_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  // Rect: right-aligned against the clock on the left — "centered in the
  // space left over after the clock" looked visibly off-center instead.
  // Round: still one combined centered string, so center is correct there.
  text_layer_set_text_alignment(s_header_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentRight));
  layer_add_child(root, text_layer_get_layer(s_header_layer));

  tick_timer_service_subscribe(MINUTE_UNIT, clock_tick_handler);
  update_clock();

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
  s_grid_content_layer = layer_create(GRect(0, 0, s_scroll_frame.size.w, s_scroll_frame.size.h));
  layer_set_update_proc(s_grid_content_layer, grid_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_grid_content_layer);
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));
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
  // Tap and pan compete for the same touch-down by default. fail_after
  // (pan waits for tap to fail) turned out to stall tap's own resolution
  // entirely — plausibly because pan just sits in "possible" for a
  // stationary touch instead of cleanly failing, so tap never got told it
  // could complete. Evaluating them simultaneously instead lets each
  // resolve independently: a stationary touch satisfies tap and never
  // crosses pan's movement threshold; a real drag fails tap's "no
  // movement" criterion while pan proceeds.
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
  layer_destroy(s_grid_content_layer);
  scroll_layer_destroy(s_scroll_layer);
  text_layer_destroy(s_header_layer);
  if (s_clock_layer) text_layer_destroy(s_clock_layer);
}

static void init(void) {
  if (persist_exists(SETTINGS_SORT_KEY)) {
    s_sort_mode = (SortMode)persist_read_int(SETTINGS_SORT_KEY);
  }
  load_alerts();
  load_band_config();

#ifdef PBL_COLOR
  s_ride_name_font = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_RIDE_NAME_FONT_16));
#endif

#if PBL_API_EXISTS(app_touch_navigation_enable)
  // Third-party apps are opt-out of touch by default; without this call it's
  // unclear from the SDK docs whether even our own recognizers receive
  // anything. Harmless to call unconditionally on touch-capable hardware.
  app_touch_navigation_enable(true);
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
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

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
