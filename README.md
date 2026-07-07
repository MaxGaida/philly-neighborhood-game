# Name That Neighborhood — Philadelphia

A tiny web game for crowdsourcing mental maps of Philadelphia. A player is shown
a random intersection on a map and types the neighborhood they think it's in.
Every answer is logged so you can build a map of where people think each
neighborhood's boundaries are — and where they disagree.

```
index.html            the game page
styles.css            styling
app.js                game logic (map, autocomplete, submit, local backup)
config.js             <-- paste your Google Apps Script URL here
intersections.json    8,400+ real Philly intersections (name + lat/lng)
neighborhoods.json    autocomplete suggestions (free text also allowed)
apps_script/Code.gs   Google Sheet backend to paste into Apps Script
tools/serve.ps1       zero-install local web server (PowerShell)
tools/generate_intersections.ps1   regenerate/expand intersections from OSM
```

Answers are **always** saved locally in the browser (and exportable as CSV),
so the game works even before you wire up the Google Sheet.

The game is played in **rounds of 10**: after each round a summary highlights a
neighborhood you contributed to ("You're helping draw Fishtown") and links to it
on the crowd map. A **collective progress bar** shows how many corners the crowd
has mapped so far (read from `?mode=all`).

> **Testing note:** because `config.js` holds the live endpoint, submitting
> answers from a local copy writes to the real Sheet. To test without polluting
> data, blank the `endpoint` in `config.js` first (answers then stay local).

---

## 1. Run it locally

**Just double-click `index.html`.** The intersection data is bundled as JS
(`intersections.js`, `neighborhoods.js`), so it opens straight from the file
system — no server needed.

The bar-chart of *how everyone voted* needs the Google Sheet backend (step 2)
to show other people's answers; until then it shows the tally from your own
device so you can see the feature working.

(Optional) If you'd rather serve it over HTTP, a zero-install PowerShell server
is included:

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1 8000
```
then open <http://localhost:8000/>.

## 2. Set up the Google Sheet backend

This is what lets answers from *other people* land in one place.

1. Create a new Google Sheet (sheets.new).
2. **Extensions ▸ Apps Script**. Delete the sample code, paste in the contents
   of [`apps_script/Code.gs`](apps_script/Code.gs), and **Save**.
3. **(Recommended — least privilege)** ⚙️ **Project Settings** ▸ enable
   *"Show `appsscript.json` manifest file in editor"*, then open `appsscript.json`
   and add the `oauthScopes` from [`apps_script/appsscript.json`](apps_script/appsscript.json):
   ```json
   "oauthScopes": ["https://www.googleapis.com/auth/spreadsheets.currentonly"]
   ```
   This limits the script to **only this spreadsheet** instead of all of your
   Sheets. Save.
4. **Deploy ▸ New deployment**. Click the gear ▸ **Web app**. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. **Deploy**, then authorize. The "Google hasn't verified this app" screen is
   normal for your own script — **Advanced ▸ Go to … (unsafe)**. With the scope
   above, it will ask only for the one spreadsheet. Copy the **Web app URL**
   (ends in `/exec`).
6. Paste that URL into [`config.js`](config.js):
   ```js
   window.APP_CONFIG = { endpoint: "https://script.google.com/macros/s/AKfy.../exec" };
   ```

The script creates a `responses` tab with columns:
`timestamp, intersection, lat, lng, answer, session, user_agent`.

> Answers are sent with `mode: "no-cors"`, so the browser fires the write but
> can't read the reply — normal for Apps Script. Confirm it works by playing a
> round and watching a row appear in the Sheet.

The same script also serves the **"how everyone voted"** chart and the **crowd
map** (`map.html`): after each answer the game calls the endpoint (via JSONP) for
that corner's breakdown, and the map calls `?mode=all` for every corner's tally.
These turn on automatically once the endpoint is set — no extra setup. If you ever
change/redeploy the script, make a **new deployment** (or "Manage deployments ▸
edit ▸ new version") so the `/exec` URL serves the update. (The `?mode=all`
endpoint was added for the map, so redeploy if you set the backend up earlier.)

## 3. Publish the public link

The site is fully static — host the folder anywhere free:

- **GitHub Pages:** push this folder to a repo, Settings ▸ Pages ▸ deploy from
  branch. Your link: `https://<user>.github.io/<repo>/`.
- **Cloudflare Pages / Netlify:** drag-and-drop the folder into their dashboard.

Commit `config.js` **with** your endpoint URL so the hosted site records data.
(The endpoint URL is not a secret — it only accepts appends.)

## 4. Expand or change intersection coverage

`intersections.json` was generated from OpenStreetMap. To regenerate (e.g. widen
the area or refresh), edit the `$bbox` at the top of
[`tools/generate_intersections.ps1`](tools/generate_intersections.ps1)
(`south,west,north,east`) and run:

```powershell
powershell -ExecutionPolicy Bypass -File tools\generate_intersections.ps1
```

It finds every OSM node shared by two differently-named streets and labels it
(e.g. `2nd & Arch`). The current file covers Center City, South Philadelphia,
Fairmount, Northern Liberties/Fishtown, and parts of West/Southwest Philly.

**After regenerating, re-run the weighting step** (below) so the new corners get
their boundary weights.

### Boundary weighting (which corners come up more often)

To avoid burning players on uncontroversial interiors, corners are sampled
*weighted* toward neighborhood boundaries. `tools/weight_intersections.ps1` uses
the OpenDataPhilly neighborhoods polygons (`tools/philadelphia-neighborhoods.geojson`)
to tag each corner with its containing neighborhood (`hood`), metres to the
nearest border (`edge_m`), and a sampling `weight`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\weight_intersections.ps1
```

Corners on a border are shown ~6-7x more often than deep interiors; corners
outside every official neighborhood (rivers/parks/industrial) are shown rarely.
Tune the bias by editing the weight formula (`0.15 + exp(-edge_m/250)`) at the
top of that script — a smaller floor/scale = stronger bias toward boundaries.

### Map / anti-leaking note

The map is a **vector** base map (MapLibre GL + OpenFreeMap "liberty" style, free,
no API key). Because it's vector, `app.js` switches OFF the neighborhood/place
name layers *and* the POI name layers (`hidePlaceLabels`, hiding the `place` and
`poi` source-layers) while keeping **street names** — at every zoom level. So the
neighborhood answer is never printed on the map, even zoomed all the way in, and
users can still freely zoom and pan for orientation. To reveal or hide more label
types, edit the `source-layer` check in `hidePlaceLabels`.

---

## The crowd map (`map.html`)

The map page is built in and updates itself from the same votes — no extra work.
Reach it from the "See the crowd map ▸" link on the game page. It reads corner
coordinates from `intersections.js` and joins them to live tallies from the
`?mode=all` endpoint (falling back to this browser's own log if no backend is
set, so it's demoable offline). Two views:

- **Winner by corner** — every corner is a dot colored by its plurality
  neighborhood; corners with no majority are outlined (contested). A legend lists
  the leading neighborhoods. Click any dot for its full breakdown.
- **Explore a neighborhood** — pick a name; each corner's opacity is the share of
  its votes calling it that. This traces a neighborhood's fuzzy, crowd-defined
  extent — the "by percentage" view.

It renders **points**, which is honest while data is still sparse. The
interesting output is the *disagreement*: corners where the vote splits are
exactly the contested neighborhood boundaries.

### Publication-quality upgrade (filled regions)

Once you have dense coverage and want filled neighborhood *areas* rather than
dots, export the Sheet as CSV (or use the in-game *Export my data* link),
optionally **normalize** aliases (e.g. "Wash West" = "Washington Square West"),
and:

- **QGIS** — draw **Voronoi/Thiessen** polygons around the intersections and
  color each by its plurality answer to get filled regions with fuzzy,
  data-driven borders; or interpolate a per-neighborhood share surface.
- **kepler.gl** — drag the CSV in, color by winning neighborhood. Fastest look.

The same Voronoi approach could later be added to `map.html` (via `d3-delaunay`)
to turn the dots into filled cells in the browser.
