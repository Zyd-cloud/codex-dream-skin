# Codex Dream Skin injector supervisor for magpie.
# Run by magpie's plugin host at load time; keeps the injector alive.
#
# The full chain the skin needs is:
#   1. Codex running WITH --remote-debugging-port=9335
#   2. the injector running in watch mode against that browser id
#
# Step 1 goes through launch-codex.ps1, which activates the app through its
# packaged identity (IApplicationActivationManager does forward the arguments).
# That matters beyond bookkeeping: an activation carries an AppUserModelID, so
# the taskbar draws the app's registered logo. Running ChatGPT.exe directly
# produces a bare process, and Windows falls back to the icon embedded in the
# executable -- same app, visibly different taskbar icon.
#
# It is deliberately quiet on the common path: when the injector is already
# running it exits immediately, so a 60s keepalive tick costs one process check.

param(
  # The CDP port to keep alive. The plugin passes its own value so the number is
  # defined in one place; the default matches it for a manual run.
  [int]$Port = 9335,
  [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'CodexDreamSkin')
)

$ErrorActionPreference = 'Stop'

$root = $StateRoot
$stateFile = Join-Path $root 'state.json'
$injector = Join-Path $root 'engine\scripts\injector.mjs'
$activeTheme = Join-Path $root 'active-theme'
$pauseFile = Join-Path $root 'paused'
$logFile = Join-Path $root 'plugin-autostart.log'
$port = $Port

# How long to wait before relaunching a Codex that is running without CDP.
# Relaunching closes the user's windows, so it must not happen on every tick.
$relaunchCooldownFile = Join-Path $root 'plugin-relaunch-cooldown.txt'
$relaunchCooldownMinutes = 10

function Write-Log {
  param([string]$Message)
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -LiteralPath $logFile -Value "$stamp $Message" -ErrorAction Stop
  } catch {}
}

function Get-State {
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-InjectorProcess {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*injector.mjs*' }
  return $procs
}

function Test-InjectorRunning {
  # state.json first (cheap), then the process list as a fallback for a stale
  # or missing state file.
  $state = Get-State
  if ($state -and $state.injectorPid) {
    $proc = Get-Process -Id $state.injectorPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { return $true }
  }
  return [bool](Get-InjectorProcess)
}

# The injector is pinned to one browser id with --browser-id. Codex mints a new
# one on every launch, so a surviving injector can end up watching a browser
# that no longer exists. Its own re-anchor path handles that, but it can also
# wedge on a half-open WebSocket to the dead browser; checking here is cheap and
# makes recovery certain rather than best-effort.
function Test-InjectorIdentityCurrent {
  $procs = Get-InjectorProcess
  if (-not $procs) { return $false }
  $expected = $null
  try { $expected = Get-BrowserId } catch { return $false }
  if (-not $expected) { return $false }
  foreach ($proc in $procs) {
    $match = [regex]::Match($proc.CommandLine, '--browser-id\s+([0-9a-fA-F-]{36})')
    if (-not $match.Success) { continue }
    if ($match.Groups[1].Value -ieq $expected) { return $true }
  }
  return $false
}

function Stop-Injector {
  foreach ($proc in (Get-InjectorProcess)) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 500
}

function Test-CodexWithCdp {
  $main = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*remote-debugging-port=$port*" }
  return [bool]$main
}

function Test-PortUp {
  try {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  } catch { return $false }
}

function Get-BrowserId {
  # Only a live endpoint counts. Falling back to the id saved in state.json
  # used to start an injector pinned to a browser that was already gone, which
  # then watched nothing and had to be replaced on the next tick.
  if (-not (Test-PortUp)) { return $null }
  try {
    $response = Invoke-WebRequest "http://127.0.0.1:$port/json/version" -TimeoutSec 3 -UseBasicParsing
    $json = $response.Content | ConvertFrom-Json
    if ($json.webSocketDebuggerUrl) {
      $match = [regex]::Match($json.webSocketDebuggerUrl, '/browser/([0-9a-fA-F-]{36})$')
      if ($match.Success) { return $match.Groups[1].Value }
    }
  } catch {
    return $null
  }
  return $null
}

function Get-CodexExe {
  $state = Get-State
  if ($state -and $state.codexExe -and (Test-Path -LiteralPath $state.codexExe -PathType Leaf)) {
    return $state.codexExe
  }
  $candidates = Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue
  foreach ($candidate in $candidates) {
    $exe = Join-Path $candidate.FullName 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  }
  return $null
}

function Resolve-Node {
  $state = Get-State
  if ($state -and $state.nodePath -and (Test-Path -LiteralPath $state.nodePath -PathType Leaf)) {
    return $state.nodePath
  }
  foreach ($candidate in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  try { & node --version *> $null; if ($LASTEXITCODE -eq 0) { return 'node' } } catch {}
  return $null
}

function Update-StatePid {
  param([int]$ProcessId)
  # Schema 3 requires injectorPid and injectorStartedAt, so patch them in place
  # rather than rewriting the file. Written without a BOM: the engine's reader
  # is strict about it.
  try {
    $state = Get-State
    if (-not $state) { return }
    $state.injectorPid = $ProcessId
    $state.injectorStartedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')
    $text = $state | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($stateFile, $text, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Log "could not update state.json: $($_.Exception.Message)"
  }
}

function Test-RelaunchCooling {
  if (-not (Test-Path -LiteralPath $relaunchCooldownFile -PathType Leaf)) { return $false }
  try {
    $last = [datetime]::Parse((Get-Content -LiteralPath $relaunchCooldownFile -Raw).Trim())
    return ((Get-Date) - $last).TotalMinutes -lt $relaunchCooldownMinutes
  } catch { return $false }
}

function Set-RelaunchCooldown {
  try {
    [System.IO.File]::WriteAllText($relaunchCooldownFile,
      (Get-Date).ToString('o'), (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# --- the actual work -------------------------------------------------------

# Two ticks (the plugin's keepalive and a manual run) can overlap, and both
# would then start an injector. A named mutex makes the whole body exclusive.
$mutexName = 'Local\CodexDreamSkinEnsureInjector'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) { exit 0 }
try {

if ((Test-InjectorRunning) -and (Test-InjectorIdentityCurrent)) { exit 0 }

if (-not (Test-Path -LiteralPath $injector -PathType Leaf)) {
  Write-Log "injector not installed at $injector"
  exit 0
}

# Step 1: Codex must be running with a CDP endpoint.
#
# Launching Codex the instant a tick noticed it was gone raced with the user's
# own click and produced a double start, which looked like the app flashing
# closed and open. Launching never, on the other hand, left Codex down for good
# after one of those unexplained exits ("disappears and does not come back").
#
# The compromise: only launch once Codex has been continuously absent for a
# while, so a user who is about to click is never raced, and one who already
# clicked and got nothing still gets a working Codex.
$absentSinceFile = Join-Path $root 'codex-absent-since.txt'
$relaunchAfterSeconds = 90

if (-not (Test-PortUp)) {
  $now = Get-Date
  $absentSince = $null
  if (Test-Path -LiteralPath $absentSinceFile -PathType Leaf) {
    try { $absentSince = [datetime]::Parse((Get-Content -LiteralPath $absentSinceFile -Raw).Trim()) } catch { $absentSince = $null }
  }
  if (-not $absentSince) {
    try {
      [System.IO.File]::WriteAllText($absentSinceFile, $now.ToString('o'), (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    Write-Log "no CDP endpoint on port $port; waiting for Codex to be started from the shortcut"
    exit 0
  }

  $absentFor = ($now - $absentSince).TotalSeconds
  if ($absentFor -lt $relaunchAfterSeconds) {
    Write-Log ("no CDP endpoint on port {0}; absent {1:n0}s, will relaunch at {2}s" -f $port, $absentFor, $relaunchAfterSeconds)
    exit 0
  }

  # Long enough absent: bring Codex back, with the CDP flag the skin needs.
  try { Remove-Item -LiteralPath $absentSinceFile -Force -ErrorAction SilentlyContinue } catch {}
  $exe = Get-CodexExe
  if (-not $exe) {
    Write-Log "Codex executable not found"
    exit 0
  }
  try {
    # Go through the launcher rather than Start-Process: it activates the app
    # through its package identity, which is what keeps the taskbar showing the
    # app's own logo instead of the icon embedded in ChatGPT.exe.
    $launcher = Join-Path $root 'launch-codex.ps1'
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
      & $launcher -Port $port
      Write-Log "Codex had been absent for $([math]::Round($absentFor))s; launched it through the launcher on port $port"
    } else {
      Start-Process -FilePath $exe -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$port")
      Write-Log "Codex had been absent for $([math]::Round($absentFor))s; launched it with CDP on port $port (no launcher available)"
    }
  } catch {
    Write-Log "failed to launch Codex: $($_.Exception.Message)"
    exit 0
  }

  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-PortUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-PortUp)) {
    Write-Log "Codex did not expose CDP on port $port within 45s"
    exit 0
  }
} else {
  # Codex is up: forget any absence timer.
  if (Test-Path -LiteralPath $absentSinceFile -PathType Leaf) {
    try { Remove-Item -LiteralPath $absentSinceFile -Force -ErrorAction SilentlyContinue } catch {}
  }
}

# An injector left over from a previous Codex is worse than none: it holds the
# old browser id and never injects. Replace it rather than leave it wedged.
if ((Test-InjectorRunning) -and -not (Test-InjectorIdentityCurrent)) {
  Write-Log "injector is watching a stale browser identity; replacing it"
  Stop-Injector
}

# Step 2: start the injector against that browser id.
$browserId = Get-BrowserId
if (-not $browserId) {
  Write-Log "no CDP browser id available yet; waiting for the next tick"
  exit 0
}

$node = Resolve-Node
if (-not $node) {
  Write-Log "node.exe not found; cannot start the injector"
  exit 0
}

$injectorLog = Join-Path $root 'injector-runtime.log'
$injectorErrLog = Join-Path $root 'injector-runtime.log.err'

# Start-Process -RedirectStandardOutput truncates, so a crashed injector's stack
# trace was being lost the moment the next one started. Archive the previous
# pair first: one file per injector run.
foreach ($old in @($injectorLog, $injectorErrLog)) {
  if (Test-Path -LiteralPath $old -PathType Leaf) {
    $size = (Get-Item -LiteralPath $old).Length
    if ($size -gt 0) {
      $archive = "$old." + (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
      try { Move-Item -LiteralPath $old -Destination $archive -Force -ErrorAction Stop } catch {}
    } else {
      try { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

$args = @($injector, '--watch', '--port', "$port", '--browser-id', $browserId,
          '--theme-dir', $activeTheme, '--pause-file', $pauseFile)

try {
  # Redirect stdout/stderr so a wedged or crashing watcher can be diagnosed
  # from the log instead of having its output discarded.
  if ($node -eq 'node') {
    Start-Process -FilePath 'node' -ArgumentList $args -WindowStyle Hidden `
      -RedirectStandardOutput $injectorLog -RedirectStandardError $injectorErrLog
  } else {
    Start-Process -FilePath $node -ArgumentList $args -WindowStyle Hidden `
      -RedirectStandardOutput $injectorLog -RedirectStandardError $injectorErrLog
  }
  Write-Log "started injector (node=$node browserId=$browserId)"
  Start-Sleep -Seconds 3
  $procs = Get-InjectorProcess
  if ($procs) { Update-StatePid -ProcessId $procs[0].ProcessId }
} catch {
  Write-Log "failed to start injector: $($_.Exception.Message)"
}

} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
