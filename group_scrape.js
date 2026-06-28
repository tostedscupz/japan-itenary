/*
 * Group-room search: rooms that fit 3 people, sized 3-5, for <= a per-night
 * group budget. Booking.com only (its detail pages expose room capacity + price
 * reliably; Hostelworld's room-level data isn't cleanly machine-readable, and
 * Booking dorm rooms frequently omit bed-count, so we use room *names* to honour
 * the 3-5 cap: private Triple/Quadruple/Quintuple/Family rooms, plus any dorm
 * whose name states a 3-5 bed size).
 *
 * Group cost/night:
 *   - private room (cap 3-5): the room's price for 3 guests (whole room).
 *   - dorm sized 3-5:         3 x per-bed price.
 *
 * Usage: node group_scrape.js [tokyo|kyoto|osaka ...]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
const PROXY = process.env.HTTPS_PROXY || null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const OSM_UA = 'japan-hostel-research/1.0 (personal one-off trip planning)';
const PEOPLE = 3;
const BUDGET_INR_NIGHT = 8000;            // group, per night
let FX_INR_TO_JPY = 1.7129;
const MAX_DETAIL = 34;                     // cap detail-page loads per city
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jit = (a, b) => a + Math.random() * (b - a);
const num = s => { if (!s) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };

const CITIES = {
  tokyo: { name: 'Tokyo', ss: 'Tokyo', checkin: '2026-10-01', checkout: '2026-10-09', nights: 8,
    ref: { name: 'VIA INN Iidabashi Korakuen', lat: 35.70577, lon: 139.74337 }, viewbox: '139.60,35.55,139.92,35.82' },
  kyoto: { name: 'Kyoto', ss: 'Kyoto', checkin: '2026-09-26', checkout: '2026-09-29', nights: 3,
    ref: { name: 'APA Hotel Kyoto Eki Horikawadori', lat: 34.98666, lon: 135.75358 }, viewbox: '135.68,34.93,135.83,35.07' },
  osaka: { name: 'Osaka', ss: 'Osaka', checkin: '2026-09-24', checkout: '2026-09-27', nights: 3,
    ref: { name: 'APA Hotel Osaka Higobashi Ekimae', lat: 34.69205, lon: 135.49533 }, viewbox: '135.40,34.60,135.58,34.76' },
};

function hav(a1, o1, a2, o2) { const R = 6371, t = d => d * Math.PI / 180; const dLat = t(a2 - a1), dLon = t(o2 - o1); const x = Math.sin(dLat / 2) ** 2 + Math.cos(t(a1)) * Math.cos(t(a2)) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const walkMin = km => Math.round(km * 1000 / 80);

// ---- OSM cache (shared with scrape.js) ----
const CACHE_FILE = path.join(OUT, 'osm_cache.json');
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
async function osm(url, opts = {}) { const r = await fetch(url, { headers: { 'User-Agent': OSM_UA }, ...opts }); if (!r.ok) throw new Error('OSM ' + r.status); return r.json(); }
async function nearestStation(lat, lon) {
  const key = `stn:${lat.toFixed(4)},${lon.toFixed(4)}`; if (cache[key]) return cache[key];
  const q = `[out:json][timeout:25];(node(around:1200,${lat},${lon})[railway=station];node(around:1200,${lat},${lon})[station=subway];);out;`;
  let best = null;
  try { const d = await osm('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
    for (const e of (d.elements || [])) { const dist = hav(lat, lon, e.lat, e.lon); const nm = (e.tags && (e.tags['name:en'] || e.tags.name)) || null; if (nm && (!best || dist < best.km)) best = { name: nm, km: dist, walk: walkMin(dist) }; } } catch {}
  if (best) { cache[key] = best; saveCache(); } await sleep(jit(1100, 1500)); return best;
}

// Classify the booking search "recommended units" label into a room descriptor
// for the 3 of you. Returns { kind, desc, size, cap, verifiedMax5 }.
function classifyLabel(units) {
  const u = (units || '').replace(/Recommended for your group/i, '').trim();
  // Real dorm size is hyphenated ("8-Bed Mixed Dormitory"); "3 beds in dorms"
  // just means 3 beds are being booked, not the room size.
  const dormSize = num((u.match(/(\d+)-Bed\b/i) || [])[1]);
  // Several private rooms booked together (e.g. "3× Standard Single Room")
  const multiPrivate = /(\d+)×\s*[^,]*\b(Single|Double|Twin|Standard|Economy|Deluxe|Superior)\b[^,]*Room/i.test(u) && !/dorm/i.test(u);
  if (/dorm/i.test(u)) {
    return { kind: 'dorm-beds', size: dormSize,
      desc: dormSize ? `${PEOPLE} beds in a ${dormSize}-bed dorm` : `${PEOPLE} beds in a shared dorm (size not stated)`,
      verifiedMax5: dormSize != null && dormSize <= 5 };
  }
  if (/quintuple|quint/i.test(u)) return { kind: 'private', cap: 5, desc: 'Private Quintuple room (5)', verifiedMax5: true };
  if (/quadruple|quad/i.test(u)) return { kind: 'private', cap: 4, desc: 'Private Quadruple room (4)', verifiedMax5: true };
  if (/triple/i.test(u)) return { kind: 'private', cap: 3, desc: 'Private Triple room (3)', verifiedMax5: true };
  if (/family/i.test(u)) return { kind: 'private', cap: null, desc: 'Private Family room', verifiedMax5: true };
  if (multiPrivate) return { kind: 'multi-private', cap: null, desc: `${PEOPLE}× private single/twin rooms`, verifiedMax5: true };
  return { kind: 'room', cap: null, desc: u.slice(0, 48) || 'Room for 3', verifiedMax5: false };
}

async function launch() {
  const opts = { headless: true, args: ['--no-sandbox', '--ssl-version-max=tls1.2', '--disable-blink-features=AutomationControlled'] };
  if (fs.existsSync('/opt/pw-browsers/chromium')) opts.executablePath = '/opt/pw-browsers/chromium';
  if (PROXY) opts.proxy = { server: PROXY };
  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 950 }, ignoreHTTPSErrors: !!PROXY });
  return { browser, ctx };
}
async function scroll(page, n = 4) { for (let i = 0; i < n; i++) { await page.mouse.wheel(0, 2200); await sleep(jit(1000, 1500)); } }

(async () => {
  const targets = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CITIES)).filter(k => CITIES[k]);
  try { const fx = await (await fetch('https://open.er-api.com/v6/latest/INR', { headers: { 'User-Agent': OSM_UA } })).json(); if (fx?.rates?.JPY) FX_INR_TO_JPY = +fx.rates.JPY.toFixed(4); } catch {}
  const budgetJPY = Math.round(BUDGET_INR_NIGHT * FX_INR_TO_JPY);
  console.log('FX 1 INR =', FX_INR_TO_JPY, 'JPY | group budget/night ¥', budgetJPY);

  // reviews from the earlier per-person run, for annotation
  let reviewBy = {};
  try { const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'raw.json'), 'utf8'));
    for (const c of Object.values(prev.cities)) for (const h of c.all || []) { const k = h.name.toLowerCase().replace(/[^a-z0-9]/g, ''); if (h.score != null) reviewBy[k] = { score: h.score, reviews: h.reviews }; } } catch {}

  const { browser, ctx } = await launch();
  const page = await ctx.newPage();
  const report = { generatedAt: new Date().toISOString(), fx: FX_INR_TO_JPY, people: PEOPLE, budgetNightJPY: budgetJPY, budgetNightINR: BUDGET_INR_NIGHT, cities: {} };

  for (const key of targets) {
    const city = CITIES[key];
    console.log(`\n==== ${city.name} ====`);
    const coordMap = {}; const byName = {};
    for (const offset of [0, 25, 50, 75]) {                              // paginate booking
      const searchUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city.ss)}&checkin=${city.checkin}&checkout=${city.checkout}&group_adults=${PEOPLE}&no_rooms=1&group_children=0&nflt=ht_id%3D203&selected_currency=JPY&order=price&offset=${offset}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(jit(3500, 5500)); await scroll(page, 5);
      const html = await page.content();
      for (const m of html.matchAll(/"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)\},"pageName":"([^"]+)"/g)) coordMap[m[3]] = { lat: +m[1], lon: +m[2] };
      const cards = await page.$$eval('[data-testid="property-card"]', cs => cs.map(c => {
        const g = s => { const e = c.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; };
        const a = c.querySelector('a[data-testid="title-link"]') || c.querySelector('a[href*="/hotel/"]');
        return { name: g('[data-testid="title"]'), fromPrice: g('[data-testid="price-and-discounted-price"]'), units: g('[data-testid="recommended-units"]'), href: a ? a.href.split('?')[0] : null };
      }));
      let added = 0;
      for (const c of cards) {
        if (!c.name || !c.href) continue;
        const slug = (c.href.match(/\/hotel\/[a-z]{2}\/([^.]+)\.html/) || [])[1];
        if (!slug || byName[slug]) continue;
        byName[slug] = { ...c, slug, fromJPY: num(c.fromPrice) }; added++;
      }
      await sleep(jit(2000, 3500));
      if (added === 0) break;                                           // no new results -> end of list
    }
    const cards = Object.values(byName);
    console.log(`  ${cards.length} unique hostels (group of ${PEOPLE}, 1 room)`);

    const results = [];
    for (const c of cards) {
      const groupCost = c.fromJPY;                                      // card price = cheapest 1-room option for 3, per night
      if (groupCost == null || groupCost > budgetJPY) continue;
      const cls = classifyLabel(c.units);
      const co = coordMap[c.slug];
      const rec = { name: c.name, href: c.href, groupCost, perPersonNight: Math.round(groupCost / PEOPLE), stayCost: groupCost * city.nights,
        roomDesc: cls.desc, roomKind: cls.kind, verifiedMax5: cls.verifiedMax5, dormSize: cls.size ?? null,
        lat: co?.lat ?? null, lon: co?.lon ?? null };
      const rv = reviewBy[c.name.toLowerCase().replace(/[^a-z0-9]/g, '')]; if (rv) { rec.score = rv.score; rec.reviews = rv.reviews; }
      if (rec.lat != null) { const d = hav(city.ref.lat, city.ref.lon, rec.lat, rec.lon); if (d <= 30) { rec.refKm = d; rec.refWalk = walkMin(d); const st = await nearestStation(rec.lat, rec.lon); if (st) rec.station = st; } }
      results.push(rec);
    }
    console.log(`   ${results.length} within ¥${budgetJPY}/night for the group`);
    // rank: distance -> group cost -> reviews
    results.forEach(r => { r._rank = (r.verifiedMax5 ? 30 : 0) + (r.refKm != null ? (r.refKm < 1 ? 50 : r.refKm < 2 ? 40 : r.refKm < 3.5 ? 28 : r.refKm < 6 ? 15 : 5) : 0) + (r.station ? (r.station.km < 0.4 ? 20 : r.station.km < 0.8 ? 14 : 8) : 0) + (r.score ? (r.score - 7) * 4 : 0) + (r.reviews ? Math.min(8, Math.log10(Math.max(1, r.reviews)) * 3) : 0) + Math.max(0, (budgetJPY - r.groupCost) / budgetJPY * 6); });
    results.sort((a, b) => b._rank - a._rank);
    const refStation = await nearestStation(city.ref.lat, city.ref.lon);
    report.cities[key] = { results, refStation };
    fs.writeFileSync(path.join(OUT, 'group.json'), JSON.stringify(report, null, 1));
    console.log(`  -> ${results.length} qualifying hostels within ¥${budgetJPY}/night`);
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'group.json'), JSON.stringify(report, null, 1));
  console.log('\nSaved output/group.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
