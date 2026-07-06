/* Crowd Neighborhood Map — renders the collected votes.
 *
 * Data: corner coordinates come from intersections.js; vote tallies come from
 * the Apps Script endpoint (?mode=all) via JSONP, joined by corner name. If no
 * endpoint is configured (or it's unreachable), falls back to this browser's
 * own local log so the map still shows something.
 *
 * Two views:
 *   - "winner"  : each corner colored by its plurality neighborhood; corners
 *                 with no majority are outlined as contested.
 *   - "explore" : pick a neighborhood; each corner's opacity = the share of its
 *                 votes that named it (its fuzzy, crowd-defined extent).
 */
(function () {
  "use strict";

  var ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.endpoint || "").trim();
  var ACCENT = "#2e6f5e";

  // corner name -> [lng, lat]
  var coords = {};
  (window.INTERSECTIONS || []).forEach(function (d) { coords[d.name] = [d.lng, d.lat]; });

  var features = [];     // base GeoJSON features (name, total, counts, top, topShare)
  var mode = "winner";
  var selHood = null;
  var map, styleReady = false, dataReady = false;

  var el = {
    stats:   document.getElementById("stats"),
    winner:  document.getElementById("mode-winner"),
    explore: document.getElementById("mode-explore"),
    hoodWrap:document.getElementById("hood-wrap"),
    hood:    document.getElementById("hood-select"),
    legend:  document.getElementById("legend"),
    empty:   document.getElementById("empty")
  };

  initMap();
  loadData();

  // ---- map ------------------------------------------------------------------
  function initMap() {
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [-75.14, 40.00],
      zoom: 10.6,
      minZoom: 9,
      maxZoom: 18,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"
    }));
    map.on("styledata", hidePlaceLabels);
    map.on("load", function () {
      hidePlaceLabels();
      map.addSource("votes", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "vote-dots",
        type: "circle",
        source: "votes",
        paint: {
          // Uniform size (scales only with zoom, never with votes/share).
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 13, 6, 16, 9],
          "circle-color": ["get", "color"],
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-color": "#2b2b2b",
          "circle-stroke-width": ["case", ["==", ["get", "contested"], true], 1.4, 0],
          "circle-stroke-opacity": 0.7
        }
      });
      wirePopup();
      styleReady = true;
      render();
    });
  }

  function hidePlaceLabels() {
    if (!map.isStyleLoaded()) { return; }
    (map.getStyle().layers || []).forEach(function (l) {
      if (l["source-layer"] === "place" || l["source-layer"] === "poi") {
        try { map.setLayoutProperty(l.id, "visibility", "none"); } catch (e) {}
      }
    });
  }

  function emptyFC() { return { type: "FeatureCollection", features: [] }; }

  // ---- data -----------------------------------------------------------------
  function loadData() {
    if (ENDPOINT) {
      fetchAll(function (agg) {
        if (agg && countCorners(agg)) { ingest(agg); }
        else { ingest(localAgg()); }   // endpoint up but empty -> show local
      }, function () { ingest(localAgg()); });
    } else {
      ingest(localAgg());
    }
  }

  function countCorners(agg) { return agg ? Object.keys(agg).length : 0; }

  // Build the same shape from this browser's local log: { name: {t, c} }
  function localAgg() {
    var log;
    try { log = JSON.parse(localStorage.getItem("png_log") || "[]"); }
    catch (e) { log = []; }
    var agg = {};
    log.forEach(function (r) {
      if (!r.name || !r.answer) { return; }
      if (!agg[r.name]) { agg[r.name] = { t: 0, c: {} }; }
      agg[r.name].t++;
      agg[r.name].c[r.answer] = (agg[r.name].c[r.answer] || 0) + 1;
    });
    return agg;
  }

  function ingest(agg) {
    features = [];
    var hoodTotals = {};       // neighborhood -> total votes (for the dropdown)
    var voteTotal = 0;
    Object.keys(agg || {}).forEach(function (name) {
      var ll = coords[name];
      if (!ll) { return; }     // corner not in our coordinate set
      var c = agg[name].c || {};
      var total = agg[name].t || 0;
      voteTotal += total;
      var counts = Object.keys(c).map(function (k) { return { hood: k, n: c[k] }; })
                         .sort(function (a, b) { return b.n - a.n; });
      counts.forEach(function (x) { hoodTotals[x.hood] = (hoodTotals[x.hood] || 0) + x.n; });
      var top = counts[0];
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: ll },
        properties: {
          name: name,
          total: total,
          counts: counts,                         // kept for popup + explore
          top: top ? top.hood : "",
          topShare: top ? top.n / total : 0
        }
      });
    });

    dataReady = true;
    populateHoodSelect(hoodTotals);
    updateStats(features.length, voteTotal);
    el.empty.hidden = features.length > 0;
    render();
  }

  // ---- rendering ------------------------------------------------------------
  function render() {
    if (!styleReady || !dataReady) { return; }
    var fc = { type: "FeatureCollection", features: features.map(styleFeature) };
    map.getSource("votes").setData(fc);
    renderLegend();
  }

  // returns a shallow feature with computed color/opacity/contested for the mode
  function styleFeature(f) {
    var p = f.properties;
    var color, opacity, contested = false;
    if (mode === "explore") {
      var share = shareOf(p.counts, selHood, p.total);
      color = ACCENT;
      opacity = share > 0 ? 0.15 + 0.85 * share : 0;   // 0 share -> invisible
    } else {
      color = colorFor(p.top);
      opacity = 0.85;
      contested = p.topShare < 0.5;                     // no majority = contested
    }
    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        name: p.name, total: p.total, top: p.top,
        topShare: p.topShare, counts: p.counts,
        color: color, opacity: opacity, contested: contested
      }
    };
  }

  function shareOf(counts, hood, total) {
    if (!hood || !total) { return 0; }
    for (var i = 0; i < counts.length; i++) {
      if (counts[i].hood === hood) { return counts[i].n / total; }
    }
    return 0;
  }

  // stable color per neighborhood name
  function colorFor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) >>> 0; }
    return "hsl(" + (h % 360) + ",62%,48%)";
  }

  // ---- controls -------------------------------------------------------------
  el.winner.addEventListener("click", function () { setMode("winner"); });
  el.explore.addEventListener("click", function () { setMode("explore"); });
  el.hood.addEventListener("change", function () { selHood = el.hood.value; render(); });

  function setMode(m) {
    mode = m;
    el.winner.classList.toggle("active", m === "winner");
    el.explore.classList.toggle("active", m === "explore");
    el.hoodWrap.hidden = m !== "explore";
    render();
  }

  function populateHoodSelect(hoodTotals) {
    var names = Object.keys(hoodTotals).sort(function (a, b) {
      return hoodTotals[b] - hoodTotals[a] || a.localeCompare(b);
    });
    el.hood.innerHTML = "";
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n; o.textContent = n + " (" + hoodTotals[n] + ")";
      el.hood.appendChild(o);
    });
    if (!selHood || names.indexOf(selHood) === -1) { selHood = names[0] || null; }
    if (selHood) { el.hood.value = selHood; }
  }

  function renderLegend() {
    if (!features.length) { el.legend.hidden = true; return; }
    el.legend.hidden = false;
    if (mode === "explore") {
      el.legend.innerHTML =
        '<div class="legend-title">Share of votes calling a corner<br><strong>' +
        (selHood || "—") + "</strong></div>" +
        '<div class="ramp"><span>0%</span>' +
        '<i style="background:linear-gradient(90deg,rgba(46,111,94,.15),rgba(46,111,94,1))"></i>' +
        "<span>100%</span></div>";
    } else {
      // top neighborhoods by how many corners they win
      var wins = {};
      features.forEach(function (f) { var t = f.properties.top; if (t) { wins[t] = (wins[t] || 0) + 1; } });
      var top = Object.keys(wins).sort(function (a, b) { return wins[b] - wins[a]; }).slice(0, 12);
      el.legend.innerHTML = '<div class="legend-title">Leading neighborhood</div>' +
        top.map(function (n) {
          return '<div class="legend-row"><i style="background:' + colorFor(n) + '"></i>' +
                 esc(n) + " <em>(" + wins[n] + ")</em></div>";
        }).join("") +
        '<div class="legend-row muted"><i class="ring"></i>outlined = contested (no majority)</div>';
    }
  }

  // ---- popup ----------------------------------------------------------------
  function wirePopup() {
    var popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" });
    map.on("mouseenter", "vote-dots", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "vote-dots", function () { map.getCanvas().style.cursor = ""; });
    map.on("click", "vote-dots", function (e) {
      var p = e.features[0].properties;
      var counts = typeof p.counts === "string" ? JSON.parse(p.counts) : p.counts;
      var total = p.total;
      var rows = counts.slice(0, 6).map(function (c) {
        var pct = Math.round((c.n / total) * 100);
        return '<div class="pop-row"><span>' + esc(c.hood) + "</span><b>" + pct + "%</b></div>";
      }).join("");
      popup.setLngLat(e.lngLat)
           .setHTML('<div class="pop-title">' + esc(p.name) + "</div>" + rows +
                    '<div class="pop-total">' + total + (total === 1 ? " vote" : " votes") + "</div>")
           .addTo(map);
    });
  }

  // ---- misc -----------------------------------------------------------------
  function updateStats(nCorners, nVotes) {
    if (!nCorners) { el.stats.textContent = "No votes yet."; return; }
    var src = ENDPOINT ? "" : " (from this device only — no shared backend yet)";
    el.stats.textContent = nVotes + " votes across " + nCorners + " corners" + src + ".";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // JSONP fetch of the full aggregate
  function fetchAll(cb, onErr) {
    var fn = "__map_cb_" + Date.now().toString(36);
    var timer = setTimeout(function () { cleanup(); onErr && onErr(); }, 12000);
    window[fn] = function (data) { cleanup(); cb(data && data.corners); };
    function cleanup() {
      clearTimeout(timer);
      try { delete window[fn]; } catch (e) { window[fn] = undefined; }
      if (s && s.parentNode) { s.parentNode.removeChild(s); }
    }
    var s = document.createElement("script");
    s.src = ENDPOINT + "?mode=all&callback=" + fn + "&_=" + Date.now();
    s.onerror = function () { cleanup(); onErr && onErr(); };
    document.body.appendChild(s);
  }
})();
