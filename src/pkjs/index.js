// PebbleKit JS companion: runs on the phone. Fetches live queue times for
// whichever park is currently selected (see PARKS below) from
// queue-times.com, attaches distance-to-ride from the phone's GPS, records
// samples locally to build today's history (the API has no historical
// endpoint), and streams everything to the watch.

var Clay = require('@rebble/clay');

var PARK_KEY = 'selectedParkId';
var DEFAULT_PARK_ID = 317; // Energylandia — preserves existing installs' behavior
var MAX_RIDES = 40;
var MAX_GRAPH_POINTS = 24;
var MAX_SAMPLES_PER_RIDE = 400;
var HISTORY_KEY = 'queueHistory_v1';
var VISIBLE_KEY = 'visibleRideIds';
var BANDS_KEY = 'bandConfig';

// Defaults: green/orange/red under 10 / 10-30 / 30+ minutes, violet for
// "alert met" — deliberately distinct from every band color.
var DEFAULT_BANDS = { t1: 10, t2: 30, c0: 204, c1: 244, c2: 240, cAlert: 227, vibePattern: 0 };

// Must stay in the same order as VIBE_PATTERNS in src/c/main.c — the index
// is what's actually sent/persisted, not the name.
var VIBE_PATTERN_NAMES = ['Standard', 'Nudge', 'Mario', 'Heartbeat'];

// ---------------------------------------------------------------------------
// Supported parks. Each entry is hand-researched (not an open pick-any-park
// list) using this repeatable process:
//   1. Find the park's id via https://queue-times.com/parks.json
//   2. Fetch https://queue-times.com/parks/{id}/queue_times.json for the
//      roster. Check whether it already groups rides under a "Coasters"-type
//      land (Thorpe Park does; Energylandia doesn't) — if not, the coaster
//      subset needs external research (Wikipedia's "roller coasters at X"
//      list, or asking the user directly).
//   3. Check themeparks.wiki's /v1/destinations for the park, then fetch
//      /v1/entity/{parkId}/children for bulk coordinates; match by name
//      against the queue-times.com roster BY HAND (not fuzzy-matched at
//      runtime — both parks below were matched this way).
//   4. Add a new PARKS[id] entry following the shape used here.

// Ride coordinates (queue-times.com itself has no location data). Sourced
// once from themeparks.wiki's bulk /v1/entity/{parkId}/children endpoint —
// NOT a runtime dependency, just a one-time lookup matched by name against
// our queue-times.com roster below (themeparks.wiki uses its own ids/names,
// e.g. "Pepsi Hyperion", "RMF Dragon", "Zadra Made In Małopolska" — matched
// to our ids by hand, not fuzzy-matched at runtime). Keyed by the API's real
// numeric ride `id` (e.g. Abyssus = 11281) — NOT the number written in
// parentheses in some ride names (e.g. "Abyssus (184)"), which is an
// unrelated internal reference and not a stable identifier. Four rides have
// no themeparks.wiki match (Pyramid Cinema 7D, and the three seasonal
// Halloween attractions) and are simply absent here — distance shows "--"
// for those. Re-check both APIs' current rosters if this ever needs
// updating.
var ENERGYLANDIA_COORDS = {
  11281: { lat: 50.000158, lng: 19.400779 }, // Abyssus
  11279: { lat: 50.001051, lng: 19.400310 }, // Grotto Expedition
  11280: { lat: 50.000869, lng: 19.400893 }, // Light Explorers
  11278: { lat: 50.001202, lng: 19.399379 }, // Tidal Wave Twister
  11243: { lat: 50.000285, lng: 19.410587 }, // Energuś
  11240: { lat: 49.999882, lng: 19.409992 }, // Farma Krasnali
  11247: { lat: 49.999790, lng: 19.408920 }, // Jeep Safari
  11249: { lat: 50.000251, lng: 19.408965 }, // Latające Huśtawki
  11269: { lat: 49.999214, lng: 19.409808 }, // Magic Fly
  11241: { lat: 49.999501, lng: 19.409034 }, // WRC Auto Zderzaki
  11273: { lat: 50.001175, lng: 19.402441 }, // Dragon Adventure
  11274: { lat: 50.001670, lng: 19.402250 }, // Draken
  11275: { lat: 50.002006, lng: 19.400886 }, // Frida
  11282: { lat: 50.001313, lng: 19.403570 }, // Wonder Wheel
  11276: { lat: 50.002050, lng: 19.401200 }, // Zadra
  11257: { lat: 50.001188, lng: 19.407057 }, // Apocalypto
  11258: { lat: 50.001185, lng: 19.406141 }, // Aztec Swing
  11262: { lat: 49.999863, lng: 19.405653 }, // Formula
  11270: { lat: 50.000136, lng: 19.412423 }, // Hyperion
  11256: { lat: 50.001716, lng: 19.404927 }, // Mayan
  11238: { lat: 49.999661, lng: 19.407863 }, // Space Booster
  11253: { lat: 49.999848, lng: 19.408151 }, // Space Gun
  11266: { lat: 49.998393, lng: 19.409606 }, // Speed
  11260: { lat: 50.001486, lng: 19.406354 }, // Tsunami Drop
  11259: { lat: 50.001407, lng: 19.407091 }, // Viking
  11267: { lat: 50.001580, lng: 19.404874 }, // Anaconda
  11248: { lat: 50.000876, lng: 19.408386 }, // Atlantis
  11268: { lat: 50.001580, lng: 19.407636 }, // Boomerang
  11261: { lat: 49.999840, lng: 19.406808 }, // Dragon (RMF Dragon)
  11272: { lat: 50.000026, lng: 19.404603 }, // Formuła Autodrom
  11242: { lat: 49.999984, lng: 19.410494 }, // Frutti Loop
  11265: { lat: 49.999159, lng: 19.406757 }, // Jungle Adventure
  11244: { lat: 50.000689, lng: 19.410132 }, // Kopalnia Zlota
  11246: { lat: 49.999773, lng: 19.408681 }, // Mars
  11255: { lat: 50.000416, lng: 19.407424 }, // Monster House
  11239: { lat: 49.999583, lng: 19.410422 }, // Samoloty
  11245: { lat: 50.000747, lng: 19.409302 }, // Splash Battle
  11263: { lat: 50.000874, lng: 19.407410 }, // Swiss Water Cups
  11264: { lat: 49.998913, lng: 19.406305 }, // Viking Ride
  11451: { lat: 50.000116, lng: 19.402868 }, // Choco Chip Creek
  11979: { lat: 49.998988, lng: 19.402769 }, // Honey Harbor
  11900: { lat: 49.999318, lng: 19.402042 }  // Mini Track' Tour Ride
};

// Default "visible" set when no config has been saved yet: the roller
// coasters above, i.e. everything with a known location.
var ENERGYLANDIA_DEFAULT_VISIBLE = [
  11270, 11276, 11281, 11266, 11256, 11262, 11259, 11280, 11451,
  11979, 11275, 11274, 11261, 11268, 11243, 11246, 11242
];

// Full current attraction roster (grouped by land) for the settings page.
// queue-times.com has no "type" field, so this is a manually curated list;
// re-check https://queue-times.com/parks/317/queue_times.json if Energylandia
// adds/removes rides and this list needs updating.
//
// infoUrl: Coasterpedia page where one exists, else Energylandia's own ride
// page, else omitted — every URL below was fetched and hand-verified to be
// genuinely about that specific ride, not guessed from a naming pattern. The
// three seasonal Halloween attractions have no infoUrl: no Coasterpedia page
// exists and every plausible energylandia.pl URL for them currently
// soft-redirects to the homepage (off-season).
var ENERGYLANDIA_ROSTER = [
  { land: 'Aqualantis', rides: [
      { id: 11281, name: 'Abyssus', infoUrl: 'https://coasterpedia.net/wiki/Abyssus' },
      { id: 11279, name: 'Grotto Expedition', infoUrl: 'https://energylandia.pl/en/attractions/aqualantis/grotto-expedition/' },
      { id: 11280, name: 'Light Explorers', infoUrl: 'https://coasterpedia.net/wiki/Light_Explorers' },
      { id: 11278, name: 'Tidal Wave Twister', infoUrl: 'https://coasterpedia.net/wiki/Tidal_Wave_Twister' }
  ]},
  { land: 'Bajkolandia', rides: [
      { id: 11243, name: 'Energuś', infoUrl: 'https://coasterpedia.net/wiki/Energu%C5%9B_Roller_Coaster' },
      { id: 11240, name: 'Farma Krasnali', infoUrl: 'https://energylandia.pl/en/attractions/little-kids-zone/farma-krasnali/' },
      { id: 11247, name: 'Jeep Safari', infoUrl: 'https://coasterpedia.net/wiki/Jeep_Safari_(Energylandia)' },
      { id: 11249, name: 'Latające Huśtawki', infoUrl: 'https://energylandia.pl/en/attractions/little-kids-zone/latajace-hustawki/' },
      { id: 11269, name: 'Magic Fly', infoUrl: 'https://coasterpedia.net/wiki/Magic_Fly_(Energylandia)' },
      { id: 11241, name: 'WRC Auto Zderzaki', infoUrl: 'https://energylandia.pl/en/attractions/little-kids-zone/wrc-auto-zderzaki/' }
  ]},
  { land: 'Smoczy Gród', rides: [
      { id: 11273, name: 'Dragon Adventure', infoUrl: 'https://coasterpedia.net/wiki/Dragon_Adventure' },
      { id: 11274, name: 'Draken', infoUrl: 'https://coasterpedia.net/wiki/Draken_(Energylandia)' },
      { id: 11275, name: 'Frida', infoUrl: 'https://coasterpedia.net/wiki/Frida' },
      { id: 11282, name: 'Wonder Wheel', infoUrl: 'https://energylandia.pl/en/attractions/dragon-zone/wonder-wheel/' },
      { id: 11276, name: 'Zadra', infoUrl: 'https://coasterpedia.net/wiki/Zadra' }
  ]},
  { land: 'Extreme Zone', rides: [
      { id: 11257, name: 'Apocalypto', infoUrl: 'https://coasterpedia.net/wiki/Apocalypto' },
      { id: 11258, name: 'Aztec Swing', infoUrl: 'https://coasterpedia.net/wiki/Aztec_Swing' },
      { id: 11262, name: 'Formula', infoUrl: 'https://coasterpedia.net/wiki/Formu%C5%82a' },
      { id: 11270, name: 'Hyperion', infoUrl: 'https://coasterpedia.net/wiki/Hyperion' },
      { id: 11256, name: 'Mayan', infoUrl: 'https://coasterpedia.net/wiki/Roller_Coaster_Mayan' },
      { id: 11238, name: 'Space Booster', infoUrl: 'https://coasterpedia.net/wiki/Space_Booster' },
      { id: 11253, name: 'Space Gun', infoUrl: 'https://coasterpedia.net/wiki/Space_Gun_(Energylandia)' },
      { id: 11266, name: 'Speed', infoUrl: 'https://coasterpedia.net/wiki/Speed_(Energylandia)' },
      { id: 11260, name: 'Tsunami Drop', infoUrl: 'https://coasterpedia.net/wiki/Tsunami_Drop' },
      { id: 11259, name: 'Viking', infoUrl: 'https://coasterpedia.net/wiki/Viking_Roller_Coaster' }
  ]},
  { land: 'Family Zone', rides: [
      { id: 11267, name: 'Anaconda', infoUrl: 'https://coasterpedia.net/wiki/Anaconda_(Energylandia)' },
      { id: 11248, name: 'Atlantis', infoUrl: 'https://coasterpedia.net/wiki/Atlantis_(Energylandia)' },
      { id: 11268, name: 'Boomerang', infoUrl: 'https://coasterpedia.net/wiki/Boomerang_(Energylandia)' },
      { id: 11261, name: 'Dragon', infoUrl: 'https://coasterpedia.net/wiki/Dragon_Roller_Coaster_(Energylandia)' },
      { id: 11272, name: 'Formuła Autodrom', infoUrl: 'https://coasterpedia.net/wiki/Moya_Formula_Autodrom' },
      { id: 11242, name: 'Frutti Loop', infoUrl: 'https://coasterpedia.net/wiki/Frutti_Loop_Coaster' },
      { id: 11265, name: 'Jungle Adventure', infoUrl: 'https://coasterpedia.net/wiki/Jungle_Adventure_(Energylandia)' },
      { id: 11244, name: 'Kopalnia Zlota', infoUrl: 'https://energylandia.pl/en/attractions/family-zone/the-golden-mine-ride/' },
      { id: 11246, name: 'Mars', infoUrl: 'https://coasterpedia.net/wiki/Mars_(Energylandia)' },
      { id: 11255, name: 'Monster House', infoUrl: 'https://coasterpedia.net/wiki/Monster_House_(Energylandia)' },
      { id: 11252, name: 'Pyramid Cinema 7D', infoUrl: 'https://energylandia.pl/en/show/pyramid-cinema-7d/' },
      { id: 11239, name: 'Samoloty', infoUrl: 'https://coasterpedia.net/wiki/Planes_(Energylandia)' },
      { id: 11245, name: 'Splash Battle', infoUrl: 'https://coasterpedia.net/wiki/Splash_Battle_(Energylandia)' },
      { id: 11263, name: 'Swiss Water Cups', infoUrl: 'https://coasterpedia.net/wiki/Swiss_Water_Cups' },
      { id: 11264, name: 'Viking Ride', infoUrl: 'https://coasterpedia.net/wiki/Viking_Ride_(Energylandia)' }
  ]},
  { land: 'Sweet Valley', rides: [
      { id: 11451, name: 'Choco Chip Creek', infoUrl: 'https://coasterpedia.net/wiki/Choco_Chip_Creek' },
      { id: 11979, name: 'Honey Harbor', infoUrl: 'https://coasterpedia.net/wiki/Honey_Harbour' },
      { id: 11900, name: 'Mini Track’ Tour Ride', infoUrl: 'https://energylandia.pl/en/attractions/sweet-valley/mini-track-tour-ride/' }
  ]},
  { land: 'Halloween (seasonal)', rides: [
      { id: 14137, name: 'Obsessive House' },
      { id: 14135, name: 'Psychoteria' },
      { id: 14136, name: 'Scary Loft' }
  ]}
];

// Thorpe Park (UK), queue-times.com park id 2. Unlike Energylandia, its own
// data already groups rides under an explicit "Coasters" land, so the
// default-visible set came straight from the roster with no external
// research needed. themeparks.wiki park entity id:
// b08d9272-d070-4580-9fcd-375270b191a7 — matched 6 of 7 coasters; Hyperia
// (a 2024 addition) isn't in its dataset yet, so it shows "--" for distance.
var THORPE_COORDS = {
  96:   { lat: 51.402852, lng: -0.513140 }, // Colossus
  88:   { lat: 51.403512, lng: -0.515935 }, // Nemesis Inferno
  104:  { lat: 51.402712, lng: -0.511659 }, // SAW - The Ride
  91:   { lat: 51.404798, lng: -0.516262 }, // Stealth
  103:  { lat: 51.405787, lng: -0.515538 }, // The Swarm
  5558: { lat: 51.403415, lng: -0.513333 }  // The Walking Dead©: The Ride
};

var THORPE_DEFAULT_VISIBLE = [96, 13079, 88, 104, 91, 103, 5558];

// infoUrl: Coasterpedia page where one exists (several of these ride names
// collide with other parks' rides of the same name — e.g. Vortex, Storm
// Surge, Detonator — so the disambiguated "(Thorpe Park)" title matters),
// else Thorpe Park's own official ride page. Hand-verified, not guessed.
var THORPE_ROSTER = [
  { land: 'Coasters', rides: [
      { id: 96, name: 'Colossus', infoUrl: 'https://coasterpedia.net/wiki/Colossus_(Thorpe_Park)' },
      { id: 13079, name: 'Hyperia', infoUrl: 'https://coasterpedia.net/wiki/Hyperia' },
      { id: 88, name: 'Nemesis Inferno', infoUrl: 'https://coasterpedia.net/wiki/Nemesis_Inferno' },
      { id: 104, name: 'SAW - The Ride', infoUrl: 'https://coasterpedia.net/wiki/Saw_-_The_Ride' },
      { id: 91, name: 'Stealth', infoUrl: 'https://coasterpedia.net/wiki/Stealth' },
      { id: 103, name: 'The Swarm', infoUrl: 'https://coasterpedia.net/wiki/The_Swarm' },
      { id: 5558, name: 'The Walking Dead©: The Ride', infoUrl: 'https://coasterpedia.net/wiki/The_Walking_Dead:_The_Ride' }
  ]},
  { land: 'Family rides', rides: [
      { id: 14526, name: 'Amity Beach', infoUrl: 'https://www.thorpepark.com/explore/theme-park/rides/amity-beach/' },
      { id: 3884, name: 'Big Easy Bumpers', infoUrl: 'https://coasterpedia.net/wiki/Big_Easy_Bumpers' },
      { id: 108, name: 'Depth Charge', infoUrl: 'https://coasterpedia.net/wiki/Depth_Charge' },
      { id: 95, name: 'Dobble Tea Party', infoUrl: 'https://coasterpedia.net/wiki/Dobble_Tea_Party' },
      { id: 93, name: 'Flying Fish', infoUrl: 'https://coasterpedia.net/wiki/Flying_Fish_(Thorpe_Park)' },
      { id: 10711, name: 'High Striker', infoUrl: 'https://coasterpedia.net/wiki/High_Striker' },
      { id: 109, name: "Mr Monkey's Banana Ride", infoUrl: "https://coasterpedia.net/wiki/Mr._Monkey's_Banana_Ride" }
  ]},
  { land: 'Thrill rides', rides: [
      { id: 89, name: 'Detonator', infoUrl: 'https://coasterpedia.net/wiki/Detonator_(Thorpe_Park)' },
      { id: 4546, name: 'Ghost Train', infoUrl: 'https://www.thorpepark.com/explore/theme-park/rides/ghost-train-ride/' },
      { id: 102, name: 'Quantum', infoUrl: 'https://coasterpedia.net/wiki/Quantum' },
      { id: 98, name: 'Rush', infoUrl: 'https://coasterpedia.net/wiki/Rush_(Thorpe_Park)' },
      { id: 99, name: 'Samurai', infoUrl: 'https://coasterpedia.net/wiki/Samurai_(Thorpe_Park)' },
      { id: 94, name: 'Storm Surge', infoUrl: 'https://coasterpedia.net/wiki/Storm_Surge_(Thorpe_Park)' },
      { id: 92, name: 'Tidal Wave', infoUrl: 'https://coasterpedia.net/wiki/Tidal_Wave_(Thorpe_Park)' },
      { id: 100, name: 'Vortex', infoUrl: 'https://coasterpedia.net/wiki/Vortex_(Thorpe_Park)' },
      { id: 101, name: 'Zodiac', infoUrl: 'https://coasterpedia.net/wiki/Zodiac_(Thorpe_Park;_opened_2006)' }
  ]}
];

// timezone: the park's IANA zone, from queue-times.com/parks.json (used to
// work out the park's own "today" for the schedule lookup below).
// themeParksId: the destination's UUID on themeparks.wiki, from
// /v1/destinations — a live per-day open/close schedule, unlike coordinates
// above, so unlike ENERGYLANDIA_COORDS/THORPE_COORDS this one genuinely is a
// runtime dependency (see "Park operating hours" below for why).
var PARKS = {
  317: { name: 'Energylandia', roster: ENERGYLANDIA_ROSTER,
         coords: ENERGYLANDIA_COORDS, defaultVisible: ENERGYLANDIA_DEFAULT_VISIBLE,
         timezone: 'Europe/Warsaw', themeParksId: 'd13baede-ab6d-419e-930a-ce7029a092e5' },
  2:   { name: 'Thorpe Park', roster: THORPE_ROSTER,
         coords: THORPE_COORDS, defaultVisible: THORPE_DEFAULT_VISIBLE,
         timezone: 'Europe/London', themeParksId: 'b08d9272-d070-4580-9fcd-375270b191a7' }
};

function getSelectedParkId() {
  var stored = parseInt(localStorage.getItem(PARK_KEY), 10);
  return PARKS[stored] ? stored : DEFAULT_PARK_ID;
}

function getActivePark() {
  return PARKS[getSelectedParkId()];
}

// ---------------------------------------------------------------------------
// Networking helpers

function xhrRequest(url, type, callback, errback) {
  var xhr = new XMLHttpRequest();
  xhr.timeout = 15000;
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      callback(xhr.responseText);
    } else {
      errback('HTTP ' + xhr.status);
    }
  };
  xhr.onerror = function () { errback('network error'); };
  xhr.ontimeout = function () { errback('timeout'); };
  xhr.open(type, url);
  xhr.send();
}

// queue-times.com appends a trailing " (123)" internal id to some ride names.
function cleanName(name) {
  return name.replace(/\s*\(\d+\)\s*$/, '').substring(0, 22);
}

function flattenRides(data) {
  var rides = [];
  var lands = data.lands || [];
  for (var i = 0; i < lands.length; i++) {
    var landRides = lands[i].rides || [];
    for (var j = 0; j < landRides.length; j++) {
      rides.push(landRides[j]);
    }
  }
  if (data.rides && data.rides.length) {
    rides = rides.concat(data.rides);
  }
  return rides;
}

// ---------------------------------------------------------------------------
// Location & distance

function getLocation(cb) {
  if (!navigator.geolocation) { cb(null); return; }
  var done = false;
  var timer = setTimeout(function () {
    if (!done) { done = true; cb(null); }
  }, 8000);
  navigator.geolocation.getCurrentPosition(function (pos) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb({ lat: pos.coords.latitude, lng: pos.coords.longitude });
  }, function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(null);
  }, { timeout: 7000, maximumAge: 60000 });
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function attachDistances(rides, loc) {
  var parkCoords = getActivePark().coords;
  for (var i = 0; i < rides.length; i++) {
    var coords = parkCoords[rides[i].id];
    if (loc && coords) {
      rides[i]._distance = Math.round(haversineMeters(loc.lat, loc.lng, coords.lat, coords.lng));
    } else {
      rides[i]._distance = -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Ride visibility (configured on the settings page)

// Namespaced per park, so switching parks and back later restores exactly
// which rides you had visible for each one.
function visibleKeyForPark(parkId) {
  return VISIBLE_KEY + '_' + parkId;
}

function getVisibleIdSet(parkId) {
  if (parkId === undefined) parkId = getSelectedParkId();
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(visibleKeyForPark(parkId))); } catch (e) { /* ignore */ }
  var ids = (stored && stored.length) ? stored : PARKS[parkId].defaultVisible;
  var set = {};
  for (var i = 0; i < ids.length; i++) set[ids[i]] = true;
  return { has: function (id) { return !!set[id]; } };
}

// ---------------------------------------------------------------------------
// Tile colors (configured on the settings page)

function getBandConfig() {
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(BANDS_KEY)); } catch (e) { /* ignore */ }
  if (!stored) return DEFAULT_BANDS;
  // vibePattern is newer than the other fields — a save from before it
  // existed won't have it, so it needs its own default fallback rather
  // than falling back to DEFAULT_BANDS wholesale (which would also lose
  // whatever colors/thresholds were already saved).
  if (stored.vibePattern === undefined) stored.vibePattern = DEFAULT_BANDS.vibePattern;
  return stored;
}

function sendBandConfig() {
  var b = getBandConfig();
  var dict = {
    'BandThreshold1': b.t1, 'BandThreshold2': b.t2,
    'BandColor0': b.c0, 'BandColor1': b.c1, 'BandColor2': b.c2,
    'AlertColor': b.cAlert, 'VibePattern': b.vibePattern
  };
  Pebble.sendAppMessage(dict, function () {}, function () {
    console.log('CoasterWatch: failed to send band config');
  });
}

// ---------------------------------------------------------------------------
// Today's history (queue-times.com has no historical endpoint, so this app
// records samples itself, only while it has been running today)

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function nowMinutes() {
  var d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function loadHistory() {
  var hist = null;
  try { hist = JSON.parse(localStorage.getItem(HISTORY_KEY)); } catch (e) { /* ignore */ }
  if (!hist || hist.date !== todayStr()) {
    hist = { date: todayStr(), rides: {} };
  }
  return hist;
}

function saveHistory(hist) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist)); } catch (e) {
    console.log('CoasterWatch: failed to save history: ' + e);
  }
}

function appendHistory(rides) {
  var hist = loadHistory();
  var t = nowMinutes();
  for (var i = 0; i < rides.length; i++) {
    var r = rides[i];
    var w = r.is_open ? r.wait_time : -1;
    var arr = hist.rides[r.id];
    if (!arr) { arr = []; hist.rides[r.id] = arr; }
    arr.push([t, w]);
    if (arr.length > MAX_SAMPLES_PER_RIDE) arr.shift();
  }
  saveHistory(hist);
}

// Returns [{wait, minuteOfDay}, ...] oldest-first, downsampled to
// MAX_GRAPH_POINTS, or null if fewer than 2 samples exist today. minuteOfDay
// is the sample's actual clock time (0-1439) rather than an age, so the
// watch can label the axis with real times (e.g. "09:15") instead of
// "-85m" — history never spans midnight since it resets daily, so there's
// no wraparound to account for.
function getGraphPoints(rideId) {
  var hist = loadHistory();
  var arr = hist.rides[rideId];
  if (!arr || arr.length < 2) return null;

  var sampled = arr;
  if (arr.length > MAX_GRAPH_POINTS) {
    sampled = [];
    for (var i = 0; i < MAX_GRAPH_POINTS; i++) {
      var idx = Math.round(i * (arr.length - 1) / (MAX_GRAPH_POINTS - 1));
      sampled.push(arr[idx]);
    }
  }

  var out = [];
  for (var j = 0; j < sampled.length; j++) {
    out.push({ wait: sampled[j][1], minuteOfDay: sampled[j][0] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending to the watch

function sendNext(i, rides) {
  if (i >= rides.length) return;
  var r = rides[i];
  var dict = {
    'RideIndex': i,
    'RideId': r.id,
    'RideName': cleanName(r.name),
    'RideWait': r.is_open ? r.wait_time : -1,
    'RideDistance': (r._distance !== undefined) ? r._distance : -1
  };
  Pebble.sendAppMessage(dict, function () {
    sendNext(i + 1, rides);
  }, function () {
    console.log('CoasterWatch: send failed for ride ' + i + ', retrying');
    setTimeout(function () { sendNext(i, rides); }, 500);
  });
}

function sendRidesToWatch(rides) {
  var capped = rides.slice(0, MAX_RIDES);
  Pebble.sendAppMessage({ 'TotalCount': capped.length }, function () {
    sendNext(0, capped);
  }, function () {
    console.log('CoasterWatch: failed to send TotalCount');
  });
}

function sendError(msg) {
  Pebble.sendAppMessage({ 'ErrorMsg': msg.substring(0, 40) });
}

// Bumped by every sendGraph() call and captured by its own point-sending
// chain (sendGraphPoint's `seq` param) — if the user opens another ride's
// detail view before the previous one's points finished streaming, the
// stale chain's `seq` no longer matches and it quietly stops instead of
// interleaving its remaining points with the new ride's stream.
var graphRequestSeq = 0;

function sendGraphPoint(i, points, seq) {
  if (seq !== graphRequestSeq) return;
  if (i >= points.length) return;
  var p = points[i];
  var dict = { 'GraphIndex': i, 'GraphWait': p.wait, 'GraphMinuteOfDay': p.minuteOfDay };
  Pebble.sendAppMessage(dict, function () {
    sendGraphPoint(i + 1, points, seq);
  }, function () {
    if (seq !== graphRequestSeq) return;
    setTimeout(function () { sendGraphPoint(i, points, seq); }, 300);
  });
}

function sendGraph(rideId) {
  graphRequestSeq++;
  var seq = graphRequestSeq;
  var points = getGraphPoints(rideId);
  if (!points) {
    Pebble.sendAppMessage({ 'GraphError': 'Not enough data recorded yet today' });
    return;
  }
  var dict = { 'GraphCount': points.length };
  var peg = graphPegMinuteOfDay();
  if (peg !== null) dict['GraphPegMinuteOfDay'] = peg;
  Pebble.sendAppMessage(dict, function () {
    sendGraphPoint(0, points, seq);
  }, function () {
    console.log('CoasterWatch: failed to send GraphCount');
  });
}

// ---------------------------------------------------------------------------
// Park operating hours
//
// queue-times.com's own `is_open` flag is unreliable for at least
// Energylandia: rides keep reporting is_open=true with wait_time=0 well
// outside opening hours, rather than actually going closed. queue-times.com
// itself has no schedule endpoint (parks.json exposes each park's IANA
// timezone but not its hours), so this cross-checks against themeparks.wiki's
// live per-day schedule instead and overrides is_open to false for every
// ride when the park itself isn't open right now.
//
// Cached per park for the day so this doesn't add a network round-trip to
// every 5-minute refresh — only the first fetch after a (device-local, see
// below) date rollover re-fetches. The cache key uses the phone's own local
// date rather than the park's, purely as a "when to bother re-fetching"
// heuristic; it doesn't affect correctness of the open/closed *result*,
// which always compares the live-fetched openingTime/closingTime instants
// against the current time. The only place the two dates can disagree is a
// short window either side of the park's own local midnight, and a park is
// essentially always closed then under both the stale and fresh schedule
// anyway, so a slightly-late refetch there is harmless.
var SCHEDULE_KEY = 'parkSchedule_v1';

function loadCachedSchedule(parkId) {
  try {
    var all = JSON.parse(localStorage.getItem(SCHEDULE_KEY)) || {};
    return all[parkId] || null;
  } catch (e) {
    return null;
  }
}

function saveCachedSchedule(parkId, entry) {
  var all = {};
  try { all = JSON.parse(localStorage.getItem(SCHEDULE_KEY)) || {}; } catch (e) { /* ignore */ }
  all[parkId] = entry;
  try { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(all)); } catch (e) {
    console.log('CoasterWatch: failed to save park schedule: ' + e);
  }
}

// The park's own "today" (en-CA formats as YYYY-MM-DD, matching the
// schedule API's `date` field) - falls back to null if Intl/timeZone
// support is missing, in which case the caller just uses schedule[0].
function todayInTimezone(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch (e) {
    return null;
  }
}

// callback(scheduleEntry|null). null means "couldn't determine" — callers
// should treat that as "don't override", i.e. trust queue-times.com's own
// is_open as before, rather than guessing the park closed.
function fetchParkSchedule(park, callback) {
  var parkId = getSelectedParkId();
  var cached = loadCachedSchedule(parkId);
  if (cached && cached.fetchedDate === todayStr()) {
    callback(cached);
    return;
  }
  if (!park.themeParksId) {
    callback(null);
    return;
  }
  var url = 'https://api.themeparks.wiki/v1/entity/' + park.themeParksId + '/schedule';
  xhrRequest(url, 'GET', function (responseText) {
    try {
      var data = JSON.parse(responseText);
      var list = data.schedule || [];
      var todayLocal = todayInTimezone(park.timezone);
      var todayEntry = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].date === todayLocal) { todayEntry = list[i]; break; }
      }
      if (!todayEntry) todayEntry = list[0] || null;
      var entry = todayEntry ? {
        fetchedDate: todayStr(),
        type: todayEntry.type,
        openingTime: todayEntry.openingTime,
        closingTime: todayEntry.closingTime
      } : null;
      saveCachedSchedule(parkId, entry);
      callback(entry);
    } catch (e) {
      console.log('CoasterWatch: failed to parse park schedule: ' + e);
      callback(null);
    }
  }, function (errMsg) {
    console.log('CoasterWatch: park schedule fetch failed: ' + errMsg);
    callback(null); // network failure: degrade to trusting queue-times.com's own flags
  });
}

// true unless we positively know the park is closed right now - "unknown"
// (schedule null/unparseable) fails open rather than mislabeling every ride.
function isParkOpenNow(schedule) {
  if (!schedule) return true;
  if (schedule.type !== 'OPERATING') return false;
  var open = Date.parse(schedule.openingTime);
  var close = Date.parse(schedule.closingTime);
  if (isNaN(open) || isNaN(close)) return true;
  var now = Date.now();
  return now >= open && now <= close;
}

// Minute-of-day (0-1439), in the *phone's* local time, 30 minutes before
// the park's own opening time - null if no cached schedule is available yet.
// The 30-minute cushion and the actual conversion both matter here: the park
// and the phone/watch can be in different timezones (e.g. a UK watch
// tracking a Polish park), so this converts openingTime's absolute instant
// through the phone's own Date methods (always local by JS spec) rather
// than assuming the park's clock-face hour means anything on the watch -
// same reasoning as isParkOpenNow, just producing a wall-clock minute
// instead of a yes/no.
function graphPegMinuteOfDay() {
  var schedule = loadCachedSchedule(getSelectedParkId());
  if (!schedule || !schedule.openingTime) return null;
  var openMs = Date.parse(schedule.openingTime);
  if (isNaN(openMs)) return null;
  var peg = new Date(openMs - 30 * 60 * 1000);
  return ((peg.getHours() * 60 + peg.getMinutes()) % 1440 + 1440) % 1440;
}

// ---------------------------------------------------------------------------
// Main fetch cycle

function fetchQueueTimes() {
  var apiUrl = 'https://queue-times.com/parks/' + getSelectedParkId() + '/queue_times.json';
  var park = getActivePark();
  getLocation(function (loc) {
    xhrRequest(apiUrl, 'GET', function (responseText) {
      try {
        var data = JSON.parse(responseText);
        var rides = flattenRides(data);
        if (rides.length === 0) {
          sendError('No ride data available');
          return;
        }
        fetchParkSchedule(park, function (schedule) {
          if (!isParkOpenNow(schedule)) {
            for (var i = 0; i < rides.length; i++) rides[i].is_open = false;
          }

          // Record every ride (not just visible ones) so hiding/unhiding a
          // ride later doesn't lose history collected while it was hidden.
          appendHistory(rides);

          var visible = getVisibleIdSet();
          var filtered = rides.filter(function (r) { return visible.has(r.id); });
          if (filtered.length === 0) {
            sendError('No rides selected - check settings');
            return;
          }
          attachDistances(filtered, loc);
          sendRidesToWatch(filtered);
        });
      } catch (e) {
        sendError('Bad response from server');
      }
    }, function (errMsg) {
      sendError('Fetch failed: ' + errMsg);
    });
  });
}

Pebble.addEventListener('ready', function () {
  console.log('CoasterWatch: PebbleKit JS ready');
  sendBandConfig();
  fetchQueueTimes();
});

Pebble.addEventListener('appmessage', function (e) {
  if (e.payload && e.payload['RequestRefresh'] !== undefined) {
    fetchQueueTimes();
  }
  if (e.payload && e.payload['RequestGraph'] !== undefined) {
    sendGraph(e.payload['RequestGraph']);
  }
});

// ---------------------------------------------------------------------------
// Settings page (which rides are shown) — a self-contained HTML page opened
// via a data: URL, so no external hosting is needed.

// Pebble's watch-side GColor8 byte is 2 bits each of alpha/red/green/blue
// (0xC0 = opaque, then 2 bits per channel scaled 0/85/170/255); Clay's color
// picker instead works in plain 24-bit RGB. These two convert between them —
// argb8ToRgb24 reuses the exact channel-scale table the old hand-rolled
// swatch picker used, so the two representations agree pixel-for-pixel.
function argb8ToRgb24(v) {
  var scale = [0, 85, 170, 255];
  return (scale[(v >> 4) & 3] << 16) | (scale[(v >> 2) & 3] << 8) | scale[v & 3];
}

function rgb24ToArgb8(rgb24) {
  var scale = [0, 85, 170, 255];
  function nearest2bit(c) {
    var best = 0, bestDiff = Infinity;
    for (var i = 0; i < scale.length; i++) {
      var diff = Math.abs(c - scale[i]);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }
  var r = (rgb24 >> 16) & 0xFF, g = (rgb24 >> 8) & 0xFF, b = rgb24 & 0xFF;
  return 0xC0 | (nearest2bit(r) << 4) | (nearest2bit(g) << 2) | nearest2bit(b);
}

// Constrains Clay's color picker to Pebble's real 64-color hardware palette
// (rather than an arbitrary RGB picker), so every value it returns already
// round-trips exactly through rgb24ToArgb8 above.
var CLAY_COLOR_LAYOUT = 'COLOR';

// Custom Clay component: the per-park ride checklist with numeric ride ids
// and an info-icon overlay per row. No stock Clay component fits this —
// checkboxgroup only supports plain label strings, no id/extra-markup slot
// per row — so this ports the hand-rolled version's markup/behavior
// (already fought for and tested this session) almost verbatim into Clay's
// custom-component shape (template/style/manipulator/initialize).
//
// All parks' ride lists are pre-rendered up front (only the active park's
// <div class="rl-park"> shown) so switching the Park <select> elsewhere on
// the page can just show/hide between them, no reload needed — same
// approach the old hand-rolled version used.
var RIDE_LIST_COMPONENT = {
  name: 'ridelist',
  template:
    '<div class="component component-ridelist">' +
      '<div class="rl-quickbuttons">' +
        '<button type="button" class="rl-btn-all">All</button>' +
        '<button type="button" class="rl-btn-none">None</button>' +
        '<button type="button" class="rl-btn-default">Coasters</button>' +
      '</div>' +
      '{{each parks}}' +
        '<div class="rl-park" data-park="{{this.parkId}}">' +
          '{{each this.lands}}' +
            '<div class="section rl-land">' +
              '<div class="rl-land-header">{{{this.name}}}</div>' +
              '{{each this.rides}}' +
                '<label class="rl-ride">' +
                  '<input type="checkbox" data-id="{{this.id}}" {{if this.checked}}checked{{/if}}>' +
                  '{{{this.name}}}' +
                  '{{if this.infoUrl}}' +
                    '<a class="infolink" href="javascript:void(0)" data-url="{{this.infoUrl}}">&#8505;</a>' +
                  '{{/if}}' +
                '</label>' +
              '{{/each}}' +
            '</div>' +
          '{{/each}}' +
        '</div>' +
      '{{/each}}' +
      '<div id="infoOverlay"><div id="infoOverlayBar">' +
        '<button type="button" id="infoOverlayClose">&#8592; Back to Settings</button>' +
      '</div><div id="infoFrameContainer"><iframe id="infoFrame"></iframe></div></div>' +
    '</div>',
  style:
    // min-width:0 overrides flex items' default min-width:auto, which
    // otherwise refuses to shrink a button below its own label's natural
    // width (e.g. "Coasters") regardless of flex:1 — without it, this row
    // was overflowing the page and widening the whole settings frame.
    '.rl-quickbuttons{display:flex;gap:6px;padding:8px 0;box-sizing:border-box;}' +
    '.rl-quickbuttons button{flex:1;min-width:0;padding:8px 2px;font-size:13px;border:0;' +
      'border-radius:6px;background:#555;color:#fff;box-sizing:border-box;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.rl-quickbuttons button.active{background:#3a7bd5;box-shadow:0 0 0 2px #fff inset;}' +
    '.rl-land-header{font-size:16px;padding:12px 0;cursor:pointer;font-weight:bold;}' +
    '.rl-ride{display:block;padding:6px 0;font-size:15px;}' +
    '.rl-ride input{margin-right:8px;transform:scale(1.3);}' +
    '.infolink{display:inline-block;color:#7ab8ff;text-decoration:none;font-style:normal;' +
      'border:1px solid #7ab8ff;border-radius:50%;width:18px;height:18px;line-height:16px;' +
      'text-align:center;font-size:13px;margin-left:4px;cursor:pointer;}' +
    '#infoOverlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;' +
      'background:#fff;z-index:1000;flex-direction:column;}' +
    '#infoOverlay.open{display:flex;}' +
    '#infoOverlayBar{background:#1c1c1c;padding:8px;flex:none;}' +
    '#infoOverlayBar button{width:100%;background:#555;color:#fff;border:0;border-radius:6px;padding:10px;}' +
    '#infoFrameContainer{flex:1;min-height:0;}' +
    '#infoFrame{display:block;border:0;width:100%;height:100%;background:#fff;}',
  // Inline get/set (rather than one of Clay's named manipulators, e.g.
  // 'checkboxgroup') since this needs to read only the currently-visible
  // park's checkboxes, not every checkbox on the page.
  manipulator: {
    get: function () {
      var root = this.$element[0];
      var activeGroup = root.querySelector('.rl-park:not(.hide)');
      var ids = [];
      if (activeGroup) {
        var checked = activeGroup.querySelectorAll('input[type=checkbox]:checked');
        for (var i = 0; i < checked.length; i++) {
          ids.push(parseInt(checked[i].getAttribute('data-id'), 10));
        }
      }
      return ids;
    },
    set: function () { /* state is baked into the template at build time */ }
  },
  initialize: function () {
    var root = this.$element[0];
    var config = this.config;
    var presetButtons = [
      root.querySelector('.rl-btn-all'), root.querySelector('.rl-btn-none'), root.querySelector('.rl-btn-default')
    ];

    function activeGroup() {
      return root.querySelector('.rl-park:not(.hide)');
    }

    // A preset button stays highlighted only while the checkboxes still
    // match what it set — any manual tick afterward (see the 'change'
    // listener below) clears it, since the state it applied no longer
    // necessarily holds.
    function clearActivePreset() {
      for (var i = 0; i < presetButtons.length; i++) presetButtons[i].classList.remove('active');
    }
    function setActivePreset(btn) {
      clearActivePreset();
      btn.classList.add('active');
    }

    function applyParkVisibility(parkId) {
      var groups = root.querySelectorAll('.rl-park');
      for (var i = 0; i < groups.length; i++) {
        var isActive = parseInt(groups[i].getAttribute('data-park'), 10) === parkId;
        // Plain add/remove, not classList.toggle('hide', force) — this
        // session already found this webview's DOM engine stricter than
        // desktop browsers in more than one spot, so the two-argument
        // "force" form isn't worth the risk versus the two extra lines.
        if (isActive) {
          groups[i].classList.remove('hide');
        } else {
          groups[i].classList.add('hide');
        }
      }
      clearActivePreset();
    }
    applyParkVisibility(config.activeParkId);

    // The Park <select> is a separate, standard Clay item elsewhere on the
    // page — there's only ever one <select> on this page, so it's found by
    // element type rather than needing Clay's own cross-item item lookup.
    var parkSelect = document.querySelector('select');
    if (parkSelect) {
      parkSelect.addEventListener('change', function () {
        applyParkVisibility(parseInt(parkSelect.value, 10));
      });
    }

    // Programmatic .checked assignment (the three preset handlers below)
    // never fires 'change' — only genuine taps do — so this only clears
    // the highlight on an actual manual edit, not on a preset applying it.
    root.addEventListener('change', function (e) {
      if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') clearActivePreset();
    });

    root.querySelector('.rl-btn-all').addEventListener('click', function (e) {
      var cbs = activeGroup().querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = true;
      setActivePreset(e.currentTarget);
    });
    root.querySelector('.rl-btn-none').addEventListener('click', function (e) {
      var cbs = activeGroup().querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
      setActivePreset(e.currentTarget);
    });
    root.querySelector('.rl-btn-default').addEventListener('click', function (e) {
      var group = activeGroup();
      var parkId = parseInt(group.getAttribute('data-park'), 10);
      // This whole component gets serialized (via tosource) and re-run
      // inside the settings webview, a separate JS context from PKJS — it
      // can't reach PKJS's own PARKS global, so the default-visible ids
      // travel in via this.config (set in buildClayConfig()) instead.
      var defaults = null;
      for (var p = 0; p < config.parks.length; p++) {
        if (parseInt(config.parks[p].parkId, 10) === parkId) { defaults = config.parks[p].defaultVisible; break; }
      }
      var cbs = group.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) {
        cbs[i].checked = defaults.indexOf(parseInt(cbs[i].getAttribute('data-id'), 10)) !== -1;
      }
      setActivePreset(e.currentTarget);
    });

    // Shows a ride's info page in an overlay <iframe> on top of this same
    // page — nothing ever navigates away, so there's nothing to lose and no
    // save is needed. A handful of official park sites (not Coasterpedia)
    // block being framed and will just show blank here; Back still works.
    //
    // The phone's back-swipe/back-button gesture is handled by the host
    // app's webview container, not this page's JS, and with the overlay
    // just a plain DOM element (no navigation happened) it would otherwise
    // fall straight through to closing the whole settings screen. Pushing
    // a history entry when the overlay opens gives the gesture something
    // of ours to pop first — both a real WKWebView/Android WebView back
    // gesture and this page's own "history.back()" call below consult the
    // same document session-history stack, so either one fires 'popstate'
    // here instead of reaching the container.
    //
    // On-device symptom that led to the iframe recreation below: the first
    // ride's info page closes correctly on a back-swipe, but a second (or
    // later) ride's swipe shows a blank white iframe while this page's OWN
    // overlay bar/button stay visible and working — meaning the top-level
    // page and its history handling are fine (confirmed independently: a
    // full open/close/reopen/close cycle produces exactly the expected
    // history-state sequence, no discrepancy). The blank content is
    // specifically inside the <iframe>, which points at the iframe's own
    // navigation state rather than this page's — reusing one <iframe> and
    // just changing its `src` on every open leaves it holding whatever
    // cross-origin navigation history the *previous* ride's page
    // accumulated, which a swipe gesture may partially target instead of
    // (or in addition to) this page's own. A freshly created <iframe> per
    // open has no such history to conflict with.
    function openInfoOverlay(url) {
      var oldFrame = document.getElementById('infoFrame');
      var freshFrame = document.createElement('iframe');
      freshFrame.id = 'infoFrame';
      freshFrame.src = url;
      oldFrame.parentNode.replaceChild(freshFrame, oldFrame);
      document.getElementById('infoOverlay').classList.add('open');
      history.pushState({ infoOverlay: true }, '');
    }

    function closeInfoOverlay() {
      document.getElementById('infoOverlay').classList.remove('open');
      var oldFrame = document.getElementById('infoFrame');
      var freshFrame = document.createElement('iframe');
      freshFrame.id = 'infoFrame';
      oldFrame.parentNode.replaceChild(freshFrame, oldFrame);
    }
    window.addEventListener('popstate', closeInfoOverlay);

    root.addEventListener('click', function (e) {
      if (e.target.classList && e.target.classList.contains('infolink')) {
        e.stopPropagation();
        openInfoOverlay(e.target.getAttribute('data-url'));
      }
    });
    root.querySelector('#infoOverlayClose').addEventListener('click', function () {
      // Goes through popstate (like the back gesture does) rather than
      // calling closeInfoOverlay() directly, so a still-pending pushState
      // entry never lingers to eat the *next* back gesture instead.
      history.back();
    });
  }
};

// Gets serialized (via tosource) and re-run entirely inside the settings
// webview — a separate JS context from PKJS that never shares a closure
// with it, so everything this needs must either be a nested function
// declared inside here or a real webview global (document/window).
function claySettingsCustomFn() {
  var clayConfig = this;

  function injectGlobalClayStyle() {
    var style = document.createElement('style');
    style.textContent =
      // Defensive reset: a Clay-rendered element that ends up wider than
      // the viewport (padding/borders added on top of a percentage width,
      // rather than counted inside it) widens the whole settings frame.
      // border-box plus a hard overflow clamp keeps any one such element
      // from doing that to the entire page.
      '*{box-sizing:border-box;}' +
      'html,body{max-width:100%;overflow-x:hidden;}' +
      'body{background:#1c1c1c;color:#eee;}' +
      '.section{border-bottom:1px solid #333;padding-bottom:4px;}' +
      '.rl-park.hide{display:none;}' +
      '.attribution{text-align:center;margin:20px 0 10px;padding:10px 0;font-size:13px;color:#aaa;}' +
      '.attribution a{color:#7ab8ff;}';
    document.head.appendChild(style);

    var attribution = document.createElement('div');
    attribution.className = 'attribution';
    attribution.innerHTML = 'Powered by ' +
      '<a href="https://queue-times.com/en-US" target="_blank">Queue-Times.com</a>';
    document.body.appendChild(attribution);
  }

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    injectGlobalClayStyle();
  });
}

// Rebuilt fresh on every open (like the old buildConfigHtml()) so it always
// reflects whatever was last actually saved — reuses every existing data
// lookup (getBandConfig, getSelectedParkId, getVisibleIdSet, PARKS) as-is;
// only how the page gets built from that data has changed.
function buildClayConfig() {
  var bands = getBandConfig();
  var parkId = getSelectedParkId();

  var parkOptions = [];
  var parksData = [];
  for (var pid in PARKS) {
    if (!PARKS.hasOwnProperty(pid)) continue;
    parkOptions.push({ label: PARKS[pid].name, value: pid });

    var visible = getVisibleIdSet(parseInt(pid, 10));
    var lands = [];
    var roster = PARKS[pid].roster;
    for (var i = 0; i < roster.length; i++) {
      var rides = [];
      for (var j = 0; j < roster[i].rides.length; j++) {
        var r = roster[i].rides[j];
        // energylandia.pl sets X-Frame-Options: SAMEORIGIN (verified via
        // header check) — it refuses to load in the info overlay's iframe,
        // so those links are worse than no link at all; omit them entirely.
        var infoUrl = (r.infoUrl && r.infoUrl.indexOf('energylandia.pl') === -1) ? r.infoUrl : '';
        rides.push({ id: r.id, name: r.name, infoUrl: infoUrl, checked: visible.has(r.id) });
      }
      lands.push({ name: roster[i].land, rides: rides });
    }
    parksData.push({ parkId: pid, lands: lands, defaultVisible: PARKS[pid].defaultVisible });
  }

  return [
    { type: 'heading', defaultValue: 'CoasterWatch Settings', size: 3 },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Park', size: 4 },
      { type: 'select', id: 'park', messageKey: 'park', label: 'Park',
        defaultValue: String(parkId), options: parkOptions }
    ] },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Tile Colours', size: 4 },
      { type: 'slider', id: 't1', messageKey: 't1', label: 'Short wait under (min)',
        defaultValue: bands.t1, min: 1, max: 60, step: 1 },
      { type: 'slider', id: 't2', messageKey: 't2', label: 'Medium wait under (min)',
        defaultValue: bands.t2, min: 1, max: 60, step: 1 },
      { type: 'color', id: 'c0', messageKey: 'c0', label: 'Short wait colour',
        defaultValue: argb8ToRgb24(bands.c0), layout: CLAY_COLOR_LAYOUT },
      { type: 'color', id: 'c1', messageKey: 'c1', label: 'Medium wait colour',
        defaultValue: argb8ToRgb24(bands.c1), layout: CLAY_COLOR_LAYOUT },
      { type: 'color', id: 'c2', messageKey: 'c2', label: 'Long wait colour',
        defaultValue: argb8ToRgb24(bands.c2), layout: CLAY_COLOR_LAYOUT },
      { type: 'color', id: 'cAlert', messageKey: 'cAlert', label: 'Alert triggered colour',
        defaultValue: argb8ToRgb24(bands.cAlert), layout: CLAY_COLOR_LAYOUT }
    ] },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Alerts', size: 4 },
      { type: 'select', id: 'vibePattern', messageKey: 'vibePattern', label: 'Vibration pattern',
        defaultValue: String(bands.vibePattern),
        options: VIBE_PATTERN_NAMES.map(function (name, i) { return { label: name, value: String(i) }; }) }
    ] },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Rides', size: 4 },
      { type: 'ridelist', id: 'rides', messageKey: 'visibleRideIds', activeParkId: parkId, parks: parksData }
    ] },
    { type: 'submit', defaultValue: 'Save' }
  ];
}

Pebble.addEventListener('showConfiguration', function () {
  var clay = new Clay(buildClayConfig(), claySettingsCustomFn, { autoHandleEvents: false });
  clay.registerComponent(RIDE_LIST_COMPONENT);
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e.response) return;
  try {
    // getSettings() only needs localStorage, not a fully-configured
    // instance — an empty config is fine for parsing the response.
    var raw = new Clay([], null, { autoHandleEvents: false }).getSettings(e.response, false);
    var refresh = false;

    if (raw.park && raw.park.value !== undefined) {
      var newParkId = parseInt(raw.park.value, 10);
      if (newParkId !== getSelectedParkId()) refresh = true;
      localStorage.setItem(PARK_KEY, String(newParkId));
    }

    if (raw.visibleRideIds && raw.visibleRideIds.value) {
      localStorage.setItem(visibleKeyForPark(getSelectedParkId()), JSON.stringify(raw.visibleRideIds.value));
      refresh = true;
    }

    if (raw.t1 && raw.t2 && raw.c0 && raw.c1 && raw.c2 && raw.cAlert) {
      var newBands = {
        t1: parseInt(raw.t1.value, 10) || DEFAULT_BANDS.t1,
        t2: parseInt(raw.t2.value, 10) || DEFAULT_BANDS.t2,
        c0: rgb24ToArgb8(parseInt(raw.c0.value, 10)),
        c1: rgb24ToArgb8(parseInt(raw.c1.value, 10)),
        c2: rgb24ToArgb8(parseInt(raw.c2.value, 10)),
        cAlert: rgb24ToArgb8(parseInt(raw.cAlert.value, 10)),
        vibePattern: raw.vibePattern ? parseInt(raw.vibePattern.value, 10) : DEFAULT_BANDS.vibePattern
      };
      localStorage.setItem(BANDS_KEY, JSON.stringify(newBands));
      sendBandConfig();
      refresh = true;
    }

    if (refresh) fetchQueueTimes();
  } catch (ex) {
    console.log('CoasterWatch: bad config response: ' + ex);
  }
});
