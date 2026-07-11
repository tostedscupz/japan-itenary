/*
 * Broad Tokyo accommodation search (as of run date), 1 guest, dates 1-9 Oct 2026,
 * ranked by proximity to the reference (friends') hotel VIA INN Iidabashi Korakuen.
 *
 * Sources (each site's own live search, prices in JPY -> INR at a live rate):
 *   - booking.com  : ALL property types (hotels, hostels, guesthouses, capsule, ...)
 *   - hostelworld  : hostels / guesthouses
 *   - trip.com     : hotels + hostels, sorted price-ascending
 * Expedia blocks automation; Agoda/Rakuten need an interactive flow; Kayak/Google
 * Hotels are metasearch (aggregate the same OTAs); Airbnb is a different category.
 *
 * Affordability window: INR 2500-3500 / person / night (cap = 3500). Decent rating
 * floor 8.0/10; <20 reviews flagged. Output -> output/tokyo_broad.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'output'); fs.mkdirSync(OUT, { recursive: true });
const PROXY = process.env.HTTPS_PROXY || null;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const OSM_UA = 'japan-hostel-research/1.0 (personal one-off trip planning)';
const CHECKIN = '2026-10-01', CHECKOUT = '2026-10-09', NIGHTS = 8;
const CAP_INR = 3500, BAND_LOW_INR = 2500, RATING_FLOOR = 8.0;
const REF = { name: 'VIA INN Iidabashi Korakuen', lat: 35.70577, lon: 139.74337 };
const VIEWBOX = '139.60,35.55,139.92,35.82';
let FX = 1.7129;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jit = (a, b) => a + Math.random() * (b - a);
const num = s => { if (!s) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function hav(a1, o1, a2, o2) { const R = 6371, t = d => d * Math.PI / 180; const dLat = t(a2 - a1), dLon = t(o2 - o1); const x = Math.sin(dLat / 2) ** 2 + Math.cos(t(a1)) * Math.cos(t(a2)) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
const walkMin = km => Math.round(km * 1000 / 80);

// ---- OSM cache ----
const CACHE = path.join(OUT, 'osm_cache.json'); let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
async function osm(url, o = {}) { const r = await fetch(url, { headers: { 'User-Agent': OSM_UA }, ...o }); if (!r.ok) throw new Error('OSM ' + r.status); return r.json(); }
async function geocode(name) {
  const key = 'geo:' + name + ', Tokyo, Japan|b'; if (cache[key]) return cache[key];
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&viewbox=${VIEWBOX}&bounded=1&q=${encodeURIComponent(name + ', Tokyo, Japan')}`;
  let res = null; try { const d = await osm(u); if (d && d[0]) res = { lat: +d[0].lat, lon: +d[0].lon }; } catch {}
  if (res) { cache[key] = res; saveCache(); } await sleep(jit(1100, 1500)); return res;
}
async function nearestStation(lat, lon) {
  const key = `stn:${lat.toFixed(4)},${lon.toFixed(4)}`; if (cache[key]) return cache[key];
  const q = `[out:json][timeout:25];(node(around:1200,${lat},${lon})[railway=station];node(around:1200,${lat},${lon})[station=subway];);out;`;
  let best = null; try { const d = await osm('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': OSM_UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
    for (const e of (d.elements || [])) { const dist = hav(lat, lon, e.lat, e.lon); const nm = (e.tags && (e.tags['name:en'] || e.tags.name)) || null; if (nm && (!best || dist < best.km)) best = { name: nm, km: dist, walk: walkMin(dist) }; } } catch {}
  if (best) { cache[key] = best; saveCache(); } await sleep(jit(1100, 1500)); return best;
}

async function launch() {
  const o = { headless: true, args: ['--no-sandbox', '--ssl-version-max=tls1.2', '--disable-blink-features=AutomationControlled'] };
  if (fs.existsSync('/opt/pw-browsers/chromium')) o.executablePath = '/opt/pw-browsers/chromium';
  if (PROXY) o.proxy = { server: PROXY };
  const browser = await chromium.launch(o);
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Tokyo', viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: !!PROXY });
  await ctx.addCookies([{ name: 'currency', value: 'JPY', domain: '.hostelworld.com', path: '/' }]);
  return { browser, ctx };
}
const scroll = async (page, n = 5) => { for (let i = 0; i < n; i++) { await page.mouse.wheel(0, 2300); await sleep(jit(1100, 1700)); } };

// ---------- BOOKING (all property types) ----------
async function booking(page) {
  const out = [], coordMap = {};
  for (const offset of [0, 25, 50]) {
    const url = `https://www.booking.com/searchresults.html?ss=Tokyo&checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=1&no_rooms=1&group_children=0&selected_currency=JPY&order=price&offset=${offset}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(jit(4000, 6000)); await scroll(page, 5);
    const html = await page.content();
    for (const m of html.matchAll(/"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)\},"pageName":"([^"]+)"/g)) coordMap[m[3]] = { lat: +m[1], lon: +m[2] };
    const cards = await page.$$eval('[data-testid="property-card"]', cs => cs.map(c => { const g = s => { const e = c.querySelector(s); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; }; const a = c.querySelector('a[data-testid="title-link"]') || c.querySelector('a[href*="/hotel/"]'); return { name: g('[data-testid="title"]'), price: g('[data-testid="price-and-discounted-price"]'), review: g('[data-testid="review-score"]'), units: g('[data-testid="recommended-units"]'), href: a ? a.href.split('?')[0] : null }; }));
    for (const c of cards) {
      if (!c.name || !c.price) continue;
      const slug = c.href ? (c.href.match(/\/hotel\/[a-z]{2}\/([^.]+)\.html/) || [])[1] : null; const co = slug ? coordMap[slug] : null;
      out.push({ site: 'Booking', name: c.name, priceJPY: num(c.price),
        score: c.review ? num((c.review.match(/Scored ([\d.]+)/) || [])[1]) : null,
        reviews: c.review ? num((c.review.match(/([\d,]+)\s+reviews?/) || [])[1]) : null,
        type: /dorm/i.test(c.units || '') ? 'Hostel/dorm' : 'Hotel/room', href: c.href,
        lat: co?.lat ?? null, lon: co?.lon ?? null });
    }
    await sleep(jit(2000, 3500));
  }
  return out;
}

// ---------- HOSTELWORLD ----------
async function hostelworld(page) {
  const url = `https://www.hostelworld.com/hostels/asia/japan/tokyo/?from=${CHECKIN}&to=${CHECKOUT}&guests=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(jit(5000, 7000)); await scroll(page, 7);
  const html = await page.content(); const coordMap = {}, urlMap = {};
  for (const m of html.matchAll(/"geo":\{"@type":"GeoCoordinates","latitude":(-?[\d.]+),"longitude":(-?[\d.]+)\},"aggregateRating":\{"name":"([^"]+)"/g)) coordMap[norm(m[3])] = { lat: +m[1], lon: +m[2] };
  for (const m of html.matchAll(/"url":"(https:\/\/www\.hostelworld\.com\/hostels\/p\/[^"]+)"/g)) { const before = html.slice(Math.max(0, m.index - 1400), m.index); const names = [...before.matchAll(/"name":"([^"]+)"/g)]; if (names.length) { const n = norm(names[names.length - 1][1]); if (!urlMap[n]) urlMap[n] = m[1]; } }
  const rows = await page.$$eval('.property-listing-card', cs => cs.map(c => { const nameEl = c.querySelector('[class*="property-name"], h2, h3'); return { text: c.innerText.replace(/\s+/g, ' ').trim(), name: nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : null }; }));
  const seen = new Set(), out = [];
  for (const r of rows) { const t = r.text || ''; let name = r.name; if (!name) { const m = t.match(/^(?:Hostel\s+)?(.+?)\s+[\d.]+\s+(Superb|Fabulous|Fantastic|Awesome|Very Good|Good)/i); name = m ? m[1].trim() : null; } if (!name || seen.has(name)) continue; seen.add(name);
    const dorm = num((t.match(/Dorms?\s*From\s*¥\s*([\d,]+)/i) || [])[1]); const any = num((t.match(/From\s*¥\s*([\d,]+)/i) || [])[1]); const co = coordMap[norm(name)];
    out.push({ site: 'HW', name, priceJPY: dorm || any, score: num((t.match(/\b([\d.]+)\s+(Superb|Fabulous|Fantastic|Awesome|Very Good|Good)/i) || [])[1]), reviews: num((t.match(/\((\d[\d,]*)\)/) || [])[1]), type: 'Hostel', href: urlMap[norm(name)] || null, lat: co?.lat ?? null, lon: co?.lon ?? null }); }
  return out.filter(r => r.name && r.priceJPY);
}

// ---------- TRIP.COM ----------
async function tripcom(page) {
  const url = `https://www.trip.com/hotels/list?city=228&checkin=${CHECKIN}&checkout=${CHECKOUT}&adult=1&crn=1&curr=JPY&sort=1`; // sort=1 price asc
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(jit(8000, 10000)); await scroll(page, 10);
  const rows = await page.$$eval('[class*="hotel-card"]', cs => cs.map(c => {
    const nameEl = c.querySelector('[class*="name"],[class*="Name"]'); const a = c.querySelector('a[href*="/hotels/detail"]');
    const priceEl = c.querySelector('.room-price, [class*="price-line"], [class*="price" i]');
    const txt = c.innerText.replace(/\s+/g, ' ').trim();
    return { name: nameEl ? nameEl.innerText.replace(/\s+/g, ' ').trim() : null, priceTxt: priceEl ? priceEl.innerText.replace(/\s+/g, ' ') : txt, txt, href: a ? a.href.split('?')[0] : null };
  }));
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (!r.name || seen.has(r.name)) continue; seen.add(r.name);
    // Robust price: prefer whole-stay "Total price" / nights (avoids Trip Coins / discount amounts).
    let price = null;
    const totalM = r.txt.match(/Total price[:\s]*JPY\s*([\d,]+)/i);
    if (totalM) price = Math.round(num(totalM[1]) / NIGHTS);
    if (!price) { const nums = [...r.txt.matchAll(/JPY\s*([\d,]+)/gi)].map(m => num(m[1])).filter(n => n >= 1500 && n < 400000); if (nums.length) price = Math.min(...nums); }
    const score = num((r.txt.match(/([\d.]+)\s*\/\s*10/) || [])[1]);
    const reviews = num((r.txt.match(/([\d,]+)\s*reviews?/i) || [])[1]);
    if (!price || price < 1500) continue;                              // implausibly low -> parsing artefact
    out.push({ site: 'Trip.com', name: r.name, priceJPY: price, score, reviews, type: /hostel|dorm|guest/i.test(r.txt) ? 'Hostel/guesthouse' : 'Hotel', href: r.href, lat: null, lon: null });
  }
  return out;
}

(async () => {
  try { const fx = await (await fetch('https://open.er-api.com/v6/latest/INR', { headers: { 'User-Agent': OSM_UA } })).json(); if (fx?.rates?.JPY) FX = +fx.rates.JPY.toFixed(4); } catch {}
  const capJPY = Math.round(CAP_INR * FX), bandLowJPY = Math.round(BAND_LOW_INR * FX);
  console.log(`FX 1 INR=${FX} JPY | cap ¥${capJPY}/night (₹${CAP_INR}) | band ¥${bandLowJPY}-${capJPY}`);
  const { browser, ctx } = await launch(); const page = await ctx.newPage();
  const raw = { generatedAt: new Date().toISOString(), fx: FX, capINR: CAP_INR, bandLowINR: BAND_LOW_INR, capJPY, ratingFloor: RATING_FLOOR, ref: REF, nights: NIGHTS, sites: {}, };

  for (const [nm, fn] of [['Booking', booking], ['HW', hostelworld], ['Trip.com', tripcom]]) {
    try { const r = await fn(page); raw.sites[nm] = r.length; console.log(`${nm}: ${r.length} rows`); (raw._all = raw._all || []).push(...r); }
    catch (e) { console.log(`${nm} ERROR ${e.message.split('\n')[0]}`); raw.sites[nm] = 'error'; }
    await sleep(jit(3000, 5000));
  }
  await browser.close();

  // filter: price <= cap, rating >= floor (keep null-rating out), dedupe by name across sites (keep cheapest, record all site prices)
  const all = raw._all || [];
  const groups = {};
  for (const h of all) {
    if (!h.priceJPY || h.priceJPY > capJPY) continue;
    if (h.score == null || h.score < RATING_FLOOR) continue;
    const k = norm(h.name); (groups[k] = groups[k] || []).push(h);
  }
  const merged = [];
  for (const g of Object.values(groups)) {
    g.sort((a, b) => a.priceJPY - b.priceJPY); const best = { ...g[0] };
    const byS = {}; for (const x of g) if (!byS[x.site] || x.priceJPY < byS[x.site]) byS[x.site] = x.priceJPY;
    best.offers = Object.entries(byS).map(([site, priceJPY]) => ({ site, priceJPY })).sort((a, b) => a.priceJPY - b.priceJPY);
    best.sites = Object.keys(byS);
    best.score = Math.max(...g.map(x => x.score || 0)); best.reviews = Math.max(...g.map(x => x.reviews || 0));
    merged.push(best);
  }
  console.log(`\nWithin budget & rating: ${merged.length} unique properties. Enriching...`);
  for (const h of merged) {
    if (h.lat == null) { const gc = await geocode(h.name); if (gc) { h.lat = gc.lat; h.lon = gc.lon; h.geoSrc = 'osm'; } }
    if (h.lat != null) { const d = hav(REF.lat, REF.lon, h.lat, h.lon); if (d <= 30) { h.refKm = d; h.refWalk = walkMin(d); const st = await nearestStation(h.lat, h.lon); if (st) h.station = st; } else h.geoWarn = true; } else h.geoWarn = true;
  }
  merged.forEach(h => { h._rank = (h.refKm != null ? (h.refKm < 1 ? 50 : h.refKm < 2 ? 40 : h.refKm < 3.5 ? 28 : h.refKm < 6 ? 15 : 5) : 0) + (h.station ? (h.station.km < 0.4 ? 20 : h.station.km < 0.8 ? 14 : 8) : 0) + (h.score ? (h.score - 7) * 5 : 0) + (h.reviews ? Math.min(8, Math.log10(Math.max(1, h.reviews)) * 3) : 0) + Math.max(0, (capJPY - h.priceJPY) / capJPY * 6); });
  merged.sort((a, b) => b._rank - a._rank);
  // Supplementary: cheapest decently-rated *hotels/private* just above the per-person cap,
  // for breadth (mostly Trip.com / Booking private rooms). Deduped, up to 10.
  const aboveG = {};
  for (const h of all) { if (!h.priceJPY || h.score == null || h.score < RATING_FLOOR) continue; if (h.priceJPY <= capJPY || h.priceJPY > capJPY * 2) continue; if (/hostel|dorm/i.test(h.type)) continue; const k = norm(h.name); if (!aboveG[k] || h.priceJPY < aboveG[k].priceJPY) aboveG[k] = h; }
  raw.aboveBudgetHotels = Object.values(aboveG).sort((a, b) => a.priceJPY - b.priceJPY).slice(0, 10);
  raw.refStation = await nearestStation(REF.lat, REF.lon);
  raw.results = merged; delete raw._all;
  fs.writeFileSync(path.join(OUT, 'tokyo_broad.json'), JSON.stringify(raw, null, 1));
  console.log(`Saved output/tokyo_broad.json (${merged.length} ranked)`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
