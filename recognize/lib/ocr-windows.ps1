# Windows.Media.Ocr helper -- uses the OCR engine built into Windows.
#
# IMPORTANT: this file is deliberately pure ASCII (no non-ASCII characters).
# Reason: git's `* text=auto eol=lf` in .gitattributes normalises line endings
# and can strip a UTF-8 BOM on checkout. Windows PowerShell 5.1 then reads the
# file as ANSI and breaks on any non-ASCII string literal, producing bizarre
# "Unexpected token" parse errors. Keeping the script ASCII makes it immune to
# the BOM question entirely. Chinese documentation lives in README.md instead.
#
# Usage:
#   powershell -File ocr-windows.ps1 -ImagePath <png> [-Lang zh-Hans-CN] [-Json]
#
# Output:
#   -Json   -> one line of JSON: { engine, width, height, words[], lines[] }
#              each entry has text plus its bounding box (x, y, w, h)
#   default -> human readable "[x,y wxh] text" list
param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [string]$Lang = "zh-Hans-CN",
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ImagePath)) { throw "image not found: $ImagePath" }

# System.Runtime.WindowsRuntime provides the AsTask extension methods.
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

$null = [Windows.Media.Ocr.OcrEngine,            Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,            Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,         Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode,         Windows.Foundation, ContentType=WindowsRuntime]

# Pick the AsTask overload that takes exactly one IAsyncOperation`1 parameter.
# The generic type name contains a backtick; build it with [char]96 so the
# parser never sees it as an escape character.
$bt = [char]96
$iasyncOpenName = 'IAsyncOperation' + $bt + '1'
$asTaskGeneric = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq $iasyncOpenName
})
if ($asTaskGeneric.Count -eq 0) { throw "AsTask(IAsyncOperation<T>) overload not found" }

function Await($op, $resultType) {
    $task = $asTaskGeneric[0].MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    if ($task.IsFaulted) { throw $task.Exception.InnerException }
    return $task.Result
}

# Prefer the requested language, fall back to whatever the profile offers.
$engine = $null
try {
    $language = New-Object Windows.Globalization.Language($Lang)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
} catch { }
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) { throw "cannot create OCR engine (language '$Lang' unavailable)" }

$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))        ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync())                              ([Windows.Graphics.Imaging.SoftwareBitmap])

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$words = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
    foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        [void]$words.Add([pscustomobject]@{
            text = $word.Text
            x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
        })
    }
}

$lines = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
    $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = 0; $maxY = 0
    foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        if ([int]$r.X -lt $minX) { $minX = [int]$r.X }
        if ([int]$r.Y -lt $minY) { $minY = [int]$r.Y }
        if (([int]$r.X + [int]$r.Width)  -gt $maxX) { $maxX = [int]$r.X + [int]$r.Width }
        if (([int]$r.Y + [int]$r.Height) -gt $maxY) { $maxY = [int]$r.Y + [int]$r.Height }
    }
    [void]$lines.Add([pscustomobject]@{
        text = (($line.Words | ForEach-Object { $_.Text }) -join '')
        x = $minX; y = $minY; w = ($maxX - $minX); h = ($maxY - $minY)
    })
}

$engineTag = $engine.RecognizerLanguage.LanguageTag
$pw = $bitmap.PixelWidth
$ph = $bitmap.PixelHeight

$bitmap.Dispose()
$stream.Dispose()

if ($Json) {
    [pscustomobject]@{
        engine = $engineTag
        width  = $pw
        height = $ph
        words  = @($words)
        lines  = @($lines)
    } | ConvertTo-Json -Depth 6 -Compress
} else {
    Write-Output ("engine: " + $engineTag + "   size: " + $pw + "x" + $ph)
    Write-Output ("lines: " + $lines.Count + "   words: " + $words.Count)
    Write-Output ""
    foreach ($l in $lines) {
        Write-Output ("[{0,5},{1,5} {2,4}x{3,-4}]  {4}" -f $l.x, $l.y, $l.w, $l.h, $l.text)
    }
}
