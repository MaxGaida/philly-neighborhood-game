/* Name That Neighborhood — client logic
 * - shows a random Philly corner on a Leaflet map
 * - autocompletes the answer, saves it (Google Sheet + local backup)
 * - then shows how everyone else voted for that corner as a little bar chart
 */
(function () {
  "use strict";

  var ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.endpoint || "").trim();

  var LS = {
    session: "png_session",
    seen: "png_seen",        // corner names answered this session (avoid repeats)
    count: "png_count",
    log: "png_log"           // local backup of every answer
  };

  function uid() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  }
  var session = localStorage.getItem(LS.session);
  if (!session) { session = uid(); localStorage.setItem(LS.session, session); }

  // ---- state ----------------------------------------------------------------
  var intersections = (window.INTERSECTIONS || []).filter(function (d) {
    return d && typeof d.lat === "number" && typeof d.lng === "number";
  });
  var neighborhoods = window.NEIGHBORHOODS || [];
  var current = null;
  var map, marker;
  var DEFAULT_ZOOM = 14.5;

  var el = {
    label:    document.getElementById("corner-label"),
    input:    document.getElementById("answer"),
    sugg:     document.getElementById("suggestions"),
    form:     document.getElementById("answer-form"),
    submit:   document.getElementById("submit-btn"),
    skip:     document.getElementById("skip-btn"),
    dunno:    document.getElementById("dontknow-btn"),
    status:   document.getElementById("status"),
    counter:  document.getElementById("counter"),
    exportL:  document.getElementById("export-link"),
    results:  document.getElementById("results"),
    yourAns:  document.getElementById("your-answer"),
    chart:    document.getElementById("chart"),
    total:    document.getElementById("results-total"),
    next:     document.getElementById("next-btn")
  };

  if (!intersections.length) {
    el.label.textContent = "No intersection data loaded.";
    return;
  }

  initMap();
  updateCounter();
  nextCorner();

  // ---- map ------------------------------------------------------------------
  function initMap() {
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-75.1652, 39.9526],   // [lng, lat]
      zoom: DEFAULT_ZOOM,
      minZoom: 10,
      maxZoom: 18,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"
    }));
    // Vector map -> switch OFF just the neighborhood/place + POI name layers (so
    // the answer isn't printed on the map) while keeping STREET names.
    map.on("load", hidePlaceLabels);
    map.on("styledata", hidePlaceLabels);
  }

  function hidePlaceLabels() {
    if (!map.isStyleLoaded()) { return; }
    var layers = map.getStyle().layers || [];
    layers.forEach(function (l) {
      var sl = l["source-layer"];
      if (sl === "place" || sl === "poi") {
        try { map.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {}
      }
    });
  }

  function showOnMap(d) {
    var lnglat = [d.lng, d.lat];
    map.jumpTo({ center: lnglat, zoom: DEFAULT_ZOOM });
    if (marker) { marker.remove(); }
    marker = new maplibregl.Marker({ color: "#2e6f5e" }).setLngLat(lnglat).addTo(map);
  }

  // ---- corner selection -----------------------------------------------------
  function seenSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LS.seen) || "[]")); }
    catch (e) { return new Set(); }
  }
  function markSeen(name) {
    var s = seenSet(); s.add(name);
    localStorage.setItem(LS.seen, JSON.stringify(Array.from(s)));
  }

  // Weighted pick: corners near neighborhood boundaries (higher `weight`) come
  // up more often than uncontroversial interiors.
  function pickWeighted(pool) {
    var total = 0, i;
    for (i = 0; i < pool.length; i++) { total += (pool[i].weight || 1); }
    var r = Math.random() * total;
    for (i = 0; i < pool.length; i++) {
      r -= (pool[i].weight || 1);
      if (r <= 0) { return pool[i]; }
    }
    return pool[pool.length - 1];
  }

  function nextCorner() {
    hideResults();
    var seen = seenSet();
    var pool = intersections.filter(function (d) { return !seen.has(d.name); });
    if (!pool.length) { pool = intersections; }        // seen them all: recycle
    current = pickWeighted(pool);
    el.label.textContent = current.name;
    showOnMap(current);
    el.input.value = "";
    hideSuggestions();
    el.status.textContent = "";
    el.input.focus();
  }

  // ---- autocomplete ---------------------------------------------------------
  var activeIdx = -1;
  function renderSuggestions(list) {
    el.sugg.innerHTML = "";
    if (!list.length) { hideSuggestions(); return; }
    list.forEach(function (name, i) {
      var li = document.createElement("li");
      li.textContent = name;
      li.dataset.value = name;
      if (i === activeIdx) { li.className = "active"; }
      li.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        el.input.value = name;
        hideSuggestions();
      });
      el.sugg.appendChild(li);
    });
    el.sugg.hidden = false;
  }
  function hideSuggestions() { el.sugg.hidden = true; activeIdx = -1; }

  function matches(q) {
    q = q.trim().toLowerCase();
    if (!q) { return []; }
    var starts = [], contains = [];
    neighborhoods.forEach(function (n) {
      var l = n.toLowerCase();
      if (l.indexOf(q) === 0) { starts.push(n); }
      else if (l.indexOf(q) !== -1) { contains.push(n); }
    });
    return starts.concat(contains).slice(0, 8);
  }

  el.input.addEventListener("input", function () {
    activeIdx = -1;
    renderSuggestions(matches(el.input.value));
  });
  el.input.addEventListener("keydown", function (ev) {
    var items = el.sugg.hidden ? [] : Array.prototype.slice.call(el.sugg.children);
    if (ev.key === "ArrowDown" && items.length) {
      ev.preventDefault(); activeIdx = (activeIdx + 1) % items.length;
      renderSuggestions(matches(el.input.value));
    } else if (ev.key === "ArrowUp" && items.length) {
      ev.preventDefault(); activeIdx = (activeIdx - 1 + items.length) % items.length;
      renderSuggestions(matches(el.input.value));
    } else if (ev.key === "Enter" && activeIdx >= 0 && items[activeIdx]) {
      ev.preventDefault();
      el.input.value = items[activeIdx].dataset.value;
      hideSuggestions();
    } else if (ev.key === "Escape") {
      hideSuggestions();
    }
  });
  document.addEventListener("click", function (ev) {
    if (!ev.target.closest(".autocomplete")) { hideSuggestions(); }
  });

  // ---- submit / skip --------------------------------------------------------
  el.form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var answer = el.input.value.trim();
    if (!answer) { el.input.focus(); return; }
    record(answer);
  });
  el.dunno.addEventListener("click", function () { record("(not sure)"); });
  el.skip.addEventListener("click", function () { nextCorner(); });
  el.next.addEventListener("click", function () { nextCorner(); });

  function record(answer) {
    if (!current) { return; }
    var row = {
      ts: new Date().toISOString(),
      name: current.name,
      lat: current.lat,
      lng: current.lng,
      answer: answer,
      session: session,
      ua: navigator.userAgent
    };
    appendLocal(row);
    markSeen(current.name);
    bumpCounter();
    send(row);
    showResults(current, answer);
  }

  // ---- results / stats ------------------------------------------------------
  function showResults(corner, myAnswer) {
    el.form.hidden = true;
    el.results.hidden = false;
    el.yourAns.textContent = myAnswer;
    el.status.textContent = "";
    // Show local tally immediately, then upgrade with shared data if available.
    renderChart(localTally(corner.name), myAnswer, false);
    if (ENDPOINT) {
      el.total.textContent = "Loading everyone's answers…";
      fetchStats(corner.name, function (data) {
        if (data && data.counts) { renderChart(data.counts, myAnswer, true); }
      });
    }
  }

  function hideResults() {
    el.results.hidden = true;
    el.form.hidden = false;
    el.chart.innerHTML = "";
    el.total.textContent = "";
  }

  // Tally this corner's answers from the local log (so the graph works offline).
  function localTally(name) {
    var log;
    try { log = JSON.parse(localStorage.getItem(LS.log) || "[]"); }
    catch (e) { log = []; }
    var counts = {};
    log.forEach(function (r) {
      if (r.name === name && r.answer) { counts[r.answer] = (counts[r.answer] || 0) + 1; }
    });
    return Object.keys(counts).map(function (k) {
      return { neighborhood: k, count: counts[k] };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  function renderChart(counts, myAnswer, shared) {
    counts = (counts || []).slice();
    // Make sure the player's own vote is represented even if the server hasn't
    // caught up with the just-submitted row yet.
    if (myAnswer && !counts.some(function (c) { return c.neighborhood === myAnswer; })) {
      counts.push({ neighborhood: myAnswer, count: 1 });
    }
    counts.sort(function (a, b) { return b.count - a.count; });
    var total = counts.reduce(function (s, c) { return s + c.count; }, 0) || 1;

    el.chart.innerHTML = "";
    counts.slice(0, 8).forEach(function (c) {
      var pct = Math.round((c.count / total) * 100);
      var row = document.createElement("div");
      row.className = "bar-row" + (c.neighborhood === myAnswer ? " mine" : "");

      var name = document.createElement("span");
      name.className = "bar-name";
      name.textContent = c.neighborhood;

      var track = document.createElement("span");
      track.className = "bar-track";
      var fill = document.createElement("span");
      fill.className = "bar-fill";
      fill.style.width = Math.max(pct, 2) + "%";
      track.appendChild(fill);

      var val = document.createElement("span");
      val.className = "bar-pct";
      val.textContent = pct + "%";

      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(val);
      el.chart.appendChild(row);
    });

    var noun = total === 1 ? "vote" : "votes";
    el.total.textContent = (shared ? "" : "So far on this device: ") +
      total + " " + noun +
      (shared ? " from everyone who's played" : "");
  }

  // JSONP GET to the Apps Script endpoint (avoids CORS on reads).
  function fetchStats(name, cb) {
    var fn = "__png_cb_" + uid();
    var timer = setTimeout(function () { cleanup(); }, 8000);
    window[fn] = function (data) { cleanup(); cb(data); };
    function cleanup() {
      clearTimeout(timer);
      try { delete window[fn]; } catch (e) { window[fn] = undefined; }
      if (s && s.parentNode) { s.parentNode.removeChild(s); }
    }
    var s = document.createElement("script");
    s.src = ENDPOINT + "?intersection=" + encodeURIComponent(name) +
            "&callback=" + fn + "&_=" + Date.now();
    s.onerror = function () { cleanup(); };
    document.body.appendChild(s);
  }

  // ---- persistence ----------------------------------------------------------
  function appendLocal(row) {
    var log;
    try { log = JSON.parse(localStorage.getItem(LS.log) || "[]"); }
    catch (e) { log = []; }
    log.push(row);
    localStorage.setItem(LS.log, JSON.stringify(log));
  }

  function send(row) {
    if (!ENDPOINT) { return; }
    // text/plain keeps this a "simple" request (no CORS preflight); no-cors
    // lets the write go through even though Apps Script sends no CORS headers.
    fetch(ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(row)
    }).catch(function () { /* local copy is the backup */ });
  }

  // ---- counters -------------------------------------------------------------
  function updateCounter() {
    el.counter.textContent =
      (parseInt(localStorage.getItem(LS.count) || "0", 10)) + " corners mapped";
  }
  function bumpCounter() {
    var n = parseInt(localStorage.getItem(LS.count) || "0", 10) + 1;
    localStorage.setItem(LS.count, String(n));
    updateCounter();
  }

  // ---- CSV export -----------------------------------------------------------
  el.exportL.addEventListener("click", function (ev) {
    ev.preventDefault();
    var log;
    try { log = JSON.parse(localStorage.getItem(LS.log) || "[]"); }
    catch (e) { log = []; }
    if (!log.length) { el.status.textContent = "No local data yet."; return; }
    var cols = ["ts", "name", "lat", "lng", "answer", "session"];
    var esc = function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; };
    var csv = cols.join(",") + "\n" +
      log.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(","); }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "philly-neighborhoods-" + session + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
