# Dependencies

**There are no npm packages, no Python packages and no PowerShell Gallery modules.** `package.json` has no `dependencies`, no
`devDependencies` and no install scripts. `fetch-jobs.mjs` uses only Node.js built in modules, the Python scripts use only the
standard library, and the PowerShell scripts use only what ships with Windows. Nothing is downloaded or run during setup.

Below is everything the project talks to or calls, with the exact version it was built and tested with, and where it comes from.

## Programs you install yourself

| Program | Version tested | Where it comes from | Used for | Required? |
|---|---|---|---|---|
| Node.js | 26.13.0 (any version with built in `fetch`, 18 or newer, should work) | https://nodejs.org | runs `fetch-jobs.mjs` | yes |
| Python | 3.12.10 | https://www.python.org | `panel/docx-tool.py`, `panel/facts-guard.py` (standard library only) | only for the resume panel |
| Windows PowerShell | 5.1 (built into Windows 10 and 11) | Windows | `notify.ps1`, `score-local.ps1`, `tools/`, `panel/*.ps1`, DPAPI secret storage | yes |
| Ollama | 0.40.16 | https://ollama.com | serves the local model on this computer | only for local scoring and the ATS keyword step |
| Model `qwen2.5:7b` | Q4_K_M, 7.6B parameters, digest `845dbda0ea48` | the Ollama model library (`ollama pull qwen2.5:7b`) | first pass scoring and keyword lists; any other Ollama model works via `JOBHUNTER_MODEL` | only for local scoring |
| LibreOffice | 26.8.3.1 | `winget install --id TheDocumentFoundation.LibreOffice -e --version 26.8.3.1` (the Document Foundation package, version pinned) | turns the tailored `.docx` into a one page PDF | only for the resume panel |
| `pdftotext` | Xpdf tools 4.06 (the Poppler version works too) | https://www.xpdfreader.com or the MSYS2 / Poppler packages | reads the PDF text layer for the ATS check | only for the resume panel |
| Microsoft Edge | 157 | Windows | the visible browser used to fill applications | only for form filling |
| Playwright MCP | `@playwright/mcp@0.0.85` (npm, Apache-2.0, https://github.com/microsoft/playwright-mcp) | `npx @playwright/mcp@0.0.85 --browser msedge`, always with the version pinned | lets the AI assistant drive the visible browser | only for form filling |
| ntfy app | current store version | App Store or Google Play | receives the daily push | only for the phone push |

## Services the feed calls over the internet

None needs an account except USAJobs (a free API key).

| Service | How it is used | Notes |
|---|---|---|
| Greenhouse, Lever, Ashby public job board APIs | read open jobs | public, no key |
| Workday career site search endpoints | read open jobs | paced; stops for the run at the first HTTP 429; honest user agent |
| Paylocity and UltiPro (UKG) public job boards | read open jobs | public pages |
| USAJobs API (data.usajobs.gov) | federal IT jobs | free key, and your email in the `User-Agent` header as they require |
| Remotive API | remote jobs | at most 4 calls a day, link back to Remotive |
| ntfy.sh | the daily push | public relay: only company, title, pay, label and link are sent, to a random topic name |

## What was checked

- No binaries, installers, archives or compiled files are in this repository: source code and text only.
- No encoded or obfuscated code, no minified scripts, no `eval` of downloaded text.
- No script downloads and then runs code. The only external programs the scripts start are `powershell`, `pdftotext`, LibreOffice and
  the local model through `tools/local-worker.ps1`, which only accepts a loopback address.
- Any use of `npx` is pinned to an exact version (see the Playwright MCP row).
