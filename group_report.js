/*
 * Reads output/group.json and writes group_room_recommendations.md:
 * for 3 people sharing one booking <= a per-night group budget, split into
 *   Tier A: verified 3-5 rooms (private Triple/Quad/Quint/Family, or stated small dorm)
 *   Tier B: 3 dorm beds where Booking doesn't publish the dorm size (<=5 unverifiable)
 */
const fs = require('fs');
const path = require('path');

const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'output', 'group.json'), 'utf8'));
const FX = g.fx;
const yen = n => '¥' + Number(n).toLocaleString();
const rup = n => '₹' + Math.round(n).toLocaleString();
const inr = j => Math.round(j / FX);

const META = {
  tokyo: { name: 'Tokyo', dates: '1–9 Oct 2026', nights: 8, ref: 'VIA INN Iidabashi Korakuen' },
  kyoto: { name: 'Kyoto', dates: '26–29 Sep 2026', nights: 3, ref: 'APA Hotel Kyoto Eki Horikawadori' },
  osaka: { name: 'Osaka', dates: '24–27 Sep 2026', nights: 3, ref: 'APA Hotel Osaka Higobashi Ekimae' },
};
const distCell = r => r.refKm == null ? '—' : (r.refKm <= 1.5 ? `${r.refKm.toFixed(1)} km · 🚶~${r.refWalk}m *(walk)*` : `${r.refKm.toFixed(1)} km · 🚇~${(r.station ? r.station.walk : 5) + Math.max(2, Math.round(r.refKm / 0.5)) + 5 + (g.cities[r._ck].refStation ? g.cities[r._ck].refStation.walk : 4)}m`);
const stnCell = r => r.station ? `${r.station.name} · 🚶~${r.station.walk}m` : '—';
const revCell = r => r.reviews == null ? (r.score != null ? `${r.score} (n/a)` : '—') : (r.reviews < 20 ? `${r.score} (${r.reviews} ⚠️)` : `${r.score} (${r.reviews.toLocaleString()})`);

function rows(list, nights) {
  const L = [];
  L.push('| # | Hostel | Room for the 3 of you | Group ₹/night (¥) | Per person/night | Whole stay (' + nights + 'n) | Dist. from friends | Hostel metro (walk) | Score (rev) | Link |');
  L.push('|--:|--------|-----------------------|-------------------|------------------|--------------------|--------------------|---------------------|-------------|------|');
  list.forEach((r, i) => {
    L.push(`| ${i + 1} | **${r.name}** | ${r.roomDesc} | ${rup(inr(r.groupCost))} (${yen(r.groupCost)}) | ${rup(inr(r.groupCost / g.people))} | ${rup(inr(r.groupCost * nights))} | ${distCell(r)} | ${stnCell(r)} | ${revCell(r)} | ${r.href ? `[Book](${r.href})` : '—'} |`);
  });
  return L;
}

const out = [];
out.push('# Japan — group rooms for 3 (Tokyo · Kyoto · Osaka)\n');
out.push(`_Generated ${new Date(g.generatedAt).toUTCString()} · live FX 1 INR = ${FX} JPY · budget ≤ ${rup(g.budgetNightINR)}/night for the room(s) holding all 3 of you (≈ ${yen(g.budgetNightJPY)}/night)._\n`);
out.push('> **What this is:** ways for **3 people to share one booking** at **≤ ₹8,000/night total**, sized **3–5**. Source: **booking.com** (Hostel property type, `group_adults=3`, `no_rooms=1`, exact dates, JPY→INR at the rate above). Hostelworld is omitted here — its room-level pricing for a group isn\'t reliably machine-readable.\n');
out.push('> **About the 3–5 cap:** Booking reliably labels **private room capacity** (Triple=3, Quadruple=4, Quintuple=5, Family). It frequently does **not** publish a dorm\'s bed-count. So:');
out.push('> - **Tier A ✅ — verified 3–5:** private rooms (just the 3 of you) or a dorm whose size Booking actually states. These satisfy your *max-5* rule.');
out.push('> - **Tier B ⚠️ — 3 dorm beds, size not published:** cheapest way for 3 to share one dorm, but Booking didn\'t state the dorm size, so I can\'t confirm it\'s ≤5 (it may be a 6/8/10-bed dorm). Listed so you have options; verify size on the booking page.\n');
out.push('> ⚠️ **Date overlap still open:** Osaka (24–27 Sep) and Kyoto (26–29 Sep) overlap on 26–27 Sep.\n');
out.push('---\n');

for (const key of ['tokyo', 'kyoto', 'osaka']) {
  const c = g.cities[key]; const m = META[key]; if (!c) continue;
  const res = c.results; res.forEach(r => r._ck = key);
  const A = res.filter(r => r.verifiedMax5).sort((a, b) => (b._rank) - (a._rank));
  const B = res.filter(r => !r.verifiedMax5).sort((a, b) => (b._rank) - (a._rank));
  const rs = c.refStation;
  out.push(`## ${m.name} — ${m.dates} (${m.nights} nights)`);
  out.push(`**Friends' hotel:** ${m.ref}${rs ? ` · nearest station **${rs.name}** (~${rs.walk} min walk)` : ''} · **Budget:** ≤ ₹8,000/night for the group\n`);

  out.push(`### Tier A ✅ — verified 3–5 rooms (${A.length})`);
  if (A.length) out.push(...rows(A, m.nights)); else out.push('_None within ₹8,000/night._');
  out.push('');

  const fill = Math.max(0, 15 - A.length);
  out.push(`### Tier B ⚠️ — 3 beds in one dorm, size not published (top ${Math.min(fill, B.length)} of ${B.length})`);
  if (B.length && fill) out.push(...rows(B.slice(0, fill), m.nights)); else out.push('_—_');
  out.push('\n---\n');
}

out.push('## Notes');
out.push('- **Group ₹/night** is the price for the whole room (private) or for **3 dorm beds** (dorm), per night — this is what you compare to the ₹8,000 cap. **Per person/night** and **whole-stay** are derived.');
out.push('- **Tier B sizes:** Booking often hides dorm bed-counts; open the property page and pick a 3–5-bed dorm to honour your max-5. Where Booking *did* state a size (e.g. "8-bed", "12-bed") it\'s shown — those above 5 are in Tier B deliberately.');
out.push('- **Private rooms** mean just the 3 of you (no strangers); a Family room may seat more than 3 but is booked whole for you.');
out.push('- **Distances** are straight-line to your friends\' hotel; 🚇 is a rough door-to-door metro estimate (walk to hostel station + ride + walk from their station). Prices are live at scrape time.');
out.push('- Tokyo has few private rooms ≤ ₹8,000/night (central private hostel rooms run higher), so most Tokyo options are Tier B dorm-bed bookings.');

fs.writeFileSync(path.join(__dirname, 'group_room_recommendations.md'), out.join('\n') + '\n');
console.log('Wrote group_room_recommendations.md');
