/*
 * Re-runs geolocation enrichment on already-scraped candidates in
 * output/raw.json (no site re-scraping), using the improved geocoder and the
 * shared OSM cache, then re-ranks and rewrites raw.json. Idempotent.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'output');
const OSM_UA = 'japan-hostel-research/1.0 (personal one-off trip planning)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

const CITIES = {
  tokyo: { name: 'Tokyo', ref: { lat: 35.70577, lon: 139.74337 }, viewbox: '139.60,35.55,139.92,35.82' },
  kyoto: { name: 'Kyoto', ref: { lat: 34.98666, lon: 135.75358 }, viewbox: '135.68,34.93,135.83,35.07' },
  osaka: { name: 'Osaka', ref: { lat: 34.69205, lon: 135.49533 }, viewbox: '135.40,34.60,135.58,34.76' },
};

function haversine(a1, o1, a2, o2) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(a2 - a1), dLon = toR(o2 - o1);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a1)) * Math.cos(toR(a2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const walkMin = km => Math.round(km * 1000 / 80);

const CACHE_FILE = path.join(OUT, 'osm_cache.json');
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
async function osmFetch(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': OSM_UA }, ...opts });
  if (!r.ok) throw new Error('OSM HTTP ' + r.status); return r.json();
}
async function geocodeRaw(query, viewbox) {
  const key = 'geo:' + query + (viewbox ? '|b' : '');
  if (cache[key]) return cache[key];
  let u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&q=${encodeURIComponent(query)}`;
  if (viewbox) u += `&viewbox=${viewbox}&bounded=1`;
  let res = null;
  try { const d = await osmFetch(u); if (d && d[0]) res = { lat: +d[0].lat, lon: +d[0].lon, name: d[0].display_name }; } catch {}
  if (res) { cache[key] = res; saveCache(); }
  await sleep(jitter(1100, 1500)); return res;
}
function cleanName(n) {
  return n.replace(/\s*[-–—]\s*(Male|Female|Women|Mixed|Adults?).*$/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(Hostel|Hotel|Guesthouse|Guest House|Backpackers?|Inn|Lounge|Bar)\b/gi, ' ')
    .replace(/[«»<>]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function geocodeHostel(name, city) {
  for (const [q, vb] of [
    [`${name}, ${city.name}, Japan`, city.viewbox],
    [`${cleanName(name)} ${city.name}`, city.viewbox],
    [`${name}, ${city.name}`, null],
  ]) {
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
  } catch {}
  if (best) { cache[key] = best; saveCache(); }
  await sleep(jitter(1100, 1500)); return best;
}
function rankScore(h, budgetJPY) {
  let s = 0;
  if (h.refKm != null) s += h.refKm < 1 ? 50 : h.refKm < 2 ? 40 : h.refKm < 3.5 ? 28 : h.refKm < 6 ? 15 : 5;
  if (h.station) s += h.station.km < 0.4 ? 20 : h.station.km < 0.8 ? 14 : 8;
  if (h.score != null) s += (h.score - 7) * 4;
  if (h.reviews != null) s += Math.min(8, Math.log10(Math.max(1, h.reviews)) * 3);
  if (h.isDorm && h.beds && h.beds >= 3 && h.beds <= 5) s += 8;
  else if (h.isDorm && h.beds && h.beds >= 6) s += 3;
  if (h.priceJPY != null && h.priceJPY <= budgetJPY) s += 6;
  return s;
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'raw.json'), 'utf8'));
  for (const key of Object.keys(raw.cities)) {
    const city = CITIES[key]; const c = raw.cities[key];
    let fixed = 0;
    for (const h of c.within) {
      if (h.refKm != null) continue;          // already geocoded
      delete h.geoWarn;
      const g = await geocodeHostel(h.name, city);
      if (g) {
        h.lat = g.lat; h.lon = g.lon; h.refKm = haversine(city.ref.lat, city.ref.lon, g.lat, g.lon); h.refWalk = walkMin(h.refKm);
        const st = await nearestStation(g.lat, g.lon); if (st) h.station = st;
        fixed++;
      } else { h.geoWarn = true; }
    }
    c.within.forEach(h => h._rank = rankScore(h, raw.budgetJPY));
    c.within.sort((a, b) => b._rank - a._rank);
    const ok = c.within.filter(h => h.refKm != null).length;
    console.log(`${key}: newly geocoded ${fixed}; total with location ${ok}/${c.within.length}`);
  }
  fs.writeFileSync(path.join(OUT, 'raw.json'), JSON.stringify(raw, null, 1));
  console.log('raw.json updated');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
