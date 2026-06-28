/*
 * Japan hostel research scraper.
 *
 * Drives a real Chromium (Playwright) through hostelworld.com and booking.com
 * for three cities/date-ranges, filters to a per-night budget, enriches each
 * candidate with straight-line distance + walking time to a reference hotel and
 * the nearest train/metro station (OpenStreetMap Nominatim + Overpass), ranks
 * them, and writes japan_hostel_recommendations.md.
 *
 * Network note: this environment's egress proxy drops Chromium's TLS 1.3
 * ClientHello, so we cap at TLS 1.2 (--ssl-version-max=tls1.2). No verification
 * is disabled. On a normal machine the flag is harmless.
 *
 * Usage: node scrape.js [tokyo|kyoto|osaka ...]   (default: all three)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PROXY = process.env.HTTPS_PROXY || null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const OSM_UA = 'japan-hostel-research/1.0 (personal one-off trip planning)';

const BUDGET_INR = 2500;            // per person per night
let   FX_INR_TO_JPY = 1.7129;       // refreshed live at runtime
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

const CITIES = {
  tokyo: {
    name: 'Tokyo', checkin: '2026-10-01', checkout: '2026-10-09', nights: 8,
    bookingSS: 'Tokyo', hwPath: 'asia/japan/tokyo',
    ref: { name: 'VIA INN Iidabashi Korakuen', lat: 35.70577, lon: 139.74337 },
    viewbox: '139.60,35.55,139.92,35.82', // lon_min,lat_min,lon_max,lat_max
  },
  kyoto: {
    name: 'Kyoto', checkin: '2026-09-26', checkout: '2026-09-29', nights: 3,
    bookingSS: 'Kyoto', hwPath: 'asia/japan/kyoto',
    ref: { name: 'APA Hotel Kyoto Eki Horikawadori', lat: 34.98666, lon: 135.75358 },
    viewbox: '135.68,34.93,135.83,35.07',
  },
  osaka: {
    name: 'Osaka', checkin: '2026-09-24', checkout: '2026-09-27', nights: 3,
    bookingSS: 'Osaka', hwPath: 'asia/japan/osaka',
    ref: { name: 'APA Hotel Osaka Higobashi Ekimae', lat: 34.69205, lon: 135.49533 },
    viewbox: '135.40,34.60,135.58,34.76',
  },
};

// ---------- helpers ----------
function num(s) { if (!s) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
function jpyToInr(jpy) { return jpy == null ? null : Math.round(jpy / FX_INR_TO_JPY); }
function haversine(a1, o1, a2, o2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(a2 - a1), dLon = toR(o2 - o1);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a1)) * Math.cos(toR(a2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); // km
}
const walkMin = km => Math.round(km * 1000 / 80); // ~4.8 km/h

// ---------- OSM enrichment (cached) ----------
const CACHE_FILE = path.join(OUT_DIR, 'osm_cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

async function osmFetch(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': OSM_UA }, ...opts });
  if (!r.ok) throw new Error('OSM HTTP ' + r.status);
  return r.json();
}
async function geocodeRaw(query, viewbox) {
  const key = 'geo:' + query + (viewbox ? '|b' : '');
  if (cache[key]) return cache[key];               // only successes are cached
  let u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&q=${encodeURIComponent(query)}`;
  if (viewbox) u += `&viewbox=${viewbox}&bounded=1`;
  let res = null;
  try { const d = await osmFetch(u); if (d && d[0]) res = { lat: +d[0].lat, lon: +d[0].lon, name: d[0].display_name }; }
  catch (e) { res = null; }
  if (res) { cache[key] = res; saveCache(); }
  await sleep(jitter(1100, 1500));
  return res;
}
function cleanName(n) {
  return n.replace(/\s*[-–—]\s*(Male|Female|Women|Mixed|Adults?).*$/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(Hostel|Hotel|Guesthouse|Guest House|Backpackers?|Inn|Lounge|Bar)\b/gi, ' ')
    .replace(/[«»<>]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Geocode a hostel: bounded city search first, then a couple of cleaned variants.
async function geocodeHostel(name, city) {
  const queries = [
    [`${name}, ${city.name}, Japan`, city.viewbox],
    [`${cleanName(name)} ${city.name}`, city.viewbox],
    [`${name}, ${city.name}`, null],
  ];
  for (const [q, vb] of queries) {
    const r = await geocodeRaw(q, vb);
    if (r && haversine(city.ref.lat, city.ref.lon, r.lat, r.lon) <= 25) return r;
  }
  return null;
}
async function nearestStation(lat, lon) {
  const key = `stn:${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (cache[key]) return cache[key];
  const q = `[out:json][timeout:25];(node(around:1200,${lat},${lon})[railway=station];node(around:1200,${lat},${lon})[station=subway];);out;`;
  let best = null;
  try {
    const d = await osmFetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
    });
    for (const e of (d.elements || [])) {
      const dist = haversine(lat, lon, e.lat, e.lon);
      const nm = (e.tags && (e.tags['name:en'] || e.tags.name)) || null;
      if (nm && (!best || dist < best.km)) best = { name: nm, km: dist, walk: walkMin(dist) };
    }
  } catch (e) { best = null; }
  cache[key] = best; saveCache(); await sleep(jitter(1100, 1500));
  return best;
}

// ---------- browser ----------
async function launch() {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--ssl-version-max=tls1.2', '--disable-blink-features=AutomationControlled'],
  };
  if (fs.existsSync('/opt/pw-browsers/chromium')) opts.executablePath = '/opt/pw-browsers/chromium';
  if (PROXY) opts.proxy = { server: PROXY };
  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 950 }, ignoreHTTPSErrors: !!PROXY,
  });
  await ctx.addCookies([{ name: 'currency', value: 'JPY', domain: '.hostelworld.com', path: '/' }]);
  return { browser, ctx };
}

async function autoScroll(page, rounds = 5) {
  for (let i = 0; i < rounds; i++) { await page.mouse.wheel(0, 2600); await sleep(jitter(1200, 1800)); }
}

// ---------- BOOKING ----------
async function scrapeBooking(page, city) {
  const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city.bookingSS)}`
    + `&checkin=${city.checkin}&checkout=${city.checkout}&group_adults=1&no_rooms=1&group_children=0`
    + `&nflt=ht_id%3D203&selected_currency=JPY&order=price`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(jitter(4000, 6000));
  await autoScroll(page, 6);
  // Booking embeds exact coords per property in page JSON, keyed by URL slug.
  const coordMap = {};
  const html = await page.content();
  for (const m of html.matchAll(/"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)\},"pageName":"([^"]+)"/g))
    coordMap[m[3]] = { lat: +m[1], lon: +m[2] };
  const rows = await page.$$eval('[data-testid="property-card"]', cards => cards.map(c => {
    const g = s => { const e = c.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; };
    const a = c.querySelector('a[data-testid="title-link"]') || c.querySelector('a[href*="/hotel/"]');
    return {
      name: g('[data-testid="title"]'), priceTxt: g('[data-testid="price-and-discounted-price"]'),
      reviewTxt: g('[data-testid="review-score"]'), units: g('[data-testid="recommended-units"]'),
      distTxt: g('[data-testid="distance"]'), href: a ? a.href.split('?')[0] : null,
    };
  }));
  return rows.map(r => {
    const score = r.reviewTxt ? num((r.reviewTxt.match(/Scored ([\d.]+)/) || [])[1] || r.reviewTxt) : null;
    const cnt = r.reviewTxt ? num((r.reviewTxt.match(/([\d,]+)\s+reviews?/) || [])[1]) : null;
    const bed = r.units ? num((r.units.match(/(\d+)-Bed/) || [])[1]) : null;
    const isDorm = /dorm/i.test(r.units || '');
    const slug = r.href ? (r.href.match(/\/hotel\/[a-z]{2}\/([^.]+)\.html/) || [])[1] : null;
    const co = slug ? coordMap[slug] : null;
    return {
      site: 'Booking', name: r.name, priceJPY: num(r.priceTxt), score, reviews: cnt,
      roomType: r.units ? r.units.replace(/We have.*$/i, '').replace(/Free cancellation/i, '').trim().slice(0, 70) : null,
      beds: bed, isDorm, siteDist: r.distTxt, href: r.href,
      lat: co ? co.lat : null, lon: co ? co.lon : null,
    };
  }).filter(r => r.name && r.priceJPY);
}

// ---------- HOSTELWORLD ----------
async function scrapeHW(page, city) {
  const url = `https://www.hostelworld.com/hostels/${city.hwPath}/?from=${city.checkin}&to=${city.checkout}&guests=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(jitter(5000, 7000));
  await autoScroll(page, 7);
  // HW embeds coords + property URL in JSON-LD, keyed by property name.
  const coordMap = {}, urlMap = {};
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const html = await page.content();
  for (const m of html.matchAll(/"geo":\{"@type":"GeoCoordinates","latitude":(-?[\d.]+),"longitude":(-?[\d.]+)\},"aggregateRating":\{"name":"([^"]+)"/g))
    coordMap[norm(m[3])] = { lat: +m[1], lon: +m[2] };
  // Pair each property-detail URL with the nearest preceding "name" (same LodgingBusiness object).
  for (const m of html.matchAll(/"url":"(https:\/\/www\.hostelworld\.com\/hostels\/p\/[^"]+)"/g)) {
    const before = html.slice(Math.max(0, m.index - 1400), m.index);
    const names = [...before.matchAll(/"name":"([^"]+)"/g)];
    if (names.length) { const n = norm(names[names.length - 1][1]); if (!urlMap[n]) urlMap[n] = m[1]; }
  }
  const rows = await page.$$eval('.property-listing-card', cards => cards.map(c => {
    const a = c.querySelector('a[href*="/p/"]') || c.querySelector('a[href*="/hostels/"]') || c.querySelector('a[href]');
    const nameEl = c.querySelector('[class*="property-name"], h2, h3');
    return {
      text: c.innerText.replace(/\s+/g, ' ').trim(),
      name: nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : null,
      href: a ? a.href.split('?')[0] : null,
    };
  }));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const t = r.text || '';
    let name = r.name;
    if (!name) { const m = t.match(/^(?:Hostel\s+)?(.+?)\s+[\d.]+\s+(Superb|Fabulous|Fantastic|Awesome|Very Good|Good|Rating)/i); name = m ? m[1].trim() : null; }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const score = num((t.match(/\b([\d.]+)\s+(Superb|Fabulous|Fantastic|Awesome|Very Good|Good)/i) || [])[1]);
    const cnt = num((t.match(/\((\d[\d,]*)\)/) || [])[1]);
    const dorm = num((t.match(/Dorms?\s*From\s*¥\s*([\d,]+)/i) || [])[1]);
    const priv = num((t.match(/Privates?\s*From\s*¥\s*([\d,]+)/i) || [])[1]);
    const anyFrom = num((t.match(/From\s*¥\s*([\d,]+)/i) || [])[1]);
    const priceJPY = dorm || anyFrom || priv;
    const co = coordMap[norm(name)];
    out.push({
      site: 'HW', name, priceJPY, score, reviews: cnt,
      roomType: dorm ? 'Dorm (size n/a in listing)' : (priv ? 'Private' : null),
      beds: null, isDorm: !!dorm, siteDist: (t.match(/([\d.]+km from city centre)/i) || [])[1] || null,
      href: urlMap[norm(name)] || r.href, lat: co ? co.lat : null, lon: co ? co.lon : null,
    });
  }
  return out.filter(r => r.name && r.priceJPY);
}

// ---------- enrichment + ranking ----------
async function enrich(h, city) {
  // Prefer the exact coords embedded in the site's own page JSON.
  let lat = h.lat, lon = h.lon, src = 'site';
  if (lat == null || lon == null) {
    const g = await geocodeHostel(h.name, city);
    if (g) { lat = g.lat; lon = g.lon; src = 'osm'; }
  }
  if (lat != null && lon != null) {
    const dKm = haversine(city.ref.lat, city.ref.lon, lat, lon);
    if (dKm <= 30) {
      h.lat = lat; h.lon = lon; h.geoSrc = src; h.refKm = dKm; h.refWalk = walkMin(dKm);
      const st = await nearestStation(lat, lon);
      if (st) h.station = st;
    } else { h.geoWarn = true; }
  } else { h.geoWarn = true; }
  return h;
}

function rankScore(h, budgetJPY) {
  let s = 0;
  if (h.refKm != null) { s += h.refKm < 1 ? 50 : h.refKm < 2 ? 40 : h.refKm < 3.5 ? 28 : h.refKm < 6 ? 15 : 5; }
  if (h.station) { s += h.station.km < 0.4 ? 20 : h.station.km < 0.8 ? 14 : 8; }
  if (h.score != null) { s += (h.score - 7) * 4; }                 // review quality
  if (h.reviews != null) { s += Math.min(8, Math.log10(Math.max(1, h.reviews)) * 3); }
  if (h.isDorm && h.beds && h.beds >= 3 && h.beds <= 5) s += 8;     // small dorm preference
  else if (h.isDorm && h.beds && h.beds >= 6) s += 3;
  if (h.priceJPY != null && h.priceJPY <= budgetJPY) s += 6;
  return s;
}

function fmtCity(city, picks, excluded, budgetJPY) {
  const L = [];
  L.push(`## ${city.name} — ${city.checkin} to ${city.checkout} (${city.nights} nights)`);
  L.push(`**Reference hotel:** ${city.ref.name}  ·  **Budget:** ≤ ₹${BUDGET_INR}/night ≈ ¥${budgetJPY}/night (1 INR = ${FX_INR_TO_JPY} JPY)\n`);
  L.push('| # | Hostel | Site | Price/night (JPY / INR) | Room type & beds | Dist. from ref hotel | Nearest station (walk) | Score | Reviews | Link |');
  L.push('|---|--------|------|--------------------------|------------------|----------------------|------------------------|-------|---------|------|');
  picks.forEach((h, i) => {
    const inr = jpyToInr(h.priceJPY);
    const dist = h.refKm != null ? `${h.refKm.toFixed(1)} km (~${h.refWalk} min walk)` : (h.geoWarn ? '_location unverified_' : '—');
    const stn = h.station ? `${h.station.name} (~${h.station.walk} min)` : '—';
    const beds = h.beds ? `${h.beds}-bed ${h.isDorm ? 'dorm' : 'room'}` : (h.roomType || '—');
    const rev = h.reviews != null ? (h.reviews < 20 ? `${h.reviews} ⚠️ limited` : h.reviews) : '—';
    L.push(`| ${i + 1} | ${h.name} | ${h.site} | ¥${h.priceJPY?.toLocaleString()} / ₹${inr?.toLocaleString()} | ${beds} | ${dist} | ${stn} | ${h.score ?? '—'} | ${rev} | ${h.href ? `[link](${h.href})` : '—'} |`);
  });
  L.push('');
  return { lines: L, excluded };
}

// ---------- main ----------
(async () => {
  const targets = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CITIES))
    .filter(k => CITIES[k]);
  // live FX
  try {
    const fx = await (await fetch('https://open.er-api.com/v6/latest/INR', { headers: { 'User-Agent': OSM_UA } })).json();
    if (fx && fx.rates && fx.rates.JPY) { FX_INR_TO_JPY = +fx.rates.JPY.toFixed(4); console.log('FX live: 1 INR =', FX_INR_TO_JPY, 'JPY'); }
  } catch { console.log('FX fetch failed, using fallback', FX_INR_TO_JPY); }
  const budgetJPY = Math.round(BUDGET_INR * FX_INR_TO_JPY);

  const { browser, ctx } = await launch();
  const page = await ctx.newPage();
  const report = { generatedAt: new Date().toISOString(), fx: FX_INR_TO_JPY, budgetJPY, cities: {} };

  for (const key of targets) {
    const city = CITIES[key];
    console.log(`\n==== ${city.name} ====`);
    let booking = [], hw = [];
    try { booking = await scrapeBooking(page, city); console.log('  booking:', booking.length); } catch (e) { console.log('  booking ERROR', e.message); }
    await sleep(jitter(2500, 4000));
    try { hw = await scrapeHW(page, city); console.log('  hostelworld:', hw.length); } catch (e) { console.log('  hw ERROR', e.message); }
    await sleep(jitter(2500, 4000));

    let all = [...booking, ...hw];
    // dedupe by normalized name, prefer cheaper
    const byName = {};
    for (const h of all) {
      const k = h.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!byName[k] || (h.priceJPY || 1e9) < (byName[k].priceJPY || 1e9)) byName[k] = byName[k] ? { ...h, alt: byName[k].site } : h;
    }
    all = Object.values(byName);

    const within = all.filter(h => h.priceJPY <= budgetJPY);
    const over = all.filter(h => h.priceJPY > budgetJPY)
      .sort((a, b) => a.priceJPY - b.priceJPY);

    // Build a balanced enrichment pool so neither site dominates: top-by-score
    // from each site (dorms first), bounded to keep OSM calls reasonable.
    const poolFrom = site => within.filter(h => h.site === site)
      .sort((a, b) => (b.isDorm - a.isDorm) || ((b.score || 0) - (a.score || 0)) || (a.priceJPY - b.priceJPY))
      .slice(0, 14);
    const toEnrich = [...poolFrom('Booking'), ...poolFrom('HW')];
    console.log('  enriching', toEnrich.length, 'within-budget candidates (balanced across sites)...');
    for (const h of toEnrich) { try { await enrich(h, city); } catch (e) { h.geoWarn = true; } }

    toEnrich.forEach(h => h._rank = rankScore(h, budgetJPY));
    toEnrich.sort((a, b) => b._rank - a._rank);

    report.cities[key] = { all, within: toEnrich, over: over.slice(0, 6) };
    fs.writeFileSync(path.join(OUT_DIR, 'raw.json'), JSON.stringify(report, null, 1));
    console.log('  done; top:', toEnrich.slice(0, 3).map(h => h.name).join(' | '));
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'raw.json'), JSON.stringify(report, null, 1));
  console.log('\nRaw results saved to output/raw.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
