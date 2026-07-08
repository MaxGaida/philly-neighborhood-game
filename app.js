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
  var DEFAULT_ZOOM = 13.5;
  // Touch devices (coarse pointer) get no auto-focus, so the keyboard doesn't
  // cover the map on load; desktop keeps auto-focus for fast typing.
  var CAN_AUTOFOCUS = !(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

  // ---- rounds + collective progress ----
  var ROUND_SIZE = 5;
  var roundCount = 0;         // guesses in the current round
  var roundAnswers = [];      // {answer, hood} for this round (to feature a hood)
  var roundComplete = false;
  var aggregate = null;       // { cornerName: {t, c:{hood:n}} } from ?mode=all
  var coveredSet = null;      // distinct corners with >=1 vote (collective)

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
    next:     document.getElementById("next-btn"),
    progress:      document.getElementById("progress"),
    progressFill:  document.getElementById("progress-fill"),
    progressLabel: document.getElementById("progress-label"),
    roundPips:     document.getElementById("round-pips"),
    roundCount:    document.getElementById("round-count"),
    roundSummary:  document.getElementById("round-summary"),
    rsRecap:       document.getElementById("rs-recap"),
    rsHeadline:    document.getElementById("rs-headline"),
    rsStat:        document.getElementById("rs-stat"),
    rsLink:        document.getElementById("rs-map-link"),
    nextRound:     document.getElementById("next-round-btn")
  };

  if (!intersections.length) {
    el.label.textContent = "No intersection data loaded.";
    return;
  }

  initMap();
  updateCounter();
  renderRoundProgress();
  nextCorner();
  loadAggregate();

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
    // On touch devices, don't auto-focus: focusing pops the on-screen keyboard
    // and hides the map. Let the player see the corner and tap the box when ready.
    if (CAN_AUTOFOCUS) { el.input.focus(); }
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
  el.next.addEventListener("click", function () {
    if (roundComplete) { showRoundSummary(); } else { nextCorner(); }
  });
  el.nextRound.addEventListener("click", function () {
    el.roundSummary.hidden = true;
    roundCount = 0; roundAnswers = []; roundComplete = false;
    renderRoundProgress();
    nextCorner();
  });

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

    // round + collective-progress tracking
    roundAnswers.push({ answer: answer, hood: current.hood || "" });
    roundCount++;
    renderRoundProgress();
    if (coveredSet) { coveredSet.add(current.name); renderProgress(); }

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

    // At the end of a round, the "next" button leads to the round summary.
    roundComplete = roundCount >= ROUND_SIZE;
    el.next.textContent = roundComplete ? "See round summary ▸" : "Next corner ▸";
  }

  function hideResults() {
    el.results.hidden = true;
    if (el.roundSummary) { el.roundSummary.hidden = true; }
    el.form.hidden = false;
    el.chart.innerHTML = "";
    el.total.textContent = "";
  }

  // ---- round summary + collective progress ---------------------------------
  function showRoundSummary() {
    el.results.hidden = true;
    el.form.hidden = true;
    el.roundSummary.hidden = false;
    el.status.textContent = "";

    el.rsRecap.textContent = "Round complete — you mapped " + roundCount + " corners.";
    var hood = featuredHood();
    if (hood) {
      el.rsHeadline.textContent = "You're helping draw " + hood + ".";
      el.rsStat.textContent = aggregateStatFor(hood);
      el.rsLink.href = "map.html?hood=" + encodeURIComponent(hood);
      el.rsLink.textContent = "See " + hood + " on the full map ▸";
    } else {
      el.rsHeadline.textContent = "You're helping map Philadelphia.";
      el.rsStat.textContent = "";
      el.rsLink.href = "map.html";
      el.rsLink.textContent = "See the crowd map ▸";
    }
  }

  // The neighborhood the player named most this round (fallback: the official
  // neighborhood of the corners they saw).
  function featuredHood() {
    var byAnswer = mode(roundAnswers.map(function (r) { return r.answer; })
                       .filter(function (a) { return a && a !== "(not sure)"; }));
    if (byAnswer) { return byAnswer; }
    return mode(roundAnswers.map(function (r) { return r.hood; })
                .filter(function (h) { return !!h; }));
  }
  function mode(arr) {
    var counts = {}, best = null, bestN = 0;
    arr.forEach(function (v) {
      counts[v] = (counts[v] || 0) + 1;
      if (counts[v] > bestN) { bestN = counts[v]; best = v; }
    });
    return best;
  }

  // How much crowd data already exists for a neighborhood (for the summary line).
  function aggregateStatFor(hood) {
    if (!aggregate) { return ""; }
    var corners = 0;
    Object.keys(aggregate).forEach(function (nm) {
      var c = aggregate[nm].c || {};
      if (c[hood]) { corners++; }
    });
    if (!corners) { return "You're one of the first to put it on the map."; }
    return "The crowd has tagged " + corners + (corners === 1 ? " corner" : " corners") +
           " as " + hood + " so far.";
  }

  function loadAggregate() {
    if (!ENDPOINT) { return; }
    fetchAll(function (corners) {
      aggregate = corners || {};
      coveredSet = new Set(Object.keys(aggregate));
      seenSet().forEach(function (nm) { coveredSet.add(nm); });  // include this session
      renderProgress();
    });
  }

  // Per-round pips + "X / 10 this round" so players see they're building toward
  // the round summary (otherwise the round is invisible).
  function renderRoundProgress() {
    if (!el.roundPips.childNodes.length) {
      for (var k = 0; k < ROUND_SIZE; k++) {
        var pip = document.createElement("span");
        pip.className = "pip";
        el.roundPips.appendChild(pip);
      }
    }
    for (var j = 0; j < ROUND_SIZE; j++) {
      el.roundPips.childNodes[j].className = "pip" + (j < roundCount ? " on" : "");
    }
    el.roundCount.textContent = roundCount + " / " + ROUND_SIZE + " this round";
  }

  function renderProgress() {
    if (!coveredSet) { return; }
    var n = coveredSet.size;
    var goal = niceNext(n);
    el.progressFill.style.width = Math.min(100, Math.round((n / goal) * 100)) + "%";
    el.progressLabel.textContent =
      n.toLocaleString() + " corners mapped by the crowd · next goal " + goal.toLocaleString();
    el.progress.hidden = false;
  }

  // Rolling milestone so the bar always looks reachable (not a sliver of 20k).
  function niceNext(n) {
    var steps = [50, 100, 250, 500, 1000, 2000, 3500, 5000, 7500, 10000, 15000, intersections.length];
    for (var i = 0; i < steps.length; i++) { if (n < steps[i]) { return steps[i]; } }
    return intersections.length;
  }

  // JSONP GET of the full aggregate (?mode=all).
  function fetchAll(cb) {
    var fn = "__png_all_" + uid();
    var timer = setTimeout(function () { cleanup(); }, 12000);
    window[fn] = function (data) { cleanup(); cb(data && data.corners); };
    function cleanup() {
      clearTimeout(timer);
      try { delete window[fn]; } catch (e) { window[fn] = undefined; }
      if (s && s.parentNode) { s.parentNode.removeChild(s); }
    }
    var s = document.createElement("script");
    s.src = ENDPOINT + "?mode=all&callback=" + fn + "&_=" + Date.now();
    s.onerror = function () { cleanup(); };
    document.body.appendChild(s);
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
