<#
  Generates intersections.json from OpenStreetMap via the Overpass API.

  Strategy: fetch every named street (way) inside the Philadelphia city boundary,
  then treat any OSM node shared by two or more DIFFERENTLY-NAMED streets as an
  intersection. The label is the two street "cores" (e.g. "North 2nd Street" +
  "Arch Street" -> "2nd & Arch").

  Using the city administrative boundary (not a lat/lng box) means it covers the
  WHOLE city (incl. Chestnut Hill and the Northeast) and excludes New Jersey /
  the suburbs automatically.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\generate_intersections.ps1
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

$outPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'intersections.json'

# Streets within the Philadelphia city boundary (admin_level 8).
$ql = @"
[out:json][timeout:300];
area["boundary"="administrative"]["admin_level"="8"]["name"="Philadelphia"]->.a;
way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"]["name"](area.a);
(._;>;);
out qt;
"@

# The main overpass-api.de host is often overloaded for a whole-city query;
# try mirrors in order.
$hosts = @(
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
)
$raw = $null
foreach ($h in $hosts) {
  Write-Host "Querying $h (whole-city query, can take 1-3 min)..."
  try {
    $resp = Invoke-WebRequest -Uri $h -Method Post -Body @{ data = $ql } `
        -UseBasicParsing -TimeoutSec 300 `
        -Headers @{ 'User-Agent' = 'philly-nbhd-game/1.0 (mg.gaida@gmail.com)'; 'Accept' = 'application/json' }
    if ($resp.Content -like '*"elements"*') { $raw = $resp.Content; break }
    Write-Host "  (no data / busy, trying next mirror)"
  } catch {
    Write-Host ("  ({0}, trying next mirror)" -f $_.Exception.Message)
  }
}
if (-not $raw) { throw "All Overpass mirrors failed or were busy. Try again shortly." }

# ConvertFrom-Json in PS 5.1 chokes on large payloads; use the serializer directly.
$js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$js.MaxJsonLength = [int]::MaxValue
$doc = $js.DeserializeObject($raw)
$els = $doc['elements']
Write-Host ("Elements returned: {0}" -f $els.Count)

function Get-Core([string]$n) {
    $c = $n
    # Drop a leading direction only when it precedes a number (grid side: "North 2nd" -> "2nd").
    $c = [regex]::Replace($c, '^(North|South|East|West)\s+(?=\d)', '')
    # Drop a generic street-type suffix.
    $c = [regex]::Replace($c, '\s+(Street|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Place|Pl|Square|Sq|Drive|Dr|Way|Terrace|Ter|Court|Ct|Pike|Parkway|Pkwy|Circle|Walk|Plaza|Row|Alley)\.?$', '')
    return $c.Trim()
}

$nodeLL = @{}      # nodeId -> @(lat,lng)
foreach ($e in $els) {
    if ($e['type'] -eq 'node') { $nodeLL[[string]$e['id']] = @($e['lat'], $e['lon']) }
}

$nodeCores = @{}   # nodeId -> HashSet of street cores
foreach ($e in $els) {
    if ($e['type'] -ne 'way') { continue }
    $tags = $e['tags']
    if (-not $tags -or -not $tags['name']) { continue }
    $core = Get-Core([string]$tags['name'])
    if (-not $core) { continue }
    foreach ($nid in $e['nodes']) {
        $k = [string]$nid
        if (-not $nodeCores.ContainsKey($k)) {
            $nodeCores[$k] = New-Object System.Collections.Generic.HashSet[string]
        }
        [void]$nodeCores[$k].Add($core)
    }
}

$seen = New-Object System.Collections.Generic.HashSet[string]
$out = New-Object System.Collections.ArrayList
foreach ($k in $nodeCores.Keys) {
    $set = $nodeCores[$k]
    if ($set.Count -lt 2) { continue }
    if ($set.Count -gt 3) { continue }          # skip messy 4+ street tangles
    if (-not $nodeLL.ContainsKey($k)) { continue }
    $cores = @($set) | Sort-Object
    $name = $cores -join ' & '
    if (-not $seen.Add($name)) { continue }      # dedupe by label
    $ll = $nodeLL[$k]
    [void]$out.Add([pscustomobject]@{
        name = $name
        lat  = [math]::Round([double]$ll[0], 6)
        lng  = [math]::Round([double]$ll[1], 6)
    })
}

$sorted = $out | Sort-Object name
$json = $sorted | ConvertTo-Json -Depth 4
Set-Content -Path $outPath -Value $json -Encoding UTF8

# Also emit a JS version so the game runs by double-clicking index.html (no server).
$jsPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'intersections.js'
Set-Content -Path $jsPath -Value ("window.INTERSECTIONS = " + $json + ";") -Encoding UTF8

Write-Host ("Wrote {0} intersections to {1}" -f $sorted.Count, $outPath)
Write-Host ("Wrote {0}" -f $jsPath)
