# LevelPlay Web: local static web server
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8765] [-NoBrowser]
# Serves the project folder at http://localhost:<Port>/ (this PC only) and opens the browser.
# Stop: close this window or press Ctrl+C.
# ASCII only (PowerShell 5.1 fails on UTF-8 without BOM).

param(
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path.TrimEnd('\') + '\'
$url = "http://localhost:$Port/"
$Host.UI.RawUI.WindowTitle = "LevelPlay server ($url)"

function Open-App {
    if (-not $NoBrowser) { Start-Process $url }
}

# Already running (e.g. double-clicked twice)? Just open the browser.
try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
        Write-Output "LevelPlay is already running at $url"
        Open-App
        exit 0
    }
} catch { }

$types = @{
    ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8";
    ".css" = "text/css; charset=utf-8"; ".json" = "application/json";
    ".webmanifest" = "application/manifest+json"; ".svg" = "image/svg+xml"; ".png" = "image/png";
    ".ico" = "image/x-icon"; ".mp3" = "audio/mpeg"; ".wav" = "audio/wav"; ".flac" = "audio/flac";
    ".m4a" = "audio/mp4"; ".ogg" = "audio/ogg"; ".opus" = "audio/ogg"; ".txt" = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
    $listener.Start()
} catch {
    Write-Output "ERROR: cannot start the server on port $Port."
    Write-Output "Another program may be using this port. Try: tools\serve.ps1 -Port 8766"
    Write-Output $_.Exception.Message
    Read-Host "Press Enter to close"
    exit 1
}

Write-Output "LevelPlay is running at $url"
Write-Output "Close this window (or press Ctrl+C) to stop the server."
Open-App

function Send-Response($ctx) {
    $req = $ctx.Request
    $res = $ctx.Response
    try {
        $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
        if ($rel -eq "") { $rel = "index.html" }
        $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
        if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $res.StatusCode = 404
            $bytes = [Text.Encoding]::UTF8.GetBytes("Not found")
            $res.ContentType = "text/plain; charset=utf-8"
        } else {
            $ext = [IO.Path]::GetExtension($full).ToLower()
            $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
            $res.Headers["Cache-Control"] = "no-cache"
            $bytes = [IO.File]::ReadAllBytes($full)
        }
        $res.ContentLength64 = $bytes.Length
        if ($req.HttpMethod -ne "HEAD") { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    } catch {
        # The browser may cancel a request midway. Ignore it and keep serving.
        try { $res.StatusCode = 500 } catch { }
    } finally {
        try { $res.Close() } catch { }
    }
}

try {
    while ($listener.IsListening) {
        # Wait in short steps so that Ctrl+C works on PowerShell 5.1
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
        try { $ctx = $task.GetAwaiter().GetResult() } catch { continue }
        Send-Response $ctx
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
