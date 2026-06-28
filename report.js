/*
 * Reads output/raw.json (produced by scrape.js) and writes
 * japan_hostel_recommendations.md: per-city comparison table, top-3 picks with
 * rationale, and a "considered but excluded" note.
 */
const fs = require('fs');
const path = require('path');

const BUDGET_INR = 2500;
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'output', 'raw.json'), 'utf8'));
const FX = raw.fx, budgetJPY = raw.budgetJPY;
const inr = jpy => jpy == null ? null : Math.round(jpy / FX);
const yen = n => '¥' + Number(n).toLocaleString();
const rup = n => '₹' + Number(n).toLocaleString();

const CITY_META = {
  tokyo: { name: 'Tokyo', dates: '1–9 October 2026', nights: 8, ref: 'VIA INN Iidabashi Korakuen' },
  kyoto: { name: 'Kyoto', dates: '26–29 September 2026', nights: 3, ref: 'APA Hotel Kyoto Eki Horikawadori' },
  osaka: { name: 'Osaka', dates: '24–27 September 2026', nights: 3, ref: 'APA Hotel Osaka Higobashi Ekimae' },
};

function bedsCell(h) {
  if (h.beds && h.isDorm) return `${h.beds}-bed dorm`;
  if (h.beds) return `${h.beds}-bed room`;
  if (h.isDorm) return 'Dorm (size n/a in listing)';
  return h.roomType || '—';
}
function distCell(h) {
  if (h.refKm != null) return `${h.refKm.toFixed(1)} km · ~${h.refWalk} min walk`;
  if (h.geoWarn) return '_location unverified_';
  return '—';
}
function stnCell(h) { return h.station ? `${h.station.name} · ~${h.station.walk} min` : '—'; }
function revCell(h) {
  if (h.reviews == null) return '—';
  return h.reviews < 20 ? `${h.reviews} ⚠️ limited` : h.reviews.toLocaleString();
}
function linkCell(h) {
  const alt = h.alt ? ` _(also on ${h.alt})_` : '';
  return (h.href ? `[Book](${h.href})` : '—') + alt;
}

function rationale(h) {
  const bits = [];
  if (h.refKm != null) {
    if (h.refKm < 2) bits.push(`Just ${h.refKm.toFixed(1)} km from ${''}the reference hotel (~${h.refWalk} min walk)`);
    else if (h.refKm < 4) bits.push(`A close ${h.refKm.toFixed(1)} km from the reference hotel (~${h.refWalk} min walk, a few minutes by metro)`);
    else bits.push(`${h.refKm.toFixed(1)} km from the reference hotel — a short metro ride rather than a walk`);
  }
  if (h.station) bits.push(`nearest station ${h.station.name} is ~${h.station.walk} min away`);
  let q = '';
  if (h.score != null) {
    const lab = h.score >= 9.3 ? 'an outstanding' : h.score >= 9 ? 'a superb' : h.score >= 8.5 ? 'an excellent' : h.score >= 8 ? 'a strong' : 'a fair';
    q = `Holds ${lab} ${h.score}/10`;
    if (h.reviews != null) q += h.reviews < 20 ? ` but across only ${h.reviews} reviews (limited data — verify before booking)` : ` across ${h.reviews.toLocaleString()} reviews`;
    q += '.';
  }
  const price = `At ${yen(h.priceJPY)}/night (${rup(inr(h.priceJPY))}) it sits ${h.priceJPY <= budgetJPY ? 'within' : 'just over'} the ${rup(BUDGET_INR)} budget`;
  const dorm = h.isDorm
    ? (h.beds && h.beds <= 5 ? `, and the listed unit is a small ${h.beds}-bed dorm — exactly the size you preferred.`
      : (h.beds && h.beds >= 6 ? `, though the listed unit is a larger ${h.beds}-bed dorm.` : ', in dorm accommodation.'))
    : ', though the listed unit is a private room.';
  return `${bits.length ? bits.join(', ') + '. ' : ''}${q} ${price}${dorm}`.replace(/\s+/g, ' ').trim();
}

const out = [];
out.push('# Japan trip — hostel recommendations (Tokyo · Kyoto · Osaka)\n');
out.push(`_Generated ${new Date(raw.generatedAt).toUTCString()} · live FX 1 INR = ${FX} JPY · budget ≤ ${rup(BUDGET_INR)}/person/night ≈ ${yen(budgetJPY)}/night._\n`);
out.push('> **Data sources:** live scrape of **booking.com** (filtered to *Hostel* property type, `ht_id=203`) and **hostelworld.com**, for the exact date ranges below, prices in JPY converted to INR at the rate above. Both sites only report distance "from city centre", so **distance/walk-time to your reference hotel is computed** from each hostel\'s geocoded location (OpenStreetMap) as a straight-line estimate; walking time assumes ~80 m/min. Nearest station is the closest rail/subway node (OpenStreetMap Overpass). Booking bed-counts are the *recommended unit shown in search*; smaller dorms may exist on the property page. Hostelworld listings show a "from" nightly dorm price without the bed count.\n');

out.push('> ⚠️ **Date overlap flag (still open):** Osaka (24–27 Sep) and Kyoto (26–29 Sep) overlap on the nights of **26–27 Sep** — you would be booked in two cities at once. You asked me to proceed with the dates as-is for now; this still needs resolving before you actually book.\n');

out.push('---\n');

for (const key of ['tokyo', 'kyoto', 'osaka']) {
  const c = raw.cities[key]; const m = CITY_META[key];
  if (!c) continue;
  out.push(`## ${m.name} — ${m.dates} (${m.nights} nights)`);
  out.push(`**Reference hotel:** ${m.ref}  ·  **Budget:** ≤ ${rup(BUDGET_INR)}/night (≈ ${yen(budgetJPY)})\n`);

  const ranked = (c.within || []).filter(h => h.priceJPY <= budgetJPY);
  out.push('| # | Hostel | Site | Price/night (JPY / INR) | Room type & beds | Dist. from ref hotel | Nearest station (walk) | Score | Reviews | Link |');
  out.push('|--:|--------|:----:|-------------------------|------------------|----------------------|------------------------|:-----:|--------:|------|');
  ranked.forEach((h, i) => {
    out.push(`| ${i + 1} | **${h.name}** | ${h.site} | ${yen(h.priceJPY)} / ${rup(inr(h.priceJPY))} | ${bedsCell(h)} | ${distCell(h)} | ${stnCell(h)} | ${h.score ?? '—'} | ${revCell(h)} | ${linkCell(h)} |`);
  });
  out.push('');

  out.push(`### Top 3 picks — ${m.name}`);
  ranked.slice(0, 3).forEach((h, i) => {
    out.push(`${i + 1}. **${h.name}** (${h.site}, ${yen(h.priceJPY)}/night ≈ ${rup(inr(h.priceJPY))}). ${rationale(h)}`);
  });
  out.push('');

  // considered but excluded
  const over = (c.over || []).slice(0, 5);
  if (over.length) {
    out.push(`### Considered but set aside — ${m.name}`);
    over.forEach(h => {
      out.push(`- **${h.name}** (${h.site}) — ${yen(h.priceJPY)}/night (${rup(inr(h.priceJPY))}), **over the ${rup(BUDGET_INR)} budget** (${yen(budgetJPY)} cap)${h.score ? `, score ${h.score}` : ''}. Noted in case you flex the budget.`);
    });
    out.push('');
  }
  out.push('---\n');
}

out.push('## Notes & caveats');
out.push('- **Distances are straight-line geodesic estimates**, not door-to-door walking routes; actual walking time will be a little longer. Use them for relative comparison, not exact navigation.');
out.push('- **Booking.com bed counts** reflect the single recommended unit in search results. A property listed with an 8-bed dorm may also sell 4-bed dorms — check the property page if small-dorm size is a dealbreaker.');
out.push('- **Hostelworld** lists a "from" nightly dorm price; the cheapest dorm may be a larger room than you want. Bed count wasn\'t available at the listing level.');
out.push('- **Prices are live at scrape time** and move with demand; re-check before booking. INR figures use the live rate noted at the top.');
out.push('- Hostels with **fewer than 20 reviews** are flagged ⚠️ — treat their scores with caution.');
out.push(`- Geocoding occasionally mismatches an uncommon hostel name; any candidate whose location couldn't be verified within the city is marked _location unverified_ and was not distance-ranked.`);

fs.writeFileSync(path.join(__dirname, 'japan_hostel_recommendations.md'), out.join('\n') + '\n');
console.log('Wrote japan_hostel_recommendations.md');
