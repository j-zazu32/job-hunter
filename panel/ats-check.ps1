# ATS check. The LOCAL model (tools\local-worker.ps1 -Worker local) lists the must have keywords from the posting; this script then checks
# each one against the resume text itself, so the found/missing list is exact and not the model's guess. It also runs the Part 3
# text layer checks on the PDF (one page, name and contact near the top, plain headings, clean characters).
#   ats-check.ps1 -Posting output\descriptions\file.txt -ResumePdf uploads\resume.pdf [-KeywordFile keywords.txt] [-Out report.md]
param(
    [Parameter(Mandatory)][string]$Posting,
    [Parameter(Mandatory)][string]$ResumePdf,
    [string]$Out,
    [string]$KeywordFile,
    [string]$Worker = (Join-Path (Split-Path $PSScriptRoot) 'tools\local-worker.ps1')
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$pdftotext = (Get-Command pdftotext -ErrorAction SilentlyContinue).Source
if (-not $pdftotext) { $pdftotext = 'C:\msys64\ucrt64\bin\pdftotext.exe' }

$resume = (& $pdftotext -layout $ResumePdf - | Out-String)
$post = [IO.File]::ReadAllText((Resolve-Path $Posting), $utf8)
if ($post.Length -gt 15000) { $post = $post.Substring(0, 15000) }

# 1) keywords from the posting (local model). With -KeywordFile the list is saved on the first run and reused after that,
#    so a before and an after check use the same keywords (the 7B model returns a slightly different list each time).
if ($KeywordFile -and (Test-Path $KeywordFile)) {
    $kw = [IO.File]::ReadAllText($KeywordFile, $utf8) -split "`r?`n" | Where-Object { $_.Trim() }
} else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ats-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $inFile = Join-Path $tmp 'posting.txt'; $outFile = Join-Path $tmp 'keywords.txt'
    [IO.File]::WriteAllText($inFile, $post, $utf8)
    $prompt = 'From the job posting below, list only the specific tools, technologies, certifications and skill names that an applicant tracking system would search for, for example Active Directory, SentinelOne, log analysis, Splunk, incident response. One per line, 1 to 3 words each, at most 25 lines. Never write sentences, never write phrases like experience with or knowledge of, no numbering, no bullets, no headings, no commentary. Use the posting words exactly.'
    # three passes, merged: the 7B model returns a different, sometimes very short, list each time
    $all = @()
    foreach ($pass in 1..3) {
        Remove-Item $outFile -ErrorAction SilentlyContinue
        $o = & $Worker -Worker local -Prompt $prompt -InputFile $inFile -OutFile $outFile 2>&1 | Out-String
        if ($o -match 'REFUSED|FAILED' -or -not (Test-Path $outFile)) { if ($pass -eq 1) { throw "local worker failed: $(($o -split "`n")[0])" } else { continue } }
        $all += [IO.File]::ReadAllText($outFile, $utf8) -split "`r?`n" | ForEach-Object { ($_ -replace '^[\s\-\*•\d\.\)]+', '').Trim().TrimEnd('.', ',', ';') } |
            Where-Object { $_.Length -ge 2 -and $_.Length -le 40 -and $_ -notmatch ':$' -and $_ -notmatch '^(must|preferred|required|certifications?)\b' }
    }
    $seenKw = @{}; $kw = @()
    foreach ($k in $all) { $key = $k.ToLower(); if (-not $seenKw.ContainsKey($key)) { $seenKw[$key] = 1; $kw += $k } }
    $kw = $kw | Select-Object -First 40
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($KeywordFile) { [IO.File]::WriteAllText($KeywordFile, ($kw -join "`n"), $utf8) }
}

# 2) exact check against the resume text. Filler words are dropped so "Experience with SentinelOne" is checked as "sentinelone".
$norm = { param($s) ($s.ToLower() -replace '[^a-z0-9+#]+', ' ').Trim() }
$filler = @('experience','with','knowledge','of','working','proficiency','proficient','ability','able','to','in','and','the','a','an','skills','skill','must','have','years','year','months','three','two','or','more','tools','strong','understanding','familiarity','using','use','for','on','related','including','preferred','required','plus','fluent')
$rn = " $(& $norm $resume) "
$found = @(); $partial = @(); $missing = @()
foreach ($k in $kw) {
    if ($k -match ':$') { continue }
    $words = @((& $norm $k) -split ' ' | Where-Object { $_ -and ($filler -notcontains $_) })
    if (-not $words.Count) { continue }
    # a whole phrase match wins; otherwise each word must appear as a whole word (plural and verb endings allowed, so "base" does not match "based")
    $phrase = (& $norm $k)
    if ($rn.Contains(" $phrase ")) { $found += $k; continue }
    $hit = @($words | Where-Object { $rn -match ('(?<![a-z0-9+#])' + [regex]::Escape($_) + '(s|es|ed|ing)?(?![a-z0-9+#])') }).Count
    if ($hit -eq $words.Count) { $found += $k } elseif ($hit -gt 0) { $partial += $k } else { $missing += $k }
}

# 3) text layer checks on the PDF
$lines = $resume -split "`r?`n"
$top = ($lines | Select-Object -First 8) -join "`n"
$pages = ([regex]::Matches($resume, "`f")).Count
# Contact details to look for come from profile.json (lastName, phone, email, and resumeCity or address.city), never from this script.
$profilePath = Join-Path (Split-Path $PSScriptRoot) 'profile.json'
$pf = if (Test-Path $profilePath) { [IO.File]::ReadAllText($profilePath, $utf8) | ConvertFrom-Json } else { $null }
$contact = { param($value, [scriptblock]$test) if ($pf -and $value) { & $test $value } else { $null } }   # $null means skipped
$resumeCity = if ($pf -and $pf.resumeCity) { $pf.resumeCity } elseif ($pf -and $pf.address) { $pf.address.city } else { $null }
$checks = [ordered]@{
    'One page'                                     = ($pages -eq 1)
    'Name near the top'                            = (& $contact $(if ($pf) { $pf.lastName }) { param($v) $top -match [regex]::Escape($v) })
    'Phone near the top'                           = (& $contact $(if ($pf) { ($pf.phone -replace '\D', '') }) { param($v) ($top -replace '\D', '') -match $v })
    'Email near the top'                           = (& $contact $(if ($pf) { $pf.email }) { param($v) $top -match [regex]::Escape($v) })
    'City near the top'                            = (& $contact $resumeCity { param($v) $top -match [regex]::Escape($v) })
    'Heading EXPERIENCE'                          = ($resume -match '(?m)^\s*EXPERIENCE\s*$')
    'Heading EDUCATION'                            = ($resume -match '(?m)^\s*EDUCATION\s*$')
    'Heading SKILLS'                               = ($resume -match '(?m)^\s*SKILLS\s*$')
    'No broken characters (U+FFFD)'                = ($resume -notmatch [char]0xFFFD)
}
$private = [regex]::Matches($resume, '[\uE000-\uF8FF]').Count

$md = New-Object Collections.Generic.List[string]
$md.Add("# ATS check: $(Split-Path -Leaf $ResumePdf)"); $md.Add('')
$md.Add("Posting: $(Split-Path -Leaf $Posting). Keywords listed by the local model, checked against the resume text by script.")
$md.Add(''); $md.Add("## Keywords: $($found.Count) found, $($partial.Count) partly, $($missing.Count) missing of $($found.Count + $partial.Count + $missing.Count)")
$md.Add('- Found: ' + $(if ($found) { $found -join '; ' } else { 'none' }))
$md.Add('- Partly (some of the words appear): ' + $(if ($partial) { $partial -join '; ' } else { 'none' }))
$md.Add('- Missing: ' + $(if ($missing) { $missing -join '; ' } else { 'none' }))
$md.Add(''); $md.Add('## Text layer checks')
foreach ($c in $checks.GetEnumerator()) { $md.Add("- $(if ($null -eq $c.Value) { 'SKIPPED (not in profile.json)' } elseif ($c.Value) { 'PASS' } else { 'FAIL' }): $($c.Key)") }
if ($private -gt 0) { $md.Add("- NOTE: $private bullet glyph(s) extract as private use characters (symbol font bullets). Most parsers skip them; they are not text.") }
if ($Out) { [IO.File]::WriteAllText($Out, ($md -join "`n"), $utf8); Write-Output "report: $Out" }
$md -join "`n"
