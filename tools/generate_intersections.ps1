<#
  Generates intersections.json from OpenStreetMap via the Overpass API.

  Strategy: fetch every named street (way) in the bounding box, then treat any
  OSM node that is shared by two or more DIFFERENTLY-NAMED streets as an
  intersection. The label is the two street "cores" (e.g. "North 2nd Street" +
  "Arch Street" -> "2nd & Arch").

  Usage:  powershell -ExecutionPolicy Bypass -File tools\generate_intersections.ps1
  Edit $bbox below to change coverage (south,west,north,east).
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

# south,west,north,east  -- default covers Center City + South Philly, Fairmount,
# Northern Liberties/Fishtown, and near University City.
$bbox = '39.905,-75.25,39.985,-75.12'

$outPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'intersections.json'

$ql = @"
[out:json][timeout:180];
way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street)$"]["name"]($bbox);
(._;>;);
out qt;
"@

Write-Host "Querying Overpass (this can take 30-90s)..."
$resp = Invoke-WebRequest -Uri 'https://overpass-api.de/api/interpreter' `
    -Method Post -Body @{ data = $ql } -UseBasicParsing -TimeoutSec 180 `
    -Headers @{ 'User-Agent' = 'philly-nbhd-game/1.0 (mg.gaida@gmail.com)'; 'Accept' = 'application/json' }
$raw = $resp.Content

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
