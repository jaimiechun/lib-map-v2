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

## Country posters

Each country card can show its Canva poster at the bottom, clicking through to
that country's DOI. The pairing comes from the DOI-tracker Google Sheet
(column M = Canva link, column S = DOI); rebuild it with:

```
python3 scripts/build_posters.py
```

That writes `data/posters.js`. Only countries with **both** a Canva link and a
DOI are included — the poster's whole purpose is to be a route to the DOI — so
re-run it as more DOIs are filled in. The script prints which countries it
skipped for a missing DOI, and which names it couldn't match.

### Poster images

Posters are served as PNGs exported from Canva and committed to
`assets/posters/<ISO3>.png`. After a bulk download from Canva (select the
designs in Projects → Download → PNG), import them with:

```
python3 scripts/import_posters.py ~/Downloads/canva-posters
```

That matches each file to a country by the country name in the Canva title,
copies it in under its ISO3 code, downscales it for the web, and points
`data/posters.js` at the local file. It reports anything it couldn't match, and
which posters are waiting on a DOI.

**Do not fall back to Canva embeds.** `build_posters.py` emits an `embed` URL
for any country that has a DOI but no PNG yet, and the card will render it in
an iframe — but that is a stopgap, for two reasons:

1. **The share token is public.** A Canva link is
   `/design/<id>/<token>/...`, and if the design is shared as "anyone with the
   link can edit", that same token opens the *editor*. Publishing it here puts
   edit access to the poster on the open web. Set the designs to view-only in
   Canva, or avoid the embed entirely.
2. **It's slow.** Each embed loads Canva's whole viewer app — several seconds
   before the poster appears, on every card open.

So when a new DOI lands, export that country's PNG and run
`import_posters.py` rather than leaving the embed in place.

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

Submissions POST to a Google Apps Script web app bound to the team's review
spreadsheet: each one becomes a row, and the script emails `SUBMIT_EMAIL`.
The script lives at `scripts/submissions_apps_script.gs`, and its deployment
URL is `SUBMIT_ENDPOINT` at the top of `app.js`. (With `SUBMIT_ENDPOINT`
empty, the form falls back to opening a pre-filled email instead.)

Two things to know if you touch either end:

- **The POST is sent as `text/plain`, not `application/json`.** A JSON
  content type makes it a preflighted cross-origin request, and Apps Script
  web apps don't answer the `OPTIONS` preflight, so submissions would fail
  silently. The script parses the body as JSON regardless.
- **Editing the script isn't enough to change the live behaviour.** In the
  Apps Script editor, re-deploy with Manage deployments > edit > Version:
  New version. The `/exec` URL keeps serving the last deployed version.

To add a form field: add the input to `index.html`, then add its `name` to
`COLUMNS` in the Apps Script so it gets its own spreadsheet column.

### Review workflow

1. A submission arrives as a spreadsheet row (and an email).
2. Verify it: check the link, confirm the tool/status, find coordinates for
   site-level entries (any geocoder; decimal lat/long).
3. Add a row to `data/raw/site_data.csv` or `data/raw/national_data.csv`
   matching the existing columns.
4. Re-run the two scripts above; fix any country-name warning.
5. Commit and push — the live site picks it up on the next deploy.
6. Mark the row's "Reviewed?" and "Added to map?" columns so the sheet
   doubles as the queue rather than just a log.
