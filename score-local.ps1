# First pass scoring with the LOCAL model only (tools\local-worker.ps1 -Worker local). The resume and postings never leave this machine.
# Reads output\jobs-latest.json, scores each new job 0 to 100 against data\resume-soc.txt, writes
#   output\scores-latest.json   (job id -> score, reason)
#   output\top-for-claude-YYYY-MM-DD.md   (the top jobs for Claude to review, highest first)
#
#   score-local.ps1                 score today's new jobs (isNew), top 10 list
#   score-local.ps1 -All            score every job in the file
#   score-local.ps1 -Max 4          only score the first 4 (testing)
#   score-local.ps1 -JobsFile path  use another jobs file (scratch tests); descriptions are found next to it
param(
    [string]$JobsFile = (Join-Path $PSScriptRoot 'output\jobs-latest.json'),
    [string]$ResumeFile = (Join-Path $PSScriptRoot 'data\resume-soc.txt'),
    [string]$Worker = (Join-Path $PSScriptRoot 'tools\local-worker.ps1'),
    [int]$Top = 10,
    [int]$Max = 0,
    [switch]$All
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$root   = Split-Path (Split-Path (Resolve-Path $JobsFile))
$outDir = Split-Path (Resolve-Path $JobsFile)
$tmpDir = Join-Path $root 'data\tmp'
New-Item -ItemType Directory -Force $tmpDir | Out-Null
if (-not (Test-Path $ResumeFile)) { throw "Missing $ResumeFile (resume text, local only)." }
$resume = [IO.File]::ReadAllText($ResumeFile, $utf8)

$report = [IO.File]::ReadAllText((Resolve-Path $JobsFile), $utf8) | ConvertFrom-Json
$jobs = @($report.jobs | Where-Object { ($All -or $_.isNew) -and $_.fit -ne 'Reach' })  # Reach jobs are not scored or reviewed
if ($Max -gt 0) { $jobs = @($jobs | Select-Object -First $Max) }

$prompt = @'
You are screening a job posting for a candidate. Compare the RESUME to the JOB POSTING below.
Reply with ONLY one line of JSON and nothing else: {"score": <number 0 to 100>, "reason": "<at most 20 words>"}
Scoring: 80 to 100 = strong match for an entry level SOC or security analyst job he can realistically get. 60 to 79 = possible, some gaps. 40 to 59 = stretch. Under 40 = poor match (senior level, years or skills he lacks, or not a security or IT operations job).
Lower the score for: more than 3 years required, required certifications he does not list, a required degree he will not have yet, senior or lead titles, overnight shifts. Use only facts in the resume. Splunk is lab only.
'@

function Invoke-Local($inputFile, $outFile) {
    $o = & $Worker -Worker local -Prompt $prompt -InputFile $inputFile -OutFile $outFile 2>&1 | Out-String
    if ($o -match 'REFUSED|FAILED') { return @{ ok = $false; msg = ($o.Trim() -split "`n")[0] } }
    return @{ ok = $true }
}

$scores = [ordered]@{}
$n = 0
foreach ($j in $jobs) {
    $n++
    $desc = ''
    if ($j.descriptionFile) {
        $f = Join-Path $root $j.descriptionFile
        if (Test-Path $f) { $desc = [IO.File]::ReadAllText($f, $utf8) }
    }
    if (-not $desc) { $desc = "$($j.title) at $($j.company). Location: $($j.location). Pay: $($j.pay.text). No full description was available." }
    $budget = 19000 - $prompt.Length - $resume.Length - 200
    if ($desc.Length -gt $budget) { $desc = $desc.Substring(0, $budget) }
    $inFile = Join-Path $tmpDir 'score-input.txt'
    $outFile = Join-Path $tmpDir 'score-output.txt'
    [IO.File]::WriteAllText($inFile, "RESUME:`n$resume`n`n---`nJOB POSTING (rule based label: $($j.fit)):`n$desc", $utf8)

    $result = $null; $err = $null
    foreach ($try in 1..2) {
        Remove-Item $outFile -ErrorAction SilentlyContinue
        $r = Invoke-Local $inFile $outFile
        if ($r.ok -and (Test-Path $outFile)) {
            $text = [IO.File]::ReadAllText($outFile, $utf8)
            $m = [regex]::Match($text, '\{[^{}]*"score"\s*:\s*(\d{1,3})[^{}]*\}')
            if ($m.Success) {
                $reason = [regex]::Match($m.Value, '"reason"\s*:\s*"([^"]*)"').Groups[1].Value
                $result = @{ score = [math]::Min(100, [int]$m.Groups[1].Value); reason = $reason }
                break
            }
            $err = 'could not read a score from the answer'
        } else { $err = $r.msg }
    }
    if ($result -and $j.bilingual) { $result.score = [math]::Min(100, [int]$result.score + 10); $result.reason = "$($result.reason) (+10 bilingual)" }
    $scores[$j.id] = [ordered]@{
        score = if ($result) { $result.score } else { $null }; reason = if ($result) { $result.reason } else { "not scored: $err" }
        fit = $j.fit; bilingual = [bool]$j.bilingual; category = $j.category; company = $j.company; title = $j.title; url = $j.url; location = $j.locationNote
        pay = if ($j.pay) { "`$$([math]::Round($j.pay.min/1000))k-`$$([math]::Round($j.pay.max/1000))k" } else { 'pay not listed' }
        flags = @($j.flags)
    }
    Write-Output ("[{0}/{1}] {2} | {3} | {4}" -f $n, $jobs.Count, $j.company, $j.title, $(if ($result) { $result.score } else { 'not scored' }))
}
Remove-Item (Join-Path $tmpDir 'score-input.txt'), (Join-Path $tmpDir 'score-output.txt') -ErrorAction SilentlyContinue

$date = Get-Date -Format 'yyyy-MM-dd'
$out = [ordered]@{ generatedAt = (Get-Date).ToString('s'); date = $date; model = 'local (tools\local-worker.ps1 -Worker local)'; scored = $scores.Count; scores = $scores }
[IO.File]::WriteAllText((Join-Path $outDir 'scores-latest.json'), ($out | ConvertTo-Json -Depth 6), $utf8)

$fitOrder = @{ 'Good fit' = 0; 'Stretch' = 1; 'Reach' = 2 }
$catOrder = @{ 'cyber' = 0; 'systems' = 1; 'it_support' = 2 }
$ranked = @($scores.GetEnumerator() | Where-Object { $null -ne $_.Value.score } |
    Sort-Object { $fitOrder[$_.Value.fit] }, { $catOrder[$_.Value.category] }, { -$_.Value.score } | Select-Object -First $Top)
$lines = @("# Top $($ranked.Count) for Claude to review ($date)", '', "Scored by the local model. Good fit first, then Stretch, then Reach, highest score first within each. Claude reviews only these.", '')
$i = 0
foreach ($e in $ranked) {
    $i++; $v = $e.Value
    $lines += "$i. **$($v.company)**, $($v.title) | $($v.fit) | local score $($v.score) | $($v.pay) | $($v.location)"
    $lines += "   $($v.reason)  "
    $lines += "   $($v.url)"
    $lines += ''
}
$unscored = @($scores.GetEnumerator() | Where-Object { $null -eq $_.Value.score })
if ($unscored.Count) { $lines += "Not scored (local model failed twice): $($unscored.Count). See scores-latest.json." }
[IO.File]::WriteAllText((Join-Path $outDir "top-for-claude-$date.md"), ($lines -join "`n"), $utf8)
Write-Output "scored $($scores.Count), top list: output\top-for-claude-$date.md"
