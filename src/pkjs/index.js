// PebbleKit JS companion: runs on the phone. Fetches live queue times for
// whichever park is currently selected (see PARKS below) from
// queue-times.com, attaches distance-to-ride from the phone's GPS, records
// samples locally to build today's history (the API has no historical
// endpoint), and streams everything to the watch.

var Clay = require('@rebble/clay');
var messageKeys;
try { messageKeys = require('message_keys'); } catch (e) { messageKeys = {}; }

var HARDCODED_KEYS = {
  RequestRefresh: 10000,
  RidesData: 10001,
  TotalCount: 10002,
  RideIndex: 10003,
  RideId: 10004,
  RideName: 10005,
  RideWait: 10006,
  RideDistance: 10007,
  ErrorMsg: 10008,
  RequestGraph: 10009,
  GraphData: 10010,
  GraphCount: 10011,
  GraphIndex: 10012,
  GraphWait: 10013,
  GraphMinuteOfDay: 10014,
  GraphError: 10015,
  BandThreshold1: 10016,
  BandThreshold2: 10017,
  BandColor0: 10018,
  BandColor1: 10019,
  BandColor2: 10020,
  AlertColor: 10021,
  VibePattern: 10022,
  RideLogStart: 10023,
  RideLogChunk: 10024,
  RideLogEnd: 10025,
  RideLogRideName: 10026,
  RideLogRideId: 10027,
  RideLogDuration: 10028,
  RideLogMaxG: 10029,
  RideLogMinG: 10030,
  RideLogAirtimeMs: 10031,
  RideLogAirtimeHills: 10032,
  RideLogTurns: 10033,
  RideLogTotalSamples: 10034,
  RideLogAvgG: 10035,
  RideLogMaxAirtimeMs: 10036,
  RideLogHighGMs: 10037,
  RideLogRotationDeg: 10038,
  RideLogRoughness: 10039,
  RideLogSampleIntervalMs: 10040,
  RideLogTruncated: 10041,
  RideLogClipped: 10042
};

function getMsgValue(dict, keyName) {
  if (!dict) return undefined;
  if (dict[keyName] !== undefined) return dict[keyName];
  var numKey = (messageKeys && messageKeys[keyName]) || HARDCODED_KEYS[keyName];
  if (numKey !== undefined) {
    if (dict[numKey] !== undefined) return dict[numKey];
    if (dict[String(numKey)] !== undefined) return dict[String(numKey)];
  }
  return undefined;
}

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
// is what's actually sent/persisted, not the name. "Triple Buzz" is this
// app's own; the other three reproduce the PebbleOS vibe score of the same
// name exactly (see the VIBE_PATTERNS comment in main.c for the timings and
// where they came from).
var VIBE_PATTERN_NAMES = ['Triple Buzz', 'Standard', 'Nudge Nudge', 'Jackhammer'];

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

// Last successful GPS fix, kept so a ride log can be stamped with a location
// without waiting on its own (slow, and possibly denied) geolocation call —
// stopping a recording has to persist immediately. Refreshed by every queue
// refresh, so in practice it's minutes old at worst. Deliberately stored with
// `latitude`/`longitude` names: that's the shape the ride-log/CSV/GeoJSON
// consumers use, whereas getLocation's own callback speaks `lat`/`lng` for
// the distance maths. Null until the first fix (or forever, if the phone
// refuses location) — every reader must handle that.
var s_cached_location = null;

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
    s_cached_location = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    cb({ lat: pos.coords.latitude, lng: pos.coords.longitude });
  }, function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(null);
  }, { timeout: 7000, maximumAge: 300000 });
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

// Minute-of-day (phone-local), 60 minutes before the active park's cached
// opening time - null if no cached schedule is available yet. Some parks
// let guests in a little before the official opening time, hence the hour
// of slack rather than filtering right at the opening minute. Reuses the
// schedule already fetched/cached for the closed-ride override (see
// isParkOpenNow above) rather than being a new network dependency of its
// own. Converts through the phone's own Date methods (always local by JS
// spec), same reasoning as isParkOpenNow - the park and phone/watch can be
// in different timezones.
function graphFloorMinuteOfDay() {
  var schedule = loadCachedSchedule(getSelectedParkId());
  if (!schedule || !schedule.openingTime) return null;
  var openMs = Date.parse(schedule.openingTime);
  if (isNaN(openMs)) return null;
  var floor = new Date(openMs - 60 * 60 * 1000);
  return ((floor.getHours() * 60 + floor.getMinutes()) % 1440 + 1440) % 1440;
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  var out = [];
  for (var i = 0; i < maxPoints; i++) {
    var idx = Math.round(i * (arr.length - 1) / (maxPoints - 1));
    out.push(arr[idx]);
  }
  return out;
}

// Returns [{wait, minuteOfDay}, ...] oldest-first, or null if fewer than 2
// samples exist today. minuteOfDay is the sample's actual clock time
// (0-1439), sent along purely for the watch's axis-endpoint labels and to
// let it detect/mark a big gap between two consecutive points — the watch
// spaces points evenly by index, not by elapsed time, precisely so a gap
// doesn't stretch the axis to cover a long dead stretch and squeeze
// everything else into a sliver. Samples from before the park could
// plausibly have been open (see graphFloorMinuteOfDay) are dropped
// entirely — there's no legitimate reading from before the park opened.
// Everything after that is the real recorded day and is kept, thinned
// evenly across the whole span to fit MAX_GRAPH_POINTS.
//
// Deliberately does NOT special-case gaps any more. An earlier attempt
// split the day at >60min gaps and compressed every "older" session to a
// couple of marker points, on the assumption such a session was stray
// junk. That's wrong for how the app is actually used: a Pebble watchapp
// only records while it's the running app, so a normal day of real use is
// naturally many bursts separated by long gaps — and compressing them
// threw away most of the day's genuine queue history (a 2.5-hour block of
// real samples collapsing to 2 points). Gaps cost no horizontal space
// under index-based spacing anyway, and the pre-opening floor above
// already removes the junk that motivated the split; the watch still
// marks a gap by skipping the connecting line (GRAPH_GAP_MINUTES).
function getGraphPoints(rideId) {
  var hist = loadHistory();
  var arr = hist.rides[rideId];
  if (!arr || arr.length < 2) return null;

  var floor = graphFloorMinuteOfDay();
  if (floor !== null) {
    arr = arr.filter(function (s) { return s[0] >= floor; });
    if (arr.length < 2) return null;
  }

  var sampled = downsample(arr, MAX_GRAPH_POINTS);

  var out = [];
  for (var j = 0; j < sampled.length; j++) {
    out.push({ wait: sampled[j][1], minuteOfDay: sampled[j][0] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending to the watch

// Same superseded-stream guard as graphRequestSeq below, for the same
// reason: two overlapping fetchQueueTimes completions (the periodic timer
// racing a settings-close refresh, or a park switch while the previous
// chain is still retrying through a Bluetooth hiccup) would otherwise
// interleave two send chains — and after a park switch, the stale chain
// would keep writing the *old park's* rides into the new list's indices.
// The retry path especially needs this: it re-fires on a 500ms timer for
// as long as sends keep failing, with no other bound.
// Packs the ride roster into a single compact binary payload (RidesData key)
// and sends it in ONE AppMessage packet, eliminating 20+ sequential Bluetooth
// round-trips that took 2-3 seconds.
// Format:
//   Byte 0: ride_count (N <= 40)
//   For each ride:
//     4 bytes: ride_id (int32 big-endian)
//     2 bytes: wait_minutes (int16 big-endian, -1 for closed)
//     4 bytes: distance_m (int32 big-endian, -1 for unknown)
//     1 byte:  name_length (L)
//     L bytes: UTF-8 name characters
var s_last_sent_rides_bytes = null;

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Ride ids with at least one telemetry recording saved today, so the grid can
// mark them. Date comparison lives here rather than on the watch because the
// phone owns anything timezone-aware — todayStr() is local-time, and matches
// the convention the queue history already uses.
function ridesLoggedToday() {
  var set = {};
  try {
    var logs = JSON.parse(localStorage.getItem('coasterwatch_ride_logs') || '[]');
    var today = todayStr();
    for (var i = 0; i < logs.length; i++) {
      var r = logs[i];
      if (r.rideId === undefined || r.rideId === null || !r.recordedAt) continue;
      var d = new Date(r.recordedAt);
      if (isNaN(d.getTime())) continue;
      var stamp = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
      if (stamp === today) set[String(r.rideId)] = true;
    }
  } catch (e) { /* a corrupt store just means no ticks */ }
  return set;
}

// Per-ride flag bits in the RidesData wire format. Bit 0 is "logged today";
// the byte exists so the next one of these doesn't need another format change.
var RIDE_FLAG_LOGGED_TODAY = 1;

// The last list actually sent, so a finished recording can re-send with the
// tick flag flipped without waiting for (or paying for) a network refresh.
var s_last_rides_sent = null;

function sendRidesToWatch(rides, forceSend) {
  var capped = rides.slice(0, MAX_RIDES);
  s_last_rides_sent = capped;
  var loggedToday = ridesLoggedToday();
  var bytes = [capped.length];
  for (var i = 0; i < capped.length; i++) {
    var r = capped[i];
    var id = r.id;
    bytes.push((id >> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF);
    var w = r.is_open ? r.wait_time : -1;
    bytes.push((w >> 8) & 0xFF, w & 0xFF);
    var d = (r._distance !== undefined) ? r._distance : -1;
    bytes.push((d >> 24) & 0xFF, (d >> 16) & 0xFF, (d >> 8) & 0xFF, d & 0xFF);
    bytes.push(loggedToday[String(id)] ? RIDE_FLAG_LOGGED_TODAY : 0);
    var nameStr = cleanName(r.name);
    var utf8Name = unescape(encodeURIComponent(nameStr));
    bytes.push(utf8Name.length);
    for (var k = 0; k < utf8Name.length; k++) {
      bytes.push(utf8Name.charCodeAt(k));
    }
  }

  // Battery saver: skip transmitting over Bluetooth if data has not changed
  if (!forceSend && s_last_sent_rides_bytes && arraysEqual(bytes, s_last_sent_rides_bytes)) {
    console.log('CoasterWatch: Queue data unchanged, skipped redundant Bluetooth sync');
    return bytes;
  }
  s_last_sent_rides_bytes = bytes;

  Pebble.sendAppMessage({ 'RidesData': bytes }, function () {}, function () {
    console.log('CoasterWatch: failed to send RidesData');
  });
  return bytes;
}

function sendError(msg) {
  Pebble.sendAppMessage({ 'ErrorMsg': msg.substring(0, 40) });
}

// Packs all points into a single compact binary byte array and sends it in ONE
// AppMessage transaction (GraphData key), replacing the old 25-message serial
// stream that took 2.5-3.5 seconds over Bluetooth LE.
// Format per point (3 bytes):
//   Byte 0: wait_time (0..250, or 255 for -1/closed)
//   Byte 1: minute_of_day >> 8 (high byte)
//   Byte 2: minute_of_day & 0xFF (low byte)
function sendGraph(rideId) {
  var points = getGraphPoints(rideId);
  if (!points || points.length === 0) {
    Pebble.sendAppMessage({ 'GraphError': 'Not enough data recorded yet today' });
    return;
  }
  var bytes = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var w = (p.wait < 0) ? 255 : (p.wait > 250 ? 250 : p.wait);
    bytes.push(w);
    bytes.push((p.minuteOfDay >> 8) & 0xFF);
    bytes.push(p.minuteOfDay & 0xFF);
  }
  Pebble.sendAppMessage({ 'GraphData': bytes }, function () {}, function () {
    console.log('CoasterWatch: failed to send GraphData');
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

// ---------------------------------------------------------------------------
// Main fetch cycle

function fetchQueueTimes(forceSend) {
  var apiUrl = 'https://queue-times.com/parks/' + getSelectedParkId() + '/queue_times.json';
  var park = getActivePark();

  var locationResult = undefined;
  var queueTimesData = undefined;
  var queueTimesErr = null;
  var hasProcessed = false;

  function tryProcess() {
    if (locationResult === undefined || (queueTimesData === undefined && !queueTimesErr)) {
      return; // Still waiting for parallel requests to settle
    }
    if (hasProcessed) return;
    hasProcessed = true;

    if (queueTimesErr || !queueTimesData) {
      sendError(queueTimesErr || 'Fetch failed');
      return;
    }

    try {
      var data = JSON.parse(queueTimesData);
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
        attachDistances(filtered, locationResult);
        sendRidesToWatch(filtered, forceSend);
      });
    } catch (e) {
      sendError('Bad response from server');
    }
  }

  // Fire GPS and network requests concurrently
  getLocation(function (loc) {
    locationResult = loc;
    tryProcess();
  });

  xhrRequest(apiUrl, 'GET', function (responseText) {
    queueTimesData = responseText;
    tryProcess();
  }, function (errMsg) {
    queueTimesErr = 'Fetch failed: ' + errMsg;
    tryProcess();
  });
}

// ---------------------------------------------------------------------------
// Ride Sensor Logger & 3D Telemetry Session Management

var s_active_ride_session = null;

function buildCsvString(ride) {
  if (!ride) return '';
  var csvRows = ['timestamp_ms,accel_x,accel_y,accel_z,total_g,heading_deg,latitude,longitude'];
  var lat = (ride.gps && ride.gps.lat) ? ride.gps.lat : '';
  var lon = (ride.gps && ride.gps.lon) ? ride.gps.lon : '';
  if (ride.samples) {
    ride.samples.forEach(function (s) {
      csvRows.push([s[0], s[1], s[2], s[3], s[4], s[5], lat, lon].join(','));
    });
  }
  return csvRows.join('\n');
}

function downsamplePoints(pts, maxPts) {
  if (!pts || pts.length <= maxPts) return pts || [];
  var out = [];
  var step = (pts.length - 1) / (maxPts - 1.0);
  for (var k = 0; k < maxPts; k++) {
    out.push(pts[Math.floor(k * step)]);
  }
  return out;
}

function persistRideLogs(session) {
  if (!session) return;
  try {
    var compactSession = {
      id: session.id,
      rideId: session.rideId,
      rideName: session.rideName,
      park: session.park,
      recordedAt: session.recordedAt,
      durationSec: session.durationSec,
      sampleRateHz: session.sampleRateHz,
      sampleIntervalMs: session.sampleIntervalMs,
      truncated: session.truncated,
      clippedSamples: session.clippedSamples,
      summary: session.summary,
      gps: session.gps,
      githubUrl: session.githubUrl,
      githubSynced: session.githubSynced,
      samples: (session.samples && session.samples.length > 200) ? downsamplePoints(session.samples, 200) : (session.samples || [])
    };

    var existing = JSON.parse(localStorage.getItem('coasterwatch_ride_logs') || '[]');
    var foundIdx = -1;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].id === compactSession.id) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx >= 0) {
      existing[foundIdx] = compactSession;
    } else {
      existing.unshift(compactSession);
    }
    if (existing.length > 10) existing = existing.slice(0, 10);
    localStorage.setItem('coasterwatch_ride_logs', JSON.stringify(existing));
    console.log('CoasterWatch: Persisted ride log for ' + compactSession.rideName + ' (total rides: ' + existing.length + ')');
  } catch (e) {
    console.log('CoasterWatch: Failed to persist ride log: ' + e);
  }
}

// Removes rides from this phone's store. GitHub copies are deliberately left
// alone — the repo is an archive, and someone clearing space on their phone
// has not asked to destroy their uploaded telemetry. Returns how many went.
function deleteRideLogs(ids) {
  if (!ids || !ids.length) return 0;
  var doomed = {};
  for (var i = 0; i < ids.length; i++) doomed[String(ids[i])] = true;
  try {
    var existing = JSON.parse(localStorage.getItem('coasterwatch_ride_logs') || '[]');
    var kept = existing.filter(function (r) { return !doomed[String(r.id)]; });
    var removed = existing.length - kept.length;
    if (removed > 0) localStorage.setItem('coasterwatch_ride_logs', JSON.stringify(kept));
    return removed;
  } catch (e) {
    console.log('CoasterWatch: Failed to delete ride logs: ' + e);
    return 0;
  }
}

function handleRideLogStart(dict) {
  var rideId = getMsgValue(dict, 'RideLogRideId');
  var rideName = getMsgValue(dict, 'RideLogRideName') || 'Coaster';
  var durationSec = getMsgValue(dict, 'RideLogDuration') || 0;
  var maxGVal = getMsgValue(dict, 'RideLogMaxG');
  var minGVal = getMsgValue(dict, 'RideLogMinG');
  var maxG = (maxGVal !== undefined ? maxGVal : 1000) / 1000.0;
  var minG = (minGVal !== undefined ? minGVal : 1000) / 1000.0;
  var avgGVal = getMsgValue(dict, 'RideLogAvgG');
  var avgG = (avgGVal !== undefined ? avgGVal : 0) / 1000.0;
  var airtimeMs = getMsgValue(dict, 'RideLogAirtimeMs') || 0;
  var airtimeHills = getMsgValue(dict, 'RideLogAirtimeHills') || 0;
  var maxAirtimeMs = getMsgValue(dict, 'RideLogMaxAirtimeMs') || 0;
  var highGMs = getMsgValue(dict, 'RideLogHighGMs') || 0;
  var turns = getMsgValue(dict, 'RideLogTurns') || 0;
  var rotationDeg = getMsgValue(dict, 'RideLogRotationDeg') || 0;
  var roughness = getMsgValue(dict, 'RideLogRoughness') || 0;
  var truncated = !!getMsgValue(dict, 'RideLogTruncated');
  var clippedSamples = getMsgValue(dict, 'RideLogClipped') || 0;
  var totalSamples = getMsgValue(dict, 'RideLogTotalSamples') || 0;

  // The watch measures its own mean sample interval (in tenths of a ms) rather
  // than us assuming the nominal 25Hz, so exported timestamps reflect what the
  // accelerometer actually did. Fall back to 40ms if it's absent or absurd.
  var intervalTenths = getMsgValue(dict, 'RideLogSampleIntervalMs');
  var sampleIntervalMs = 40;
  if (intervalTenths && intervalTenths >= 40 && intervalTenths <= 2000) {
    sampleIntervalMs = intervalTenths / 10.0;
  }

  var activePark = getActivePark();
  var parkName = (activePark && activePark.name) ? activePark.name : 'Theme Park';

  s_active_ride_session = {
    id: 'ride_' + Date.now() + '_' + (rideId !== undefined ? rideId : 'gen'),
    rideId: rideId,
    rideName: rideName,
    park: parkName,
    recordedAt: new Date().toISOString(),
    durationSec: durationSec,
    sampleIntervalMs: sampleIntervalMs,
    sampleRateHz: Math.round(10000 / sampleIntervalMs) / 10,
    truncated: truncated,
    // Samples where an axis sat on the accelerometer's +/-4g rail, so the peak
    // is a floor rather than a measurement.
    clippedSamples: clippedSamples,
    summary: {
      // maxG/minG/avgG are acceleration *magnitudes* in g. minG therefore
      // bottoms out at 0 (free-fall) and is never negative — the watch has no
      // gyro, so it cannot resolve signed vertical G. See tracker_summary_min_g
      // in src/c/main.c.
      maxG: maxG,
      minG: minG,
      avgG: avgG,
      airtimeSec: Math.round((airtimeMs / 1000.0) * 10) / 10,
      airtimeHills: airtimeHills,
      maxAirtimeSec: Math.round((maxAirtimeMs / 1000.0) * 10) / 10,
      highGSec: Math.round((highGMs / 1000.0) * 10) / 10,
      // Yaw turns of >=90 degrees, and total yaw swept. NOT inversions: a
      // compass bearing cannot see a loop (same bearing in and out) and would
      // flag a flat helix instead.
      turns: turns,
      rotationDeg: rotationDeg,
      // Mean |d|a|/dt| in mg/s — how rattly the ride was.
      roughness: roughness,
      totalSamples: totalSamples
    },
    gps: s_cached_location ? {
      lat: s_cached_location.latitude,
      lon: s_cached_location.longitude
    } : null,
    samples: []
  };
  console.log('CoasterWatch: Started ride log for ' + rideName + ' (expected ' + totalSamples + ' samples)');
  persistRideLogs(s_active_ride_session);
}

// AppMessage byte arrays do not arrive as the same JS type everywhere, so
// dispatch on array-*likeness* rather than on `typeof`/`Array.isArray`:
//
//   real phone      -> a genuine Array (or a typed array)
//   pypkjs emulator -> a `JSArray`, STPyV8's wrapper around the Python list.
//                      It has .length and numeric indices and works with
//                      Array.prototype.slice, but Array.isArray() is false
//                      and `typeof` reports "function" (!), not "object".
//
// That last quirk is what made the old `typeof data === 'object'` branch fall
// straight through to `return []`, so every RideLogChunk decoded to zero
// samples and rides synced with metadata but no telemetry. Test the shape,
// not the tag.
function toByteArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  // Strings have .length too, so they must be handled before the array-like
  // check below.
  if (typeof data === 'string') {
    var strArr = [];
    for (var s = 0; s < data.length; s++) {
      strArr.push(data.charCodeAt(s) & 0xFF);
    }
    return strArr;
  }

  if (data instanceof ArrayBuffer) {
    return Array.prototype.slice.call(new Uint8Array(data));
  }
  if (data.buffer instanceof ArrayBuffer) {
    // Typed-array view: honour byteOffset/byteLength rather than re-reading
    // the whole backing buffer.
    return Array.prototype.slice.call(
        new Uint8Array(data.buffer, data.byteOffset || 0,
                       data.byteLength !== undefined ? data.byteLength : undefined));
  }

  // Anything array-like: real Arrays are already handled, this catches the
  // emulator's JSArray and any host wrapper that walks like an array.
  if (typeof data.length === 'number' && data.length >= 0) {
    return Array.prototype.slice.call(data);
  }

  // Last resort: a plain object with numeric keys.
  if (typeof data === 'object' || typeof data === 'function') {
    var arr = [];
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!isNaN(k)) {
        arr[parseInt(k, 10)] = data[k];
      }
    }
    return arr;
  }
  return [];
}

function handleRideLogChunk(rawBytes) {
  var bytes = toByteArray(rawBytes);
  if (!bytes || bytes.length < 3) return;

  if (!s_active_ride_session) {
    handleRideLogStart({});
  }

  var seq = (bytes[0] << 8) | bytes[1];
  var count = bytes[2];
  var offset = 3;

  for (var i = 0; i < count && offset + 8 <= bytes.length; i++) {
    var ax = (bytes[offset] << 8) | bytes[offset + 1];
    if (ax >= 32768) ax -= 65536;
    var ay = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (ay >= 32768) ay -= 65536;
    var az = (bytes[offset + 4] << 8) | bytes[offset + 5];
    if (az >= 32768) az -= 65536;
    var heading = ((bytes[offset + 6] << 8) | bytes[offset + 7]) / 10.0;
    offset += 8;

    var intervalMs = s_active_ride_session.sampleIntervalMs || 40;
    var tMs = Math.round((seq + i) * intervalMs);
    var totalG = Math.sqrt(ax * ax + ay * ay + az * az) / 1000.0;
    s_active_ride_session.samples.push([tMs, ax, ay, az, Math.round(totalG * 100) / 100, heading]);
  }
  if (s_active_ride_session.samples.length % 500 === 0) {
    persistRideLogs(s_active_ride_session);
  }
}

var GITHUB_TOKEN_KEY = 'github_sync_token';
var GITHUB_REPO_KEY = 'github_sync_repo';
var GITHUB_ENABLED_KEY = 'github_sync_enabled';

// Defaults ON so an existing configured install keeps syncing after this
// toggle was introduced — only an explicit "0" turns it off.
function isGitHubSyncEnabled() {
  return localStorage.getItem(GITHUB_ENABLED_KEY) !== '0';
}
// Empty by default: the real value lives in this phone's localStorage, set
// once from the settings page. Hardcoding a personal repo here would ship it
// as every other installer's default.
var DEFAULT_GITHUB_REPO = '';
var DEFAULT_GITHUB_TOKEN = '';

function utf8ToBase64(str) {
  if (typeof btoa === 'function') {
    try {
      return btoa(unescape(encodeURIComponent(str)));
    } catch (e) {}
  }
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var encoded = [];
  var c1, c2, c3, e1, e2, e3, e4;
  var utf8 = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 128) utf8.push(c);
    else if (c < 2048) {
      utf8.push((c >> 6) | 192);
      utf8.push((c & 63) | 128);
    } else {
      utf8.push((c >> 12) | 224);
      utf8.push(((c >> 6) & 63) | 128);
      utf8.push((c & 63) | 128);
    }
  }
  var pos = 0;
  while (pos < utf8.length) {
    c1 = utf8[pos++];
    c2 = utf8[pos++];
    c3 = utf8[pos++];
    e1 = c1 >> 2;
    e2 = ((c1 & 3) << 4) | (c2 >> 4);
    e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | (c3 >> 6));
    e4 = isNaN(c2) || isNaN(c3) ? 64 : (c3 & 63);
    encoded.push(chars.charAt(e1), chars.charAt(e2), chars.charAt(e3), chars.charAt(e4));
  }
  return encoded.join('');
}

function uploadFileToGitHubRepo(repo, token, path, content, message, cb) {
  var url = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  var body = JSON.stringify({
    message: message,
    content: utf8ToBase64(content)
  });

  var xhr = new XMLHttpRequest();
  xhr.open('PUT', url, true);
  var authHeader = (token.indexOf('Bearer ') === 0 || token.indexOf('token ') === 0) ? token : 'Bearer ' + token;
  xhr.setRequestHeader('Authorization', authHeader);
  xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 25000;

  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      cb(true, null);
    } else {
      cb(false, 'HTTP ' + xhr.status + ': ' + xhr.responseText);
    }
  };
  xhr.onerror = function () { cb(false, 'Network error'); };
  xhr.ontimeout = function () { cb(false, 'Timeout'); };
  xhr.send(body);
}

function uploadRideToGitHub(session, callback) {
  if (!session) return;
  if (!isGitHubSyncEnabled()) {
    console.log('CoasterWatch: Cloud sync is off — ride saved locally only.');
    if (callback) callback(false, 'Cloud sync disabled');
    return;
  }
  var token = localStorage.getItem(GITHUB_TOKEN_KEY) || DEFAULT_GITHUB_TOKEN;
  var repo = localStorage.getItem(GITHUB_REPO_KEY) || DEFAULT_GITHUB_REPO;
  if (!token || !repo) {
    // Logged rather than swallowed: an unconfigured token is indistinguishable
    // from a working sync otherwise — the watch still says "Saved" (that only
    // reports the watch->phone leg), so the only symptom is an empty repo.
    console.log('CoasterWatch: Skipping GitHub sync — no ' +
                (!token ? 'token' : 'repo') + ' configured. Set one in the app settings page.');
    if (callback) callback(false, 'No GitHub token configured');
    return;
  }

  var safeName = (session.rideName || 'ride').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  var dateTag = new Date(session.recordedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
  var baseFilename = safeName + '_' + dateTag;

  var csvContent = buildCsvString(session);
  var jsonContent = JSON.stringify(session, null, 2);

  var csvPath = 'rides/' + baseFilename + '.csv';
  var jsonPath = 'rides/' + baseFilename + '.json';

  console.log('CoasterWatch: Auto-syncing ' + csvPath + ' to GitHub ' + repo + '...');

  uploadFileToGitHubRepo(repo, token, csvPath, csvContent, 'Add telemetry CSV for ' + (session.rideName || 'Ride'), function (okCsv, errCsv) {
    if (!okCsv) {
      console.log('CoasterWatch: Failed to upload CSV to GitHub: ' + errCsv);
      if (callback) callback(false, errCsv);
      return;
    }
    uploadFileToGitHubRepo(repo, token, jsonPath, jsonContent, 'Add telemetry 3D JSON for ' + (session.rideName || 'Ride'), function (okJson, errJson) {
      if (okJson) {
        console.log('CoasterWatch: Successfully synced ' + baseFilename + ' to GitHub!');
        var commitUrl = 'https://github.com/' + repo + '/tree/main/rides';
        session.githubUrl = commitUrl;
        session.githubSynced = true;
        persistRideLogs(session);
        if (callback) callback(true, commitUrl);
      } else {
        if (callback) callback(true, 'CSV uploaded');
      }
    });
  });
}

function handleRideLogEnd() {
  if (!s_active_ride_session) {
    handleRideLogStart({});
  }
  if (!s_active_ride_session) return;
  persistRideLogs(s_active_ride_session);
  console.log('CoasterWatch: Saved complete ride log for ' + s_active_ride_session.rideName +
              ' with ' + s_active_ride_session.samples.length + ' raw samples.');
  
  uploadRideToGitHub(s_active_ride_session);
  s_active_ride_session = null;

  // Push the grid's "logged today" ticks straight away. Re-packing the list we
  // already hold is free; waiting for the next queue refresh would leave the
  // ride you just recorded looking unlogged for minutes.
  if (s_last_rides_sent) sendRidesToWatch(s_last_rides_sent, true);
}

Pebble.addEventListener('ready', function () {
  console.log('CoasterWatch: PebbleKit JS ready');
  sendBandConfig();
  fetchQueueTimes(true);
});

Pebble.addEventListener('appmessage', function (e) {
  var dict = (e && (e.payload || e.data)) || e || {};
  var reqRefresh = getMsgValue(dict, 'RequestRefresh');
  if (reqRefresh !== undefined) {
    fetchQueueTimes(true);
  }
  var reqGraph = getMsgValue(dict, 'RequestGraph');
  if (reqGraph !== undefined) {
    sendGraph(reqGraph);
  }
  var logStart = getMsgValue(dict, 'RideLogStart');
  if (logStart !== undefined) {
    handleRideLogStart(dict);
  }
  var logChunk = getMsgValue(dict, 'RideLogChunk');
  if (logChunk !== undefined) {
    handleRideLogChunk(logChunk);
  }
  var logEnd = getMsgValue(dict, 'RideLogEnd');
  if (logEnd !== undefined) {
    handleRideLogEnd(dict);
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

// Cloud sync lives inside the Ride Recordings section, because it exists only
// to serve recordings — it has no meaning on its own. It's set-once config, so
// the common action (toggling sync) sits on the summary row at one tap, and
// the credentials hide behind a disclosure rather than occupying prime space
// above the data they serve.
//
// Note the root element carries NO `section` class: buildClayConfig() puts
// this inside a Clay section already, and declaring it here too produced a
// section-within-a-section with doubled padding and borders.
var GITHUB_SYNC_COMPONENT = {
  name: 'githubsync',
  template: '<div class="component component-githubsync gh-wrap">' +
              '<div class="gh-row">' +
                '<label class="gh-toggle">' +
                  '<input type="checkbox" id="ghSyncEnabled" />' +
                  '<span>Auto-sync to GitHub</span>' +
                '</label>' +
                '<button type="button" id="ghDisclose" class="rl-btn rl-btn-ghost">Set up</button>' +
              '</div>' +
              '<div id="ghSummary" class="gh-summary"></div>' +
              '<div id="ghCreds" class="gh-creds" style="display:none;">' +
                '<label class="gh-lab">Personal access token</label>' +
                '<input type="password" id="ghSyncToken" class="gh-input" placeholder="ghp_... or github_pat_..." />' +
                '<label class="gh-lab">Repository (owner/repo)</label>' +
                '<input type="text" id="ghSyncRepo" class="gh-input" placeholder="owner/repo" />' +
                '<div class="gh-test">' +
                  '<button type="button" id="ghTestBtn" class="rl-btn rl-btn-ghost">Test connection</button>' +
                  '<span id="ghTestStatus" class="gh-status"></span>' +
                '</div>' +
              '</div>' +
            '</div>',
  style: '.gh-wrap{border-top:1px solid #3a3a3a;margin-top:10px;padding-top:10px;}' +
         '.gh-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
         '.gh-toggle{display:flex;align-items:center;gap:9px;cursor:pointer;color:#fff;font-size:13px;}' +
         '.gh-toggle input{width:18px;height:18px;flex:none;}' +
         '.gh-summary{color:#888;font-size:11px;margin-top:4px;line-height:1.4;}' +
         '.gh-creds{margin-top:10px;}' +
         '.gh-lab{font-size:11px;color:#bbb;display:block;margin-bottom:4px;}' +
         '.gh-input{width:100%;box-sizing:border-box;background:#333;color:#fff;border:1px solid #555;' +
           'border-radius:4px;padding:8px;font-size:13px;margin-bottom:9px;}' +
         '.gh-test{display:flex;align-items:center;gap:8px;}' +
         '.gh-status{font-size:11px;}',
  manipulator: {
    get: function () {
      var root = this.$element[0];
      var tokenEl = root.querySelector('#ghSyncToken');
      var repoEl = root.querySelector('#ghSyncRepo');
      var enabledEl = root.querySelector('#ghSyncEnabled');
      return {
        enabled: enabledEl ? !!enabledEl.checked : true,
        token: tokenEl ? tokenEl.value : '',
        repo: repoEl ? repoEl.value : ''
      };
    },
    set: function (val) {
      if (!val) return;
      var root = this.$element[0];
      var tokenEl = root.querySelector('#ghSyncToken');
      var repoEl = root.querySelector('#ghSyncRepo');
      var enabledEl = root.querySelector('#ghSyncEnabled');
      if (tokenEl && val.token !== undefined) tokenEl.value = val.token;
      if (repoEl && val.repo !== undefined) repoEl.value = val.repo;
      if (enabledEl && val.enabled !== undefined) enabledEl.checked = !!val.enabled;
    }
  },
  initialize: function () {
    var self = this;
    var root = self.$element[0];
    var tokenEl = root.querySelector('#ghSyncToken');
    var repoEl = root.querySelector('#ghSyncRepo');
    var enabledEl = root.querySelector('#ghSyncEnabled');
    var credsEl = root.querySelector('#ghCreds');
    var discloseEl = root.querySelector('#ghDisclose');
    var summaryEl = root.querySelector('#ghSummary');
    var testBtn = root.querySelector('#ghTestBtn');
    var testStatus = root.querySelector('#ghTestStatus');

    if (tokenEl) tokenEl.value = self.config.token || '';
    if (repoEl) repoEl.value = self.config.repo || '';
    if (enabledEl) enabledEl.checked = self.config.enabled !== false;

    // One line saying what will actually happen, so the state is legible
    // without opening the disclosure.
    function refreshSummary() {
      if (!summaryEl) return;
      var on = enabledEl && enabledEl.checked;
      var repo = (repoEl && repoEl.value.trim()) || '';
      if (!on) {
        summaryEl.textContent = 'Off — recordings stay on this phone.';
      } else if (!tokenEl || !tokenEl.value.trim()) {
        summaryEl.textContent = 'On, but no token set yet — tap Set up.';
      } else {
        summaryEl.textContent = 'Each recording is committed to ' + (repo || 'your repo') + '.';
      }
    }
    if (enabledEl) enabledEl.onchange = refreshSummary;
    if (repoEl) repoEl.oninput = refreshSummary;
    if (tokenEl) tokenEl.oninput = refreshSummary;
    refreshSummary();

    if (discloseEl && credsEl) {
      discloseEl.onclick = function (ev) {
        ev.preventDefault();
        var open = credsEl.style.display !== 'none';
        credsEl.style.display = open ? 'none' : '';
        discloseEl.textContent = open ? 'Set up' : 'Done';
      };
    }

    if (testBtn) {
      testBtn.onclick = function (e) {
        e.preventDefault();
        var tok = (tokenEl ? tokenEl.value : '').trim();
        var rep = (repoEl ? repoEl.value : '').trim();
        if (!tok || !rep) {
          testStatus.style.color = '#ffaa00';
          testStatus.textContent = 'Enter a token and repo first';
          return;
        }
        testStatus.style.color = '#7ab8ff';
        testStatus.textContent = 'Testing...';

        var authHeader = (tok.indexOf('Bearer ') === 0 || tok.indexOf('token ') === 0) ? tok : 'Bearer ' + tok;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://api.github.com/repos/' + rep, true);
        xhr.setRequestHeader('Authorization', authHeader);
        xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
        xhr.timeout = 15000;
        xhr.onload = function () {
          if (xhr.status === 200) {
            testStatus.style.color = '#4caf50';
            testStatus.textContent = '\u2713 Connected';
          } else if (xhr.status === 401) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '\u2715 401: invalid token';
          } else if (xhr.status === 404) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '\u2715 404: repo not found / needs Contents permission';
          } else if (xhr.status === 403) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '\u2715 403: forbidden';
          } else {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '\u2715 HTTP ' + xhr.status;
          }
        };
        xhr.onerror = function () {
          testStatus.style.color = '#e53935';
          testStatus.textContent = '\u2715 Network error';
        };
        xhr.ontimeout = function () {
          testStatus.style.color = '#e53935';
          testStatus.textContent = '\u2715 Timeout';
        };
        xhr.send();
      };
    }
  }
};

var RIDE_LOGS_COMPONENT = {
  name: 'ridelogs',
  // No `section` class on the root: buildClayConfig() already wraps this in a
  // Clay section, and having both produced a section-within-a-section with
  // doubled padding and borders — which is what made this block read as
  // something bundled inside Rides rather than a peer of it. The section
  // heading is now a real Clay `heading` item too, so it matches Park /
  // Tile Colours / Alerts instead of inventing its own type scale.
  template: '<div id="rideLogsSection">' +
              '<div class="rl-title">' +
                '<span class="rl-subtle"><span id="rideLogsCount">0</span> saved on this phone</span>' +
                '<button type="button" id="rlClearAll" class="rl-btn rl-btn-ghost">Delete all</button>' +
              '</div>' +
              '<div id="rlPending" class="rl-pending" style="display:none;"></div>' +
              '<div id="rideLogsContainer"></div>' +
            '</div>',
  style: '.rl-card{background:#26262b;border:1px solid #3d3d44;border-radius:9px;padding:12px 12px 10px;margin-bottom:10px;box-shadow:0 2px 6px rgba(0,0,0,0.25);box-sizing:border-box;width:100%;}' +
         '.rl-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}' +
         '.rl-name{font-weight:700;color:#f4f4f5;font-size:15px;}' +
         '.rl-chip{font-size:10px;font-weight:600;border-radius:12px;padding:2px 8px;background:#35353d;color:#a1a1aa;white-space:nowrap;}' +
         '.rl-chip-ok{background:#143820;color:#4ade80;border:1px solid #1e5a32;}' +
         '.rl-meta{color:#94949e;font-size:11px;margin-top:3px;}' +
         '.rl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px;}' +
         '.rl-cell{background:#1e1e22;border:1px solid #333338;border-radius:6px;padding:7px 5px;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:50px;box-sizing:border-box;}' +
         '.rl-val{color:#fff;font-size:15px;font-weight:700;line-height:1.15;letter-spacing:-0.2px;}' +
         '.rl-lab{color:#9e9ea4;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;margin-top:3px;line-height:1.25;text-align:center;word-break:break-word;}' +
         '.rl-warn{color:#ffb74d;background:#2d2415;border:1px solid #543e18;border-radius:5px;padding:6px 8px;font-size:11px;margin-top:8px;line-height:1.35;}' +
         '.rl-btns{display:flex !important;flex-direction:row !important;flex-wrap:nowrap !important;align-items:stretch !important;gap:6px !important;width:100% !important;box-sizing:border-box !important;margin-top:10px !important;padding-top:8px !important;border-top:1px solid #333338 !important;}' +
         '.rl-btn{flex:1 !important;min-width:0 !important;width:auto !important;max-width:none !important;background:#2a313d !important;color:#e2e8f0 !important;border:1px solid #4a5568 !important;border-radius:5px !important;padding:7px 2px !important;font-size:11px !important;font-weight:600 !important;line-height:1.2 !important;text-align:center !important;cursor:pointer !important;white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important;box-sizing:border-box !important;touch-action:manipulation;transition:background 0.15s,border-color 0.15s;}' +
         '.rl-btn:active{background:#3b4657 !important;}' +
         '.rl-count{color:#8a8a93;font-size:10.5px;white-space:nowrap;}' +
         '.rl-empty{color:#aaa;font-size:12px;padding:12px 0;line-height:1.5;}' +
         '.rl-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;}' +
         '.rl-btn-ghost{flex:0 0 auto !important;background:transparent !important;border:1px solid #555 !important;color:#ccc !important;padding:5px 10px !important;display:inline-flex !important;width:auto !important;}' +
         '.rl-btn-del{flex:1 !important;min-width:0 !important;background:transparent !important;border:1px solid #742a2a !important;color:#f87171 !important;margin-left:0 !important;padding:7px 2px !important;text-align:center !important;}' +
         '.rl-btn-del:active{background:rgba(185,28,28,0.2) !important;}' +
         '.rl-pending{background:#3a2f14;border:1px solid #6b5520;border-radius:6px;color:#ffcc66;font-size:11px;padding:8px 10px;margin-bottom:10px;line-height:1.4;}' +
         '.rl-card.rl-doomed{opacity:.45;}' +
         '.rl-card.rl-doomed .rl-name{text-decoration:line-through;}',
  manipulator: {
    // The settings page is a separate JS context from PKJS with its own
    // localStorage, so it cannot delete anything itself. The ids marked for
    // deletion travel home in the save response and the webviewclosed handler
    // does the actual removal. That is also why the UI says "on Save" rather
    // than deleting on the spot — pretending otherwise would be a lie the
    // moment someone backed out without saving.
    get: function () {
      var root = this.$element[0];
      var ids = [];
      var doomed = root.querySelectorAll('.rl-card[data-doomed="1"]');
      for (var i = 0; i < doomed.length; i++) {
        ids.push(doomed[i].getAttribute('data-ride-id'));
      }
      return ids;
    },
    set: function () {}
  },
  initialize: function () {
    var root = this.$element[0];
    var container = root.querySelector('#rideLogsContainer');
    var countSpan = root.querySelector('#rideLogsCount');
    var logs = (this.config && this.config.logs) || [];

    try {
      var localCached = JSON.parse(window.localStorage.getItem('coasterwatch_ride_logs_local') || '[]');
      if (localCached && localCached.length > 0) {
        var existingIds = {};
        logs.forEach(function (r) { existingIds[r.id] = true; });
        localCached.forEach(function (r) {
          if (!existingIds[r.id]) {
            logs.push(r);
          }
        });
      }
    } catch (e) {}

    function copyToClipboard(text, btnElement) {
      var origText = btnElement.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          btnElement.textContent = 'Copied! ✓';
          setTimeout(function () { btnElement.textContent = origText; }, 2000);
        }).catch(function () {
          fallbackCopy(text, btnElement, origText);
        });
      } else {
        fallbackCopy(text, btnElement, origText);
      }
    }

    function fallbackCopy(text, btnElement, origText) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        btnElement.textContent = 'Copied! ✓';
      } catch (err) {
        btnElement.textContent = 'Failed to copy';
      }
      setTimeout(function () { btnElement.textContent = origText; }, 2000);
      document.body.removeChild(ta);
    }

    function buildCsv(ride) {
      var csvRows = ['timestamp_ms,accel_x,accel_y,accel_z,total_g,heading_deg,latitude,longitude'];
      var lat = (ride.gps && ride.gps.lat) ? ride.gps.lat : '';
      var lon = (ride.gps && ride.gps.lon) ? ride.gps.lon : '';
      if (ride.samples) {
        ride.samples.forEach(function (s) {
          csvRows.push([s[0], s[1], s[2], s[3], s[4], s[5], lat, lon].join(','));
        });
      }
      return csvRows.join('\n');
    }

    var pendingEl = root.querySelector('#rlPending');
    var clearAllBtn = root.querySelector('#rlClearAll');

    // Reflects how many rides are marked for removal. Deliberately explicit
    // that GitHub is untouched: someone deleting from the phone should not
    // have to wonder whether their uploaded telemetry just went too.
    function refreshPending() {
      var n = container.querySelectorAll('.rl-card[data-doomed="1"]').length;
      if (!pendingEl) return;
      if (n === 0) {
        pendingEl.style.display = 'none';
        pendingEl.textContent = '';
      } else {
        pendingEl.style.display = '';
        pendingEl.textContent = n + ' ride' + (n === 1 ? '' : 's') +
          ' will be deleted from this phone when you tap Save. ' +
          'Anything already synced to GitHub stays there.';
      }
      if (clearAllBtn) {
        var total = container.querySelectorAll('.rl-card').length;
        clearAllBtn.style.display = total ? '' : 'none';
      }
    }

    function setDoomed(card, doomed) {
      card.setAttribute('data-doomed', doomed ? '1' : '0');
      if (doomed) card.classList.add('rl-doomed');
      else card.classList.remove('rl-doomed');
      var btn = card.querySelector('.rl-btn-del');
      if (btn) btn.textContent = doomed ? 'Undo' : 'Delete';
      refreshPending();
    }

    if (clearAllBtn) {
      clearAllBtn.onclick = function (ev) {
        ev.preventDefault();
        var cards = container.querySelectorAll('.rl-card');
        // If everything is already marked, the button undoes instead — no
        // way to get stuck having nuked the lot by a stray tap.
        var allDoomed = cards.length > 0;
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].getAttribute('data-doomed') !== '1') { allDoomed = false; break; }
        }
        for (var j = 0; j < cards.length; j++) setDoomed(cards[j], !allDoomed);
      };
    }

    function renderCards(rideList) {
      container.innerHTML = '';
      countSpan.textContent = String(rideList.length);

      if (rideList.length === 0) {
        container.innerHTML = '<div class="rl-empty">' +
          'No rides recorded yet.<br>' +
          'To log a ride: open any ride\'s graph view on your watch, swipe left (or long-press SELECT) to the <b>Ride G-Tracker</b>, and press SELECT to start recording!<br><br>' +
          '<button type="button" id="rlBtnDemo" class="rl-btn" style="margin-top:6px;background:#333;border:1px solid #666;">➕ Add Sample Test Ride (Demo)</button>' +
        '</div>';

        var demoBtn = container.querySelector('#rlBtnDemo');
        if (demoBtn) {
          demoBtn.onclick = function (ev) {
            ev.preventDefault();
            var dummySamples = [];
            for (var k = 0; k < 50; k++) {
              var t = k * 40;
              var ax = Math.round(Math.sin(k / 5.0) * 1500);
              var ay = Math.round(Math.cos(k / 7.0) * 800);
              var az = 1000 + Math.round(Math.sin(k / 3.0) * 2500);
              var g = Math.round((Math.sqrt(ax * ax + ay * ay + az * az) / 1000.0) * 100) / 100;
              var head = Math.round(((k * 7.2) % 360.0) * 10) / 10.0;
              dummySamples.push([t, ax, ay, az, g, head]);
            }
            var demoRide = {
              id: 'ride_demo_' + Date.now(),
              rideId: 101,
              rideName: 'Hyperion (Test Demo)',
              park: 'Energylandia',
              recordedAt: new Date().toISOString(),
              durationSec: 85,
              sampleRateHz: 25,
              sampleIntervalMs: 40,
              summary: {
                maxG: 4.85,
                // A magnitude, so never negative — the demo has to be
                // representative of what the watch can actually report.
                minG: 0.12,
                avgG: 1.34,
                airtimeSec: 4.2,
                airtimeHills: 5,
                maxAirtimeSec: 1.4,
                highGSec: 6.8,
                turns: 7,
                rotationDeg: 1260,
                roughness: 480,
                totalSamples: dummySamples.length
              },
              gps: { lat: 49.9972, lon: 19.4081 },
              samples: dummySamples
            };
            logs.unshift(demoRide);
            try {
              window.localStorage.setItem('coasterwatch_ride_logs_local', JSON.stringify(logs));
            } catch (e) {}
            renderCards(logs);
          };
        }
        refreshPending();
        return;
      }

      rideList.forEach(function (ride) {
        var sm = ride.summary || {};
        var card = document.createElement('div');
        card.className = 'rl-card';
        card.setAttribute('data-ride-id', ride.id || '');
        card.setAttribute('data-doomed', '0');

        // --- title row: name, and whether it made it to the cloud ---
        var head = document.createElement('div');
        head.className = 'rl-head';
        var name = document.createElement('span');
        name.className = 'rl-name';
        name.textContent = ride.rideName || 'Coaster';
        head.appendChild(name);

        var chip = document.createElement('span');
        if (ride.githubSynced) {
          chip.className = 'rl-chip rl-chip-ok';
          chip.textContent = 'Synced';
        } else {
          chip.className = 'rl-chip';
          chip.textContent = 'On phone';
        }
        head.appendChild(chip);
        card.appendChild(head);

        // --- one meta line with date, duration, sample count, and park ---
        var d = new Date(ride.recordedAt);
        var when = isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
                   ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var countStr = (ride.samples ? ride.samples.length : (sm.totalSamples || 0)) +
                       ' samples @ ' + (ride.sampleRateHz || 25) + 'Hz';
        var meta = document.createElement('div');
        meta.className = 'rl-meta';
        meta.innerHTML = [when, (ride.durationSec || 0) + 's', '<span class="rl-count">' + countStr + '</span>', ride.park || '']
                             .filter(function (x) { return x; }).join(' · ');
        card.appendChild(meta);

        // --- the numbers, as a scannable grid rather than a run-on sentence ---
        function g(v) { return (typeof v === 'number' ? v.toFixed(2) : '--') + 'G'; }
        var cells = [
          ['Peak', g(sm.maxG)],
          ['Min', g(sm.minG)],
          ['Avg', g(sm.avgG)],
          ['Airtime', (sm.airtimeSec || 0) + 's', (sm.airtimeHills || 0) + ' hills'],
          ['Turns', String(sm.turns || 0), (sm.rotationDeg || 0) + '°'],
          ['Rough', String(sm.roughness || 0), (sm.highGSec || 0) + 's >2G']
        ];
        var grid = document.createElement('div');
        grid.className = 'rl-grid';
        cells.forEach(function (c) {
          var cell = document.createElement('div');
          cell.className = 'rl-cell';
          var val = document.createElement('div');
          val.className = 'rl-val';
          val.textContent = c[1];
          var lab = document.createElement('div');
          lab.className = 'rl-lab';
          lab.textContent = c[2] ? c[0] + ' · ' + c[2] : c[0];
          cell.appendChild(val);
          cell.appendChild(lab);
          grid.appendChild(cell);
        });
        card.appendChild(grid);

        // --- caveats, only when they apply ---
        var notes = [];
        if (ride.clippedSamples) {
          notes.push(ride.clippedSamples + ' sample' + (ride.clippedSamples === 1 ? '' : 's') +
                     ' hit the ±4g sensor limit — peak is a floor, not a measurement.');
        }
        if (ride.truncated) {
          notes.push('Sample buffer filled before the ride ended — the stats cover the whole ' +
                     'ride, the exported samples stop early.');
        }
        if (notes.length) {
          var warn = document.createElement('div');
          warn.className = 'rl-warn';
          warn.textContent = '⚠ ' + notes.join(' ');
          card.appendChild(warn);
        }

        // --- actions: Copy CSV, Copy JSON, and Delete on a single clean row ---
        var btnRow = document.createElement('div');
        btnRow.className = 'rl-btns';
        [['CSV', function () { return buildCsv(ride); }],
         ['JSON', function () { return JSON.stringify(ride, null, 2); }]
        ].forEach(function (spec) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'rl-btn';
          b.textContent = 'Copy ' + spec[0];
          b.onclick = function (ev) { ev.preventDefault(); copyToClipboard(spec[1](), b); };
          btnRow.appendChild(b);
        });

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'rl-btn rl-btn-del';
        del.textContent = 'Delete';
        del.onclick = function (ev) {
          ev.preventDefault();
          setDoomed(card, card.getAttribute('data-doomed') !== '1');
        };
        btnRow.appendChild(del);

        card.appendChild(btnRow);

        container.appendChild(card);
      });
      refreshPending();
    }

    renderCards(logs);
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
      '*{box-sizing:border-box;}' +
      'html,body{max-width:100%;overflow-x:hidden;}' +
      'body{background:#1c1c1c;color:#eee;}' +
      '.section{border-bottom:1px solid #333;padding-bottom:4px;}' +
      '.rl-park.hide{display:none;}' +
      '.rl-btns{display:flex !important;flex-direction:row !important;flex-wrap:nowrap !important;align-items:stretch !important;gap:6px !important;width:100% !important;box-sizing:border-box !important;}' +
      '.rl-btns .rl-btn{flex:1 !important;min-width:0 !important;width:auto !important;max-width:none !important;white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important;text-align:center !important;padding:7px 2px !important;}' +
      '.rl-btns .rl-btn-del{flex:1 !important;min-width:0 !important;margin-left:0 !important;text-align:center !important;}' +
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

    // Hook up interactive GitHub Test Connection button
    var tokenInput = document.querySelector('input[name="ghToken"]');
    var repoInput = document.querySelector('input[name="ghRepo"]');
    var ghSection = tokenInput ? tokenInput.closest('.section') : null;
    if (ghSection && !document.getElementById('ghTestBtn')) {
      var btnDiv = document.createElement('div');
      btnDiv.style.marginTop = '10px';
      btnDiv.style.marginBottom = '6px';
      btnDiv.innerHTML = '<button type="button" id="ghTestBtn" class="rl-btn" style="background:#24292e;border:1px solid #666;padding:8px 12px;font-size:12px;cursor:pointer;">🧪 Test GitHub Connection</button><span id="ghTestStatus" style="font-size:12px;margin-left:8px;vertical-align:middle;"></span>';
      ghSection.appendChild(btnDiv);

      var testBtn = document.getElementById('ghTestBtn');
      var testStatus = document.getElementById('ghTestStatus');
      testBtn.onclick = function (e) {
        e.preventDefault();
        var tok = (tokenInput.value || '').trim();
        var rep = (repoInput.value || '').trim();
        if (!tok || !rep) {
          testStatus.style.color = '#ffaa00';
          testStatus.textContent = 'Please enter both Token and Repository.';
          return;
        }
        testStatus.style.color = '#7ab8ff';
        testStatus.textContent = 'Testing connection...';

        var authHeader = (tok.indexOf('Bearer ') === 0 || tok.indexOf('token ') === 0) ? tok : 'Bearer ' + tok;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://api.github.com/repos/' + rep, true);
        xhr.setRequestHeader('Authorization', authHeader);
        xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
        xhr.timeout = 15000;
        xhr.onload = function () {
          if (xhr.status === 200) {
            testStatus.style.color = '#4caf50';
            testStatus.textContent = '✓ Connected! (Repository verified)';
          } else if (xhr.status === 401) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '✕ HTTP 401: Invalid Token (Bad credentials)';
          } else if (xhr.status === 404) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '✕ HTTP 404: Repo not found or Token lacks "repo"/"Contents" permission';
          } else if (xhr.status === 403) {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '✕ HTTP 403: Permission denied (Contents: Read & Write required)';
          } else {
            testStatus.style.color = '#e53935';
            testStatus.textContent = '✕ Error HTTP ' + xhr.status;
          }
        };
        xhr.onerror = function () {
          testStatus.style.color = '#e53935';
          testStatus.textContent = '✕ Network error connecting to api.github.com';
        };
        xhr.ontimeout = function () {
          testStatus.style.color = '#e53935';
          testStatus.textContent = '✕ Request timed out';
        };
        xhr.send();
      };
    }
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
        var infoUrl = (r.infoUrl && r.infoUrl.indexOf('energylandia.pl') === -1) ? r.infoUrl : '';
        rides.push({ id: r.id, name: r.name, infoUrl: infoUrl, checked: visible.has(r.id) });
      }
      lands.push({ name: roster[i].land, rides: rides });
    }
    parksData.push({ parkId: pid, lands: lands, defaultVisible: PARKS[pid].defaultVisible });
  }

  var rawLogs = localStorage.getItem('coasterwatch_ride_logs');
  var logs = [];
  if (rawLogs) {
    try {
      var parsed = JSON.parse(rawLogs);
      if (Array.isArray(parsed)) {
        logs = parsed.map(function (r) {
          var samples = r.samples || [];
          var compactSamples = samples;
          if (samples.length > 100) {
            compactSamples = [];
            var step = (samples.length - 1) / 99.0;
            for (var idx = 0; idx < 100; idx++) {
              compactSamples.push(samples[Math.floor(idx * step)]);
            }
          }
          return {
            id: r.id,
            rideId: r.rideId,
            rideName: r.rideName,
            park: r.park,
            recordedAt: r.recordedAt,
            durationSec: r.durationSec,
            sampleRateHz: r.sampleRateHz,
            truncated: r.truncated,
            clippedSamples: r.clippedSamples,
            githubSynced: r.githubSynced,
            summary: r.summary,
            gps: r.gps,
            samples: compactSamples
          };
        });
      }
    } catch (e) {}
  }

  return [
    { type: 'heading', defaultValue: 'CoasterWatch Settings', size: 3 },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Park', size: 4 },
      { type: 'select', id: 'park', messageKey: 'park', label: 'Park',
        defaultValue: String(parkId), options: parkOptions }
    ] },
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Rides', size: 4 },
      { type: 'ridelist', id: 'rides', messageKey: 'visibleRideIds', activeParkId: parkId, parks: parksData }
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
    // Recordings and their cloud sync are one section: sync exists only to
    // serve recordings, and separating them left the whole 69-row ride picker
    // between the two. Last on the page — it's data you read, not settings you
    // change, and the settings above are all set-once.
    { type: 'section', items: [
      { type: 'heading', defaultValue: 'Ride Recordings', size: 4 },
      { type: 'ridelogs', id: 'rideLogs', messageKey: 'deletedRideLogs', logs: logs },
      { type: 'githubsync', id: 'githubSync', messageKey: 'githubSync',
        enabled: isGitHubSyncEnabled(),
        token: localStorage.getItem(GITHUB_TOKEN_KEY) || DEFAULT_GITHUB_TOKEN,
        repo: localStorage.getItem(GITHUB_REPO_KEY) || DEFAULT_GITHUB_REPO }
    ] },
    { type: 'submit', defaultValue: 'Save' }
  ];
}

Pebble.addEventListener('showConfiguration', function () {
  var clay = new Clay(buildClayConfig(), claySettingsCustomFn, { autoHandleEvents: false });
  clay.registerComponent(RIDE_LIST_COMPONENT);
  clay.registerComponent(GITHUB_SYNC_COMPONENT);
  clay.registerComponent(RIDE_LOGS_COMPONENT);
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e.response) return;
  try {
    var raw = new Clay([], null, { autoHandleEvents: false }).getSettings(e.response, false);
    var refresh = false;

    var doomed = (raw.deletedRideLogs && raw.deletedRideLogs.value) || raw.deletedRideLogs;
    if (doomed && doomed.length) {
      var gone = deleteRideLogs(doomed);
      console.log('CoasterWatch: Deleted ' + gone + ' ride log(s) from the phone; ' +
                  'GitHub copies untouched.');
    }

    var ghSync = (raw.githubSync && raw.githubSync.value) || raw.githubSync;
    if (ghSync) {
      var tok = ghSync.token || (typeof ghSync === 'string' ? ghSync : '');
      var rep = ghSync.repo || '';
      if (tok && tok.length > 0) {
        localStorage.setItem(GITHUB_TOKEN_KEY, String(tok).trim());
        console.log('CoasterWatch: Persisted GitHub token to PKJS storage');
      }
      if (rep && rep.length > 0) {
        localStorage.setItem(GITHUB_REPO_KEY, String(rep).trim());
      }
      // Explicit compare: `false` is a real value here, so the "only save
      // truthy things" pattern used for the credentials above would make the
      // toggle impossible to turn off.
      if (ghSync.enabled !== undefined) {
        localStorage.setItem(GITHUB_ENABLED_KEY, ghSync.enabled ? '1' : '0');
      }
    }

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

    if (refresh) fetchQueueTimes(true);
  } catch (ex) {
    console.log('CoasterWatch: bad config response: ' + ex);
  }
});
