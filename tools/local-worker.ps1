# Local model helper. Sends a prompt (and an optional input file) to a model served by Ollama on THIS machine
# and writes the answer to a file. score-local.ps1 and panel\ats-check.ps1 call it, so resume text never leaves the computer.
#
#   tools\local-worker.ps1 -Worker local -Prompt "Summarize this" [-InputFile path] [-OutFile path]
#
# Settings (environment variables, both optional):
#   JOBHUNTER_MODEL    the Ollama model name, default qwen2.5:7b
#   JOBHUNTER_OLLAMA   the Ollama address, default http://127.0.0.1:11434 (only loopback addresses are accepted)
#
# Prints: file, words, and the model that answered. On trouble it prints REFUSED or FAILED and exits non zero.
param(
    [ValidateSet('local')][string]$Worker = 'local',
    [Parameter(Mandatory)][string]$Prompt,
    [string]$InputFile,
    [string]$OutFile,
    [string]$Model = $(if ($env:JOBHUNTER_MODEL) { $env:JOBHUNTER_MODEL } else { 'qwen2.5:7b' }),
    [string]$Endpoint = $(if ($env:JOBHUNTER_OLLAMA) { $env:JOBHUNTER_OLLAMA } else { 'http://127.0.0.1:11434' })
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)

# "local" must stay local: refuse any address that is not this computer.
$hostName = ([uri]$Endpoint).Host
if ($hostName -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) {
    Write-Output "REFUSED: $Endpoint is not a loopback address. This helper only talks to a model on this computer."
    exit 2
}

# An 8192 token window is small. About 20,000 characters leaves room for the answer; past that the start would be cut off silently.
$MaxChars = 20000
$text = $Prompt
if ($InputFile) { $text += "`n`n---`n" + [IO.File]::ReadAllText((Resolve-Path $InputFile), $utf8) }
if ($text.Length -gt $MaxChars) {
    Write-Output "REFUSED: input is $($text.Length) characters, limit is $MaxChars. Split it."
    exit 2
}

$body = @{ model = $Model; stream = $false; options = @{ num_ctx = 8192; temperature = 0.2 }; messages = @(@{ role = 'user'; content = $text }) } | ConvertTo-Json -Depth 6
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ($Endpoint.TrimEnd('/') + '/api/chat') -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body $utf8.GetBytes($body) -TimeoutSec 600
    $answer = ($utf8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json).message.content
} catch {
    Write-Output "FAILED (local): $($_.Exception.Message)"
    exit 1
}

if (-not $OutFile) {
    $dir = Join-Path ([IO.Path]::GetTempPath()) 'jobhunter-worker'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $OutFile = Join-Path $dir ('{0}-local.md' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
[IO.File]::WriteAllText($OutFile, $answer, $utf8)
Write-Output "file: $OutFile"
Write-Output "words: $(@($answer -split '\s+' | Where-Object { $_ }).Count)"
Write-Output "answered by: $Model"
