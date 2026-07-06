<#
  Adds a `weight`, `hood` (containing official neighborhood) and `edge_m`
  (metres to that neighborhood's nearest boundary) to every intersection, using
  the OpenDataPhilly neighborhoods polygons. The game then samples corners
  weighted toward neighborhood boundaries (contested areas) instead of uniformly.

  Weight model (moderate bias):   w = 0.15 + exp(-edge_m / 250)
    - a corner right on a border  (edge_m ~ 20)  -> ~1.07
    - deep in a big neighborhood  (edge_m ~ 900) -> ~0.16
  So boundaries come up ~6-7x more often than interiors, but nothing is excluded.

  Usage:  powershell -ExecutionPolicy Bypass -File tools\weight_intersections.ps1
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

$root     = Split-Path $PSScriptRoot -Parent
$geoPath  = Join-Path $PSScriptRoot 'philadelphia-neighborhoods.geojson'
$intPath  = Join-Path $root 'intersections.json'

$js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$js.MaxJsonLength = [int]::MaxValue

Write-Host "Loading neighborhoods + intersections..."
$geo = $js.DeserializeObject([IO.File]::ReadAllText($geoPath))
$ints = $js.DeserializeObject([IO.File]::ReadAllText($intPath))

# ---- pre-process polygons into fast typed arrays --------------------------
# Each feature -> @{ name; minx;miny;maxx;maxy; polys = @( @{ ox;oy; holes=@(@{x;y}) } ) }
function New-Ring($coords) {
    $n = $coords.Count
    $x = New-Object 'double[]' $n
    $y = New-Object 'double[]' $n
    for ($i = 0; $i -lt $n; $i++) { $x[$i] = [double]$coords[$i][0]; $y[$i] = [double]$coords[$i][1] }
    return @{ x = $x; y = $y }
}

$features = New-Object System.Collections.ArrayList
foreach ($f in $geo['features']) {
    $name = [string]$f['properties']['LISTNAME']
    $g = $f['geometry']
    if (-not $g) { continue }
    $type = [string]$g['type']
    # NB: plain assignment (not `if(){}else{}`) so a single-element array isn't unrolled a level.
    $polygons = $g['coordinates']
    if ($type -eq 'Polygon') { $polygons = , $g['coordinates'] }

    $polys = New-Object System.Collections.ArrayList
    $minx = 1e9; $miny = 1e9; $maxx = -1e9; $maxy = -1e9
    foreach ($poly in $polygons) {
        $outer = New-Ring $poly[0]
        for ($i = 0; $i -lt $outer.x.Length; $i++) {
            if ($outer.x[$i] -lt $minx) { $minx = $outer.x[$i] }
            if ($outer.x[$i] -gt $maxx) { $maxx = $outer.x[$i] }
            if ($outer.y[$i] -lt $miny) { $miny = $outer.y[$i] }
            if ($outer.y[$i] -gt $maxy) { $maxy = $outer.y[$i] }
        }
        $holes = New-Object System.Collections.ArrayList
        for ($h = 1; $h -lt $poly.Count; $h++) { [void]$holes.Add((New-Ring $poly[$h])) }
        [void]$polys.Add(@{ o = $outer; holes = $holes })
    }
    [void]$features.Add(@{ name = $name; minx = $minx; miny = $miny; maxx = $maxx; maxy = $maxy; polys = $polys })
}
Write-Host ("Prepared {0} neighborhood features." -f $features.Count)

function In-Ring([double]$px, [double]$py, $ring) {
    $x = $ring.x; $y = $ring.y; $n = $x.Length
    $inside = $false; $j = $n - 1
    for ($i = 0; $i -lt $n; $i++) {
        if ((($y[$i] -gt $py) -ne ($y[$j] -gt $py)) -and
            ($px -lt ($x[$j] - $x[$i]) * ($py - $y[$i]) / ($y[$j] - $y[$i]) + $x[$i])) {
            $inside = -not $inside
        }
        $j = $i
    }
    return $inside
}

function In-Feature([double]$px, [double]$py, $feat) {
    if ($px -lt $feat.minx -or $px -gt $feat.maxx -or $py -lt $feat.miny -or $py -gt $feat.maxy) { return $false }
    foreach ($poly in $feat.polys) {
        if (In-Ring $px $py $poly.o) {
            $inHole = $false
            foreach ($hole in $poly.holes) { if (In-Ring $px $py $hole) { $inHole = $true; break } }
            if (-not $inHole) { return $true }
        }
    }
    return $false
}

# metres to the nearest boundary segment of a feature (equirectangular approx)
function Edge-Metres([double]$px, [double]$py, $feat) {
    $latR = $py * [math]::PI / 180.0
    $mx = 111320.0 * [math]::Cos($latR)
    $my = 110540.0
    $best = [double]::MaxValue
    foreach ($poly in $feat.polys) {
        $rings = @($poly.o) + @($poly.holes)
        foreach ($ring in $rings) {
            $x = $ring.x; $y = $ring.y; $n = $x.Length
            for ($i = 0; $i -lt $n - 1; $i++) {
                $ax = ($x[$i]   - $px) * $mx; $ay = ($y[$i]   - $py) * $my
                $bx = ($x[$i+1] - $px) * $mx; $by = ($y[$i+1] - $py) * $my
                $dx = $bx - $ax; $dy = $by - $ay
                $len2 = $dx * $dx + $dy * $dy
                if ($len2 -eq 0) { $cx = $ax; $cy = $ay }
                else {
                    $t = -($ax * $dx + $ay * $dy) / $len2
                    if ($t -lt 0) { $t = 0 } elseif ($t -gt 1) { $t = 1 }
                    $cx = $ax + $t * $dx; $cy = $ay + $t * $dy
                }
                $d = $cx * $cx + $cy * $cy
                if ($d -lt $best) { $best = $d }
            }
        }
    }
    return [math]::Sqrt($best)
}

Write-Host ("Assigning {0} intersections..." -f $ints.Count)
$out = New-Object System.Collections.ArrayList
$i = 0
foreach ($d in $ints) {
    $px = [double]$d['lng']; $py = [double]$d['lat']
    $hood = ''; $container = $null
    foreach ($feat in $features) {
        if (In-Feature $px $py $feat) { $hood = $feat.name; $container = $feat; break }
    }
    if ($container) {
        $edge = Edge-Metres $px $py $container
        $w = [math]::Round(0.15 + [math]::Exp(-$edge / 250.0), 4)
        $edgeOut = [math]::Round($edge, 0)
    } else {
        # Not inside any official neighborhood (river/park/industrial/airport):
        # genuinely ambiguous, so show it rarely.
        $w = 0.05
        $edgeOut = -1
    }
    [void]$out.Add([pscustomobject]@{
        name = [string]$d['name']; lat = [double]$d['lat']; lng = [double]$d['lng']
        hood = $hood; edge_m = $edgeOut; weight = $w
    })
    $i++
    if ($i % 1500 -eq 0) { Write-Host ("  {0}/{1}" -f $i, $ints.Count) }
}

$json = $out | ConvertTo-Json -Depth 4
Set-Content -Path $intPath -Value $json -Encoding UTF8
Set-Content -Path (Join-Path $root 'intersections.js') -Value ("window.INTERSECTIONS = " + $json + ";") -Encoding UTF8

$assigned = ($out | Where-Object { $_.hood -ne '' }).Count
Write-Host ("Done. {0}/{1} placed in a neighborhood." -f $assigned, $out.Count)
Write-Host ("weight range: {0} .. {1}" -f ($out.weight | Measure-Object -Minimum).Minimum, ($out.weight | Measure-Object -Maximum).Maximum)
