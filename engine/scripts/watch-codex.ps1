# Codex lifecycle watcher for the Dream Skin setup.
#
# "Codex opens then disappears and does not come back" could not be reproduced
# on demand, and every usual suspect was ruled out: no crash dumps, no Windows
# application-error events, no second launcher, no port conflict, no Codex++
# takeover. This watcher records the Codex process lifecycle so the next
# occurrence leaves evidence instead of being guessed at.
#
# It runs its own loop rather than being re-spawned every second: a fresh
# PowerShell per tick costs several WMI queries and is itself a source of churn.
# One line is appended per state change, so a quiet system writes nothing.

param(
  [int]$IntervalMs = 1000,
  # Default 6 hours; the plugin host starts it once and it outlives many Codex
  # sessions. Pass -DurationMinutes 0 to run until stopped.
  [int]$DurationMinutes = 360,
  # Same CDP port the plugin decided; the default matches it for a manual run.
  [int]$Port = 9335
)

$ErrorActionPreference = 'Continue'

$root = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
$watchLog = Join-Path $root 'codex-watch.log'
$stateFile = Join-Path $root 'codex-watch-state.json'
$pluginLog = Join-Path $root 'plugin-autostart.log'
$injectorLog = Join-Path $root 'injector-runtime.log.err'

# Only one watcher at a time.
$mutex = New-Object System.Threading.Mutex($false, 'Local\CodexDreamSkinWatchCodex')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit }

function Get-Snapshot {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
  $withCdp = @($procs | Where-Object { $_.CommandLine -like '*remote-debugging-port*' })
  $injectors = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*injector.mjs*' })
  $listening = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $main = @($withCdp | Sort-Object CreationDate | Select-Object -First 1)

  $browserId = '-'
  if ($injectors.Count) {
    $m = [regex]::Match($injectors[0].CommandLine, '--browser-id\s+([0-9a-fA-F-]{36})')
    if ($m.Success) { $browserId = $m.Groups[1].Value }
  }

  [pscustomobject]@{
    count     = $procs.Count
    main      = if ($main.Count) { "$($main[0].ProcessId)" } else { '-' }
    cdp       = if ($listening.Count) { 'up' } else { 'down' }
    injectors = $injectors.Count
    browserId = $browserId
  }
}

function Read-LastState {
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { return $null }
}

# This loop can run for days, so the log has to be bounded: it grew without
# limit before, and there is no one watching a 40 MB transition log.
$script:logBytes = -1
$script:logMaxBytes = 512 * 1024
$script:logKeepLines = 300

function Write-Line {
  param([string]$Text)
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')
    $line = "$stamp $Text"
    if ($script:logBytes -lt 0) {
      try { $script:logBytes = (Get-Item -LiteralPath $watchLog -ErrorAction Stop).Length } catch { $script:logBytes = 0 }
    }
    Add-Content -LiteralPath $watchLog -Value $line -ErrorAction Stop
    $script:logBytes += [System.Text.Encoding]::UTF8.GetByteCount($line) + 2
    if ($script:logBytes -gt $script:logMaxBytes) {
      $tail = Get-Content -LiteralPath $watchLog -ErrorAction Stop |
        Where-Object { $_ } | Select-Object -Last $script:logKeepLines
      Set-Content -LiteralPath $watchLog -Value $tail -Encoding UTF8 -ErrorAction Stop
      $script:logBytes = (Get-Item -LiteralPath $watchLog -ErrorAction Stop).Length
    }
  } catch {}
}

try {
  $deadline = if ($DurationMinutes -gt 0) { (Get-Date).AddMinutes($DurationMinutes) } else { [datetime]::MaxValue }
  $last = Read-LastState

  while ((Get-Date) -lt $deadline) {
    $now = Get-Snapshot

    $changed = $false
    if (-not $last) {
      $changed = $true
    } elseif ("$($last.count)" -ne "$($now.count)" -or "$($last.main)" -ne "$($now.main)") {
      $changed = $true
    }

    if ($changed) {
      $kind = if ($now.count -eq 0) { 'down' } else { 'up' }
      Write-Line ("{0} count={1} main={2} cdp={3} inj={4} browserId={5}" -f `
        $kind, $now.count, $now.main, $now.cdp, $now.injectors, $now.browserId)

      # When Codex vanishes, capture what everything else was doing. 30 lines
      # because a Node crash dump is mostly stack trace and the error message
      # is at the TOP.
      if ($now.count -eq 0 -and $last -and "$($last.count)" -gt 0) {
        Write-Line ("context: Codex went from {0} processes to none (was main={1} cdp={2})" -f `
          $last.count, $last.main, $last.cdp)
        foreach ($file in @($pluginLog, $injectorLog)) {
          if (Test-Path -LiteralPath $file) {
            foreach ($line in (Get-Content -LiteralPath $file -Tail 30 -ErrorAction SilentlyContinue)) {
              Write-Line ("context {0}: {1}" -f (Split-Path $file -Leaf), $line)
            }
          }
        }
      }

      try {
        $now | ConvertTo-Json -Compress |
          Set-Content -LiteralPath $stateFile -Encoding UTF8 -ErrorAction SilentlyContinue
      } catch {}
      $last = $now
    }

    Start-Sleep -Milliseconds $IntervalMs
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
