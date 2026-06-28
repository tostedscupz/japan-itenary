# Japan trip — hostel research (Tokyo · Kyoto · Osaka)

Goal: use Playwright to scrape **hostelworld.com** and **booking.com** for hostel
options in three Japanese cities, for specific date ranges, and produce a ranked
comparison report per city in `japan_hostel_recommendations.md`.

## ⚠️ Status: blocked on network access (action needed from you)

This repo was set up in a Claude Code **web** environment whose network policy
(**Trusted**) does **not** allow `hostelworld.com` or `booking.com`. Every request
to those hosts is rejected at the egress proxy with a `403 CONNECT` (a policy
denial, not bot detection / CAPTCHA). Playwright and Chromium are ready; the only
missing piece is outbound access to the two booking sites.

### How to unblock (one-time, ~1 minute)

1. Go to **claude.ai/code** and click the **cloud icon ☁️** (it shows the current
   environment's name) near where you start a task.
2. Hover the environment name and click the **gear / settings ⚙️** icon.
3. Find **Network access** and change it from **Trusted** to either:
   - **Full** — allows any website (simplest), or
   - **Custom** — then in **Allowed domains** add (one per line):
     ```
     *.hostelworld.com
     hostelworld.com
     *.hwstatic.com
     *.booking.com
     booking.com
     *.bstatic.com
     ```
     and tick **"Also include default list of common package managers"** so npm /
     Playwright installs still work.
4. **Save**, then **start a fresh task** in this same environment (the policy is
   locked in when a session starts, so the change applies to new sessions). Tell
   Claude: *"network's open, run the hostel scrape."*

Docs: https://code.claude.com/docs/en/claude-code-on-the-web#network-access

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
