# Sends a push to the user's phone through ntfy.sh. Job details only, never resume or personal data.
# The topic is a random secret saved DPAPI encrypted (readable only by this Windows user on this machine)
# at secrets\ntfy-topic.dat (create it with tools\save-secret.ps1 or any password manager). It is never printed or put on a command line.
#
#   notify.ps1 -Test                                  send a test push
#   notify.ps1 -Title "..." -Message "..." [-Priority 3] [-Click url]   send any push
#   notify.ps1 -Daily                                 top 5 new jobs from output\jobs-latest.json, or "No new matches today"
#   add -DryRun to any of these to print the payload without sending (topic is not read)
param(
    [switch]$Test,
    [switch]$Daily,
    [switch]$DryRun,
    [string]$Title,
    [string]$Message,
    [ValidateRange(1,5)][int]$Priority = 3,
    [string]$Click,
    [string]$Tags,
    [string]$JobsFile = (Join-Path $PSScriptRoot 'output\jobs-latest.json'),
    [string]$TopicFile = (Join-Path $PSScriptRoot 'secrets\ntfy-topic.dat')
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)

function Format-Pay($p) {
    if (-not $p -or -not $p.min) { return 'pay not listed' }
    $lo = [math]::Round($p.min / 1000); $hi = [math]::Round($p.max / 1000)
    if ($hi -ne $lo) { return "`$${lo}k-`$${hi}k" } else { return "`$${lo}k" }
}

if ($Test) {
    $Title = 'Job Hunter test'
    $Message = "Test push from $env:COMPUTERNAME at $(Get-Date -Format 'h:mm tt'). If you see this, daily pushes will work."
    $Tags = 'white_check_mark'
}
elseif ($Daily) {
    $Tags = 'briefcase'
    $fit = @{ 'Good fit' = 0; 'Stretch' = 1; 'Reach' = 2 }
    $cat = @{ 'cyber' = 0; 'systems' = 1; 'it_support' = 2 }
    $stale = $true; $new = @()
    if (Test-Path $JobsFile) {
        $r = [IO.File]::ReadAllText($JobsFile, $utf8) | ConvertFrom-Json
        $stale = ($r.date -ne (Get-Date -Format 'yyyy-MM-dd'))
        $new = @($r.jobs | Where-Object { $_.isNew -and $_.fit -ne 'Reach' })  # Reach jobs never go in the push
    }
    if ($stale) {
        $Title = 'Job Hunter: feed did not run today'
        $Message = 'No fresh jobs file for today. Check logs\feed.log.'
        $Priority = 4; $Tags = 'warning'
    }
    elseif (-not $new.Count) {
        $Title = 'Job Hunter'
        $Message = 'No new matches today'
    }
    else {
        # Good fit first, then Stretch, then Reach. Within a label: higher local score first (if score-local.ps1 ran today),
        # then the feed order (remote, hybrid, on site).
        $sc = @{}
        $scoresFile = Join-Path (Split-Path $JobsFile) 'scores-latest.json'
        if (Test-Path $scoresFile) {
            $s = [IO.File]::ReadAllText($scoresFile, $utf8) | ConvertFrom-Json
            if ($s.date -eq $r.date) { $s.scores.PSObject.Properties | ForEach-Object { if ($null -ne $_.Value.score) { $sc[$_.Name] = [int]$_.Value.score } } }
        }
        $i = 0
        $top = @($new | ForEach-Object { [pscustomobject]@{ i = $i++; j = $_; s = $(if ($sc.ContainsKey($_.id)) { $sc[$_.id] } else { 0 }) } } |
            Sort-Object { $fit[$_.j.fit] }, { $cat[$_.j.category] }, { -[int][bool]$_.j.bilingual }, { -$_.s }, i | Select-Object -First 5 | ForEach-Object { $_.j })
        $Title = "Job Hunter: top $($top.Count) of $($new.Count) new"
        $Message = ($top | ForEach-Object { "$($_.company) | $($_.title) | $(Format-Pay $_.pay) | $($_.fit)`n$($_.url)" }) -join "`n`n"
    }
}
if (-not $Title -or -not $Message) { throw 'Give -Test, -Daily, or both -Title and -Message.' }

$payload = @{ topic = 'TOPIC'; title = $Title; message = $Message; priority = $Priority }
if ($Tags)  { $payload.tags = @($Tags -split ',') }
if ($Click) { $payload.click = $Click }

if ($DryRun) {
    ($payload | ConvertTo-Json -Depth 4)
    Write-Output '(dry run: nothing sent)'
    return
}

if (-not (Test-Path $TopicFile)) { throw "No topic file at $TopicFile. Create it with: tools\save-secret.ps1 -Path secrets\ntfy-topic.dat -Generate -Show" }
$sec = (Get-Content -LiteralPath $TopicFile -Raw).Trim() | ConvertTo-SecureString
$payload.topic = [Net.NetworkCredential]::new('', $sec).Password
$body = $utf8.GetBytes(($payload | ConvertTo-Json -Depth 4))
try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri 'https://ntfy.sh' -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 30
    Write-Output "sent: $Title"
} catch {
    $msg = ($_.Exception.Message -replace [regex]::Escape($payload.topic), '***')
    Write-Output "FAILED: $msg"
    exit 1
} finally { $payload.topic = $null; $sec = $null }
