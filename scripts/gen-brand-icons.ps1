# Genera el logo y los iconos PWA de Art & Magic a partir de Art-Logo.jpeg.
#
# El logo original es un JPEG (sin canal alfa) con la marca dorada sobre negro.
# Aca se "des-compone" ese fondo: alpha = valor del pixel y el color se
# des-premultiplica, asi el dorado queda a full sobre cualquier fondo y los
# bordes anti-aliased no se ven sucios. Despues recorta el margen vacio y dibuja
# la marca centrada sobre negro para cada tamano de icono.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts/gen-brand-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'Art-Logo.jpeg'
$out = Join-Path $root 'public'

$src = [System.Drawing.Image]::FromFile($srcPath)
$w = $src.Width; $h = $src.Height
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $w, $h); $g.Dispose(); $src.Dispose()

$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$len = $data.Stride * $h
$px = New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $len)

# BGRA. minX/maxX/... acumulan el bounding box de lo que no es fondo.
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $data.Stride
  for ($x = 0; $x -lt $w; $x++) {
    $i = $row + $x * 4
    $b = [int]$px[$i]; $gr = [int]$px[$i + 1]; $r = [int]$px[$i + 2]
    $v = [Math]::Max($r, [Math]::Max($gr, $b))
    if ($v -lt 12) {
      $px[$i] = 0; $px[$i + 1] = 0; $px[$i + 2] = 0; $px[$i + 3] = 0
    } else {
      $px[$i]     = [byte][Math]::Min(255, [int](($b  * 255) / $v))
      $px[$i + 1] = [byte][Math]::Min(255, [int](($gr * 255) / $v))
      $px[$i + 2] = [byte][Math]::Min(255, [int](($r  * 255) / $v))
      $px[$i + 3] = [byte]$v
      if ($v -gt 40) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
}
[System.Runtime.InteropServices.Marshal]::Copy($px, 0, $data.Scan0, $len)
$bmp.UnlockBits($data)

# Recorte al contenido (con 2px de aire para no comerse el anti-aliasing)
$pad = 2
$minX = [Math]::Max(0, $minX - $pad); $minY = [Math]::Max(0, $minY - $pad)
$maxX = [Math]::Min($w - 1, $maxX + $pad); $maxY = [Math]::Min($h - 1, $maxY + $pad)
$cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle($minX, $minY, $cw, $ch)), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bmp.Dispose()
Write-Output ("logo recortado: {0}x{1} (de {2}x{3})" -f $cw, $ch, $w, $h)

# logo.png a 2x para que se vea nitido en la placa de 160px de la landing
$logoW = $cw * 2; $logoH = $ch * 2
$logo = New-Object System.Drawing.Bitmap($logoW, $logoH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$lg = [System.Drawing.Graphics]::FromImage($logo)
$lg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$lg.DrawImage($crop, 0, 0, $logoW, $logoH); $lg.Dispose()
$logo.Save((Join-Path $out 'logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$logo.Dispose()

function Save-Icon([int]$size, [double]$scale, [string]$name, [bool]$mono) {
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $cg = [System.Drawing.Graphics]::FromImage($canvas)
  $cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  if (-not $mono) { $cg.Clear([System.Drawing.Color]::FromArgb(255, 8, 8, 8)) }
  $box = $size * $scale
  $ratio = [Math]::Min($box / $script:cropW, $box / $script:cropH)
  $dw = $script:cropW * $ratio; $dh = $script:cropH * $ratio
  $cg.DrawImage($script:crop, ($size - $dw) / 2, ($size - $dh) / 2, $dw, $dh)
  $cg.Dispose()
  if ($mono) {
    # El badge de Android se pinta como silueta: todo blanco, solo importa el alfa.
    $r2 = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $d2 = $canvas.LockBits($r2, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $l2 = $d2.Stride * $size
    $p2 = New-Object byte[] $l2
    [System.Runtime.InteropServices.Marshal]::Copy($d2.Scan0, $p2, 0, $l2)
    for ($i = 0; $i -lt $l2; $i += 4) {
      if ($p2[$i + 3] -gt 0) { $p2[$i] = 255; $p2[$i + 1] = 255; $p2[$i + 2] = 255 }
    }
    [System.Runtime.InteropServices.Marshal]::Copy($p2, 0, $d2.Scan0, $l2)
    $canvas.UnlockBits($d2)
  }
  $canvas.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
  Write-Output ("  {0} ({1}px)" -f $name, $size)
}

$script:crop = $crop; $script:cropW = $cw; $script:cropH = $ch
Save-Icon 192 0.80 'icon-192.png' $false
Save-Icon 512 0.80 'icon-512.png' $false
Save-Icon 512 0.58 'icon-maskable-512.png' $false   # padding para la safe zone
Save-Icon 180 0.78 'apple-touch-icon.png' $false
Save-Icon 96  0.90 'badge.png' $true
$crop.Dispose()
Write-Output "listo"
