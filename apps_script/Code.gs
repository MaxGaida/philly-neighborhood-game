/**
 * Name That Neighborhood — Google Apps Script backend.
 *
 * Setup (see README.md for the full walkthrough):
 *   1. Create a Google Sheet.
 *   2. Extensions ▸ Apps Script, paste this file in, Save.
 *   3. Deploy ▸ New deployment ▸ Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   4. Copy the /exec URL into config.js.
 */

var SHEET_NAME = 'responses';
var HEADERS = ['timestamp', 'intersection', 'lat', 'lng', 'answer', 'session', 'user_agent'];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(30000);
  try {
    var d = JSON.parse(e.postData.contents);
    var sheet = getSheet_();
    sheet.appendRow([
      d.ts || new Date().toISOString(),
      d.name || '',
      d.lat != null ? d.lat : '',
      d.lng != null ? d.lng : '',
      d.answer || '',
      d.session || '',
      d.ua || ''
    ]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET ?intersection=<label>&callback=<fn>  ->  JSONP with the vote breakdown
 * for that corner: { intersection, total, counts:[{neighborhood, count}, ...] }.
 * Called by the game to show "how everyone voted". JSONP is used so the browser
 * can read the response cross-origin (Apps Script sends no CORS headers).
 */
function doGet(e) {
  var p = (e && e.parameter) || {};

  // ?mode=all -> aggregated votes for EVERY corner (used by map.html).
  // Returns compact { corners: { "<name>": { t:<total>, c:{ "<hood>":<count> } } } }.
  if (p.mode === 'all') {
    var agg = {};
    var sheetA = getSheet_();
    var lastA = sheetA.getLastRow();
    if (lastA > 1) {
      var rows = sheetA.getRange(2, 2, lastA - 1, 4).getValues();  // intersection(B), lat, lng, answer(E)
      for (var j = 0; j < rows.length; j++) {
        var nm = String(rows[j][0]);
        var a = String(rows[j][3] || '').trim();
        if (!nm || !a) { continue; }
        if (!agg[nm]) { agg[nm] = { t: 0, c: {} }; }
        agg[nm].t++;
        agg[nm].c[a] = (agg[nm].c[a] || 0) + 1;
      }
    }
    return out_(p.callback, JSON.stringify({ corners: agg }));
  }

  // ?intersection=<label> -> vote breakdown for one corner (used by the game).
  var name = p.intersection;
  if (!name) {
    return ContentService.createTextOutput('Name That Neighborhood endpoint is live.');
  }
  var counts = {};
  var total = 0;
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last > 1) {
    var values = sheet.getRange(2, 2, last - 1, 4).getValues();  // B..E
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]) === String(name)) {
        var ans = String(values[i][3] || '').trim();
        if (!ans) { continue; }
        counts[ans] = (counts[ans] || 0) + 1;
        total++;
      }
    }
  }
  var arr = Object.keys(counts).map(function (k) {
    return { neighborhood: k, count: counts[k] };
  }).sort(function (a, b) { return b.count - a.count; });

  return out_(p.callback, JSON.stringify({ intersection: name, total: total, counts: arr }));
}

// JSONP if a callback is given, otherwise plain JSON.
function out_(callback, payload) {
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + payload + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
