# Japan trip — hostel research (Tokyo · Kyoto · Osaka)

Goal: use Playwright to scrape **hostelworld.com** and **booking.com** for hostel
options in three Japanese cities, for specific date ranges, and produce a ranked
comparison report per city in `japan_hostel_recommendations.md`.

## Status: ✅ completed — see `japan_hostel_recommendations.md`

The scrape ran successfully against live booking.com and hostelworld.com for all
three cities. The final ranked report is **`japan_hostel_recommendations.md`**.

### Reproduce / refresh the data

```bash
npm install
node scrape.js                 # all three cities -> output/raw.json
node report.js                 # raw.json -> japan_hostel_recommendations.md
# optional: node scrape.js tokyo   (one city)
# optional: node reenrich.js       (retry only geolocation on existing raw.json)
```

### Notes on running in the Claude Code web sandbox

- **Network policy:** the two booking sites must be allowed by the environment's
  egress policy. Set **Network access** to **Full**, or **Custom** with
  `*.hostelworld.com`, `*.booking.com` (plus `*.hwstatic.com`, `*.bstatic.com`)
  and "include default package managers". Docs:
  https://code.claude.com/docs/en/claude-code-on-the-web#network-access
- **Chromium TLS:** the sandbox egress proxy drops Chromium's TLS 1.3 ClientHello,
  so `scrape.js` launches with `--ssl-version-max=tls1.2` (no verification is
  disabled). This flag is harmless on a normal machine.
- **Browser binary:** the sandbox ships Chromium at `/opt/pw-browsers/chromium`,
  which `scrape.js` uses automatically when present (no `playwright install`
  needed). On your own machine run `npx playwright install chromium` instead.

### Broad Tokyo search (all sites, any accommodation type)

`tokyo_broad.js` + `tokyo_broad_report.js` produce **`tokyo_accommodation_broad.md`**:
affordable (₹2,500–3,500/person/night), decently-rated (≥8/10) Tokyo accommodation
of any type, near the reference hotel, refreshed to the run date. Sources: booking.com
(all property types), hostelworld.com, trip.com. Expedia bot-blocks; Agoda/Rakuten need
an interactive flow; Kayak/Google Hotels are metasearch; Airbnb is a different category.

```bash
node tokyo_broad.js           # -> output/tokyo_broad.json
node tokyo_broad_report.js    # -> tokyo_accommodation_broad.md
```

### Group-room search (3 people, one booking)

`group_scrape.js` + `group_report.js` produce **`group_room_recommendations.md`**:
rooms that fit 3 people sized 3–5, at ≤ a per-night group budget. Booking-only
(its detail/search data reliably labels private-room capacity; Hostelworld and
dorm bed-counts are not reliably machine-readable). Output is split into Tier A
(verified 3–5 private rooms / stated small dorms) and Tier B (3 dorm beds where
Booking doesn't publish the dorm size).

```bash
node group_scrape.js          # all three cities -> output/group.json
node group_report.js          # -> group_room_recommendations.md
```

### How it works
- `scrape.js` drives Chromium through booking.com (`ht_id=203` = Hostel property
  type, JPY currency, exact dates) and hostelworld.com (city page, JPY cookie),
  pulling name, per-night price, review score/count, room/bed info and the direct
  booking link. Exact coordinates are read from each site's embedded page JSON.
- Budget is filtered at a live INR→JPY rate (open.er-api.com). Distance/walk-time
  to the reference hotel and the nearest rail/subway station are computed from the
  coordinates via OpenStreetMap (Nominatim fallback + Overpass), then candidates
  are ranked by distance → transit → review score/count → dorm size.
- `report.js` renders the per-city tables, top-3 picks and budget exclusions.

## Search criteria

- Sites: hostelworld.com AND booking.com (booking.com filtered to **Hostel**
  property type only — no hotels/ryokans/apartments).
- Budget: **≤ ₹2,500 (INR) per person per night**, converted to JPY at search time.
  Final prices reported in both JPY and INR.
- Room type: small dorms (3–5 beds) preferred over large dorms (6+) or privates;
  ranked higher when otherwise comparable, but other types not excluded.
- Ranking priority: (1) distance/time from the reference hotel — favour <2 km /
  <15 min, (2) transit connectivity, (3) review score **and** count (flag <20
  reviews as "limited review data"), (4) room size (3–5 bed dorms preferred).

## Cities, dates, reference points

| City  | Dates (2026)        | Nights | Reference hotel                       |
| ----- | ------------------- | ------ | ------------------------------------- |
| Tokyo | 1–9 October         | 8      | VIA INN Iidabashi Korakuen            |
| Kyoto | 26–29 September     | 3      | APA Hotel Kyoto Eki Horikawadori      |
| Osaka | 24–27 September     | 3      | APA Hotel Osaka Higobashi Ekimae      |

> **Known issue (using dates as-is per user):** Osaka (24–27 Sep) and Kyoto
> (26–29 Sep) overlap on the nights of **26–27 Sep** — two cities booked at once.
> Flagged as a likely planning error; user opted to proceed with these dates for
> now and resolve the overlap separately.

## Output

`japan_hostel_recommendations.md` — per city: a comparison table (name | site |
price JPY & INR | room type & beds | distance from reference | nearest metro +
walk time | review score | review count | booking link), top-3 picks with
rationale, and notes on anything considered-but-excluded for budget/dorm-size.

## Setup (already done in this environment)

```bash
npm install            # installs playwright
# Chromium is pre-installed at /opt/pw-browsers in the web environment.
# On your own machine instead run: npx playwright install chromium
```
