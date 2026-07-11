/*
 * Renders output/tokyo_broad.json -> tokyo_accommodation_broad.md:
 * broad affordable Tokyo accommodation (all types), ranked by proximity to the
 * friends' hotel, with walk/metro reach and a multi-site price note.
 */
const fs = require('fs');
const path = require('path');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'output', 'tokyo_broad.json'), 'utf8'));
const FX = d.fx;
const yen = n => '¥' + Number(n).toLocaleString();
const rup = n => '₹' + Math.round(n).toLocaleString();
const inr = j => Math.round(j / FX);
const rs = d.refStation;

function metroEst(r) { if (r.refKm == null) return null; const access = r.station ? r.station.walk : 5; const ride = Math.max(2, Math.round(r.refKm / 0.5)); const egress = rs ? rs.walk : 4; return access + ride + 5 + egress; }
const reach = r => r.refKm == null ? (r.geoWarn ? '_loc. unverified_' : '—') : (r.refKm <= 1.5 ? `${r.refKm.toFixed(1)} km · 🚶~${r.refWalk}m *(walkable)*` : `${r.refKm.toFixed(1)} km · 🚶~${r.refWalk}m / 🚇~${metroEst(r)}m`);
const stn = r => r.station ? `${r.station.name} · 🚶~${r.station.walk}m` : '—';
const rev = r => r.reviews == null ? '—' : (r.reviews < 20 ? `${r.reviews} ⚠️` : r.reviews.toLocaleString());
const offers = r => (r.offers || []).map(o => `${o.site} ${yen(o.priceJPY)}`).join(' · ');
function linkCell(r) {
  let href = r.href;
  if (r.site === 'Trip.com' || (href && /\/hotels\/detail\/?$/.test(href))) href = `https://www.trip.com/hotels/list?keyword=${encodeURIComponent(r.name)}`;
  return href ? `[Book](${href})` : '—';
}
const band = r => r.priceJPY < d.bandLowINR * FX ? '💰 under-band' : '';

const out = [];
out.push('# Tokyo — affordable accommodation near your friends (fresh search)\n');
out.push(`_Generated ${new Date(d.generatedAt).toUTCString()} · dates 1–9 Oct 2026 (8 nights), 1 guest · live FX 1 INR = ${FX} JPY._\n`);
out.push(`**Target:** decently-rated (≥ ${d.ratingFloor}/10) accommodation at **₹${d.bandLowINR}–${d.capINR}/person/night** (≈ ${yen(Math.round(d.bandLowINR * FX))}–${yen(d.capJPY)}), any type, ranked by proximity to **${d.ref.name}**${rs ? ` (nearest station **${rs.name}**, ~${rs.walk} min walk)` : ''}.\n`);
out.push('> **Sites searched (every one I could reach):** ✅ **booking.com** (all property types) · ✅ **hostelworld.com** · ✅ **trip.com**. ❌ **Expedia** blocks automation ("Bot or Not"). ⚠️ **Agoda / Rakuten Travel** need an interactive search flow that wouldn\'t drive cleanly. **Kayak / Google Hotels** are metasearch (they resell the same Booking/Agoda/Trip inventory). **Airbnb** loads but is a different category (entire homes / private rooms, per-stay + cleaning fees) — say the word and I\'ll add it.\n');
out.push(`> **What made the cut:** at ₹2,500–3,500/person/night the Tokyo market is **almost entirely hostels & guesthouses** — Trip.com\'s hotel inventory sits above this line (see the "if you\'d stretch" section). ${d.results.length} properties qualified.\n`);
out.push('> **Legend:** 🚶 on foot · 🚇 rough door-to-door metro estimate · ⚠️ next to a review count = <20 reviews (limited data) · 💰 = cheaper than the ₹2,500 band floor.\n');
out.push('> ⚠️ Prices are **live at scrape time** and move with demand; re-check before booking.\n');
out.push('---\n');

out.push(`## Top affordable picks (${Math.min(20, d.results.length)} of ${d.results.length})`);
out.push('| # | Property | Site (cheapest) | Type | ₹/night (¥) | Reach friends\' hotel (walk / metro) | Hostel/property metro (walk) | Friends\' station | Score | Reviews | Also on | Link |');
out.push('|--:|----------|:---------------:|------|-------------|-------------------------------------|------------------------------|------------------|:-----:|--------:|---------|------|');
d.results.slice(0, 20).forEach((r, i) => {
  const also = r.sites.length > 1 ? r.sites.filter(s => s !== r.site).join(', ') : '—';
  out.push(`| ${i + 1} | **${r.name}** ${band(r)} | ${r.site} | ${r.type} | ${rup(inr(r.priceJPY))} (${yen(r.priceJPY)}) | ${reach(r)} | ${stn(r)} | ${rs ? `${rs.name} · 🚶~${rs.walk}m` : '—'} | ${r.score ?? '—'} | ${rev(r)} | ${also} | ${linkCell(r)} |`);
});
out.push('');

// remaining
if (d.results.length > 20) {
  out.push('<details><summary>Show the rest of the qualifying list</summary>\n');
  out.push('| # | Property | Site | Type | ₹/night (¥) | Reach friends | Metro | Score | Reviews |');
  out.push('|--:|----------|:----:|------|-------------|---------------|-------|:-----:|--------:|');
  d.results.slice(20).forEach((r, i) => out.push(`| ${i + 21} | ${r.name} | ${r.site} | ${r.type} | ${rup(inr(r.priceJPY))} (${yen(r.priceJPY)}) | ${reach(r)} | ${stn(r)} | ${r.score ?? '—'} | ${rev(r)} |`));
  out.push('\n</details>\n');
}

// top 3 rationale
out.push('## Top 3 — quick rationale');
d.results.slice(0, 3).forEach((r, i) => {
  const dist = r.refKm == null ? 'location not verified' : (r.refKm <= 1.5 ? `just ${r.refKm.toFixed(1)} km from your friends (~${r.refWalk} min walk)` : `${r.refKm.toFixed(1)} km from your friends (~${metroEst(r)} min by metro)`);
  const st = r.station ? ` Nearest station ${r.station.name} is ~${r.station.walk} min on foot.` : '';
  const rq = r.score != null ? ` Rated ${r.score}/10${r.reviews != null ? (r.reviews < 20 ? ` on only ${r.reviews} reviews ⚠️` : ` across ${r.reviews.toLocaleString()} reviews`) : ''}.` : '';
  out.push(`${i + 1}. **${r.name}** (${r.site}, ${r.type}) — ${rup(inr(r.priceJPY))}/night (${yen(r.priceJPY)}). ${dist[0].toUpperCase() + dist.slice(1)}.${st}${rq}`);
});
out.push('');

// above-budget hotels
if ((d.aboveBudgetHotels || []).length) {
  out.push('## If you\'d stretch past ₹3,500/night — cheapest decent *hotels* (private rooms)');
  out.push('_Booking/Trip.com hotels just above the per-person cap, for when you\'d rather have a private room. Price is per night for the room._\n');
  out.push('| Hotel | Site | ₹/night (¥) | Score | Reviews |');
  out.push('|-------|:----:|-------------|:-----:|--------:|');
  d.aboveBudgetHotels.forEach(h => out.push(`| ${h.name} | ${h.site} | ${rup(inr(h.priceJPY))} (${yen(h.priceJPY)}) | ${h.score ?? '—'} | ${h.reviews == null ? '—' : h.reviews.toLocaleString()} |`));
  out.push('');
}

out.push('## Notes');
out.push('- **Prices are per night for 1 guest** — a hostel dorm bed, or a hotel/private room where noted. INR uses the live rate at the top.');
out.push('- **Distances** are straight-line to your friends\' hotel; 🚇 is a rough door-to-door metro estimate (walk to the property\'s station + ride + walk from your friends\' station).');
out.push('- **"Also on"** flags where the same property was also found on another site (naming differs between sites, so cross-matches are conservative).');
out.push('- **Ratings** are each site\'s guest score on a 10-scale; <20 reviews flagged ⚠️.');
out.push(`- **Sites that didn\'t contribute:** Expedia (bot-blocked), Agoda/Rakuten (interactive-only), Kayak/Google Hotels (metasearch of the same inventory), Airbnb (different category — available on request).`);

fs.writeFileSync(path.join(__dirname, 'tokyo_accommodation_broad.md'), out.join('\n') + '\n');
console.log('Wrote tokyo_accommodation_broad.md');
