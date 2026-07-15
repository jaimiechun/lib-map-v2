# WISE Water Insecurity Data Collection Map

Interactive map of where WISE (Water Insecurity Experiences) data has been
collected, by country. Static site — no build step, no backend. Open
`index.html` directly, serve the folder, or embed it in an `<iframe>`.

## Updating the data

The map is generated from two CSVs in `data/raw/`:

- `site_data.csv` — site-level entries (one row per study location)
- `national_data.csv` — nationally representative surveys (one row per country)

After editing either file, rebuild the data the frontend reads:

```
python3 scripts/build_data.py     # -> data/countries.json + data/countries.js
python3 scripts/build_borders.py  # -> data/borders.js + data/world.js
```

`build_data.py` validates every country name and prints a warning listing any
it can't match (typos, new spellings). Fix the CSV or add an alias to
`COUNTRY_ALIASES` in the script, re-run, then commit and push.

## Deploying / cache-busting

The site is served via GitHub Pages straight from `main`. Browsers (and
GitHub's CDN) aggressively cache `style.css`, `app.js`, and the `data/*.js`
files, so after **any** change to those files — including the data rebuild
above — run:

```
python3 scripts/bump_cache_version.py
```

This stamps a fresh `?v=<timestamp>` onto each of those files' `<script>`/
`<link>` tags in `index.html`, so visitors always get the latest version
instead of a stale cached copy. Commit the updated `index.html` along with
your other changes.

## Visitor data submissions

The "Submit data" button on the map opens a form for visitors to propose new
entries. Nothing a visitor submits ever appears on the map automatically —
submissions go to the research team for review.

How submissions reach the team, in order of setup effort:

1. **Default (no setup): email.** With `SUBMIT_ENDPOINT` empty in `app.js`,
   the form opens the visitor's email app pre-filled with a structured
   submission addressed to `SUBMIT_EMAIL`.
2. **Endpoint (recommended for a live site):** create a Google Apps Script
   web app bound to a Google Sheet (or a Formspree form), paste its URL into
   `SUBMIT_ENDPOINT` at the top of `app.js`, and submissions POST there as
   JSON — landing in a spreadsheet the team can triage.

### Review workflow

1. A submission arrives (email or spreadsheet row).
2. Verify it: check the link, confirm the tool/status, find coordinates for
   site-level entries (any geocoder; decimal lat/long).
3. Add a row to `data/raw/site_data.csv` or `data/raw/national_data.csv`
   matching the existing columns.
4. Re-run the two scripts above; fix any country-name warning.
5. Commit and push — the live site picks it up on the next deploy.
