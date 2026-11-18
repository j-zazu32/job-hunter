# Saves a secret (a push topic or an API key) encrypted with Windows DPAPI, so only this Windows user on this computer can read it.
# The secret is never put on a command line and never printed unless you ask for it with -Show.
#
#   tools\save-secret.ps1 -Path secrets\ntfy-topic.dat -Generate -Show     make a random push topic and show it once, to type into the phone app
#   tools\save-secret.ps1 -Path secrets\usajobs-key.dat                    type or paste a key; the input is hidden
param(
    [Parameter(Mandatory)][string]$Path,
    [switch]$Generate,
    [ValidateRange(16, 64)][int]$Length = 24,
    [switch]$Show
)
$ErrorActionPreference = 'Stop'

if ($Generate) {
    # cryptographically secure random letters and digits
    $chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.ToCharArray()
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] $Length
    $limit = 256 - (256 % $chars.Length)
    $out = New-Object Text.StringBuilder
    while ($out.Length -lt $Length) {
        $rng.GetBytes($bytes)
        foreach ($b in $bytes) { if ($b -lt $limit -and $out.Length -lt $Length) { [void]$out.Append($chars[$b % $chars.Length]) } }
    }
    $plain = $out.ToString()
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
} else {
    $secure = Read-Host -Prompt 'Secret (input is hidden)' -AsSecureString
    $plain = $null
}

$dir = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
New-Item -ItemType Directory -Force $dir | Out-Null
$secure | ConvertFrom-SecureString | Set-Content -LiteralPath $Path -Encoding ASCII
Write-Output "saved: $Path (encrypted for $env:USERNAME on $env:COMPUTERNAME)"
if ($Show -and $plain) { Write-Output "secret (shown once, copy it now): $plain" }
$plain = $null
