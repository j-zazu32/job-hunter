# Converts a .docx to PDF with LibreOffice (installed with winget, official package) and checks it is one page.
#   render-pdf.ps1 -Docx tailored.docx -OutPdf output\resumes\company-role.pdf
param(
    [Parameter(Mandatory)][string]$Docx,
    [Parameter(Mandatory)][string]$OutPdf
)
$ErrorActionPreference = 'Stop'
$soffice = 'C:\Program Files\LibreOffice\program\soffice.exe'
if (-not (Test-Path $soffice)) { throw 'LibreOffice not found. Install: winget install --id TheDocumentFoundation.LibreOffice -e --version 26.8.3.1' }
$docxFull = (Resolve-Path $Docx).Path
$outDir = Split-Path -Parent ([IO.Path]::GetFullPath($OutPdf))
New-Item -ItemType Directory -Force $outDir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('jh-render-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    # separate user profile so a running LibreOffice window never blocks this
    $profile = 'file:///' + ($tmp -replace '\\', '/') + '/profile'
    & $soffice "-env:UserInstallation=$profile" --headless --convert-to pdf --outdir $tmp $docxFull | Out-Null
    $made = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($docxFull) + '.pdf')
    if (-not (Test-Path $made)) { throw 'LibreOffice did not produce a PDF' }
    Copy-Item $made $OutPdf -Force
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
$pdftotext = (Get-Command pdftotext -ErrorAction SilentlyContinue).Source
if (-not $pdftotext) { $pdftotext = 'C:\msys64\ucrt64\bin\pdftotext.exe' }
$txt = & $pdftotext -layout $OutPdf - | Out-String
$pages = ([regex]::Matches($txt, "`f")).Count
Write-Output "pdf: $OutPdf"
Write-Output "pages: $pages $(if ($pages -eq 1) { '(OK, one page)' } else { '(TOO LONG, shorten the resume)' })"
if ($pages -ne 1) { exit 1 }
