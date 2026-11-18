# Job Hunter

A personal job search assistant that finds new openings every morning, filters and labels them against your own rules, scores them with a
model that runs on your own computer, and helps prepare applications, with **a person pressing Submit on every one**.

It is built for one person on one Windows machine. It does not scrape LinkedIn, Indeed or ZipRecruiter, and it never sends anything on your behalf.

## The problem

Entry level security and IT jobs are scattered across hundreds of company career sites. The big job boards bury them under senior roles,
repost the same listing for weeks, hide pay, and hide overnight shifts in the fine print. Checking them by hand every day is slow, and the
good ones are often gone within a few days. Applying is slow too: the same details typed into dozens of different forms.

## What it does

1. **Finds jobs.** Reads public job lists straight from employers (Greenhouse, Lever, Ashby, Workday, Paylocity, UKG) and two free APIs
   (USAJobs, Remotive). 84 sources in the author's setup; `companies.example.json` shows the format.
2. **Filters.** Drops jobs that ask for too many years, hide a senior level behind a plain title, require overnight work, sit outside your
   location rules, pay below your floor, or are reposted again and again.
3. **Labels** every job Good fit, Stretch or Reach, so the daily list is mostly roles you can realistically get. Reach jobs never reach your phone.
4. **Scores locally.** A small language model on your own computer gives each new job a first pass score against your resume. The resume never leaves the machine.
5. **Pushes the top 5** to your phone every morning with ntfy: company, title, pay, label, link.
6. **Resume panel.** For a job you care about: an ATS keyword check, a recruiter skim, a hiring manager review, and a tailored one page resume
   that a "facts guard" checks so it cannot claim a tool, certification or number you do not have.
7. **Fills applications** in a visible browser from a profile file, stops before Submit, and saves every answer to a file so you can paste it yourself if a form misbehaves.
8. **Tracks everything** in a CSV, from found to submitted.

The full design, the filters, the daily flow and two diagrams are in [docs/SCOPE.md](docs/SCOPE.md).

## Sample output

All fictional. More in [examples/sample-output](examples/sample-output).

```text
Job Hunter: top 3 of 4 new

Contoso MDR | SOC Analyst, Tier 1 | $62k-$74k | Good fit
https://example.com/jobs/1001

Tailspin Support | Service Desk Technician I (Spanish speaking) | $66k-$72k | Good fit
https://example.com/jobs/1005

Adatum Networks | Detection Analyst | $78k-$92k | Stretch
https://example.com/jobs/1003
```

| Fit | Company | Role | Where | Pay | Flags |
|---|---|---|---|---|---|
| Good fit | Contoso MDR | SOC Analyst, Tier 1 | remote (US) | $62k–$74k | second shift, on call |
| Stretch | Fabrikam Health | Security Analyst II | hybrid, about 9 mi | $70k–$85k | Security+ mentioned, shift ends after midnight |
| Good fit | Northwind Security | Junior Systems Administrator | onsite, about 12 mi | not listed | pay not listed |

## How it keeps a human in control

- **A person presses Submit.** The assistant fills a form in a visible browser and stops before the last button. It never submits, never sends a message,
  never creates an account, never types a password, never solves a CAPTCHA.
- **It cannot invent experience.** Tailored resumes are edited from your real resume. `panel/facts-guard.py` rejects any new tool, certification, acronym,
  proper noun or number that is not in your resume or in a short list of facts you confirmed.
- **Private data stays local.** Scoring and keyword extraction use a model served on `127.0.0.1`; the helper refuses any other address.
  The phone push carries only company, title, pay, label and link.
- **Secrets are encrypted** with Windows DPAPI and are never printed or put on a command line.
- **Honest requests.** A stated limit on request volume, no fake browser headers, and when a career site answers with a bot challenge the feed
  stops talking to it for the run instead of trying to get around it.
- **Every change has a backup,** and changes are tested on a scratch copy first.

## Security

- **No dependencies.** No npm packages, no Python packages, no PowerShell Gallery modules. `package.json` has no `dependencies` and no install scripts, so nothing is downloaded or run during setup.
- **Source only.** The repository is plain text: no binaries, installers, archives or compiled files, no minified or encoded code, and nothing that downloads and runs code.
- **Pinned tool versions.** [DEPENDENCIES.md](DEPENDENCIES.md) lists every tool with the exact version it was tested with and where it comes from. The one `npx` command is pinned
  (`@playwright/mcp@0.0.85`) and so is the LibreOffice install (`--version 26.8.3.1`).
- **Secret scanning.** The final copy was scanned with gitleaks 8.30.1 (0 leaks; the scanner was first checked against planted fake keys to prove it detects them),
  plus a search for names, addresses, phone numbers, emails and key patterns.
- **Malware scan.** A Microsoft Defender custom scan of the folder found nothing, and the AI instruction file was checked with SkillSpector (rated safe).
- **A tested `.gitignore`.** I planted 32 fake private files (profile, tracker, backups, data, output, uploads, secrets, browser snapshots, resumes) in a scratch copy of the repo and
  confirmed that none of them would be committed.
- **Secrets are encrypted** with Windows DPAPI (readable only by your Windows user on your computer), never printed and never put on a command line. API keys are read in memory only.
- **Local means local.** The model helper refuses any address that is not this computer, so resume text is never sent to a cloud model by this tool.

If you find a security problem, please open an issue.

## Setup

You need Windows 10 or 11 with PowerShell 5.1, and Node.js. Everything else is optional; see [DEPENDENCIES.md](DEPENDENCIES.md) for exact versions and where each comes from.
There are no npm or Python packages to install.

1. **Copy the example files** to their real names and edit them:
   ```powershell
   copy profile.example.json profile.json
   copy criteria.example.json criteria.json
   copy companies.example.json companies.json
   copy places.example.json places.json
   copy PROMPT.example.md PROMPT.md
   ```
   The real names are in `.gitignore`, so your details stay out of git. **Set your area:** `home` in `criteria.json` (center point, radius, two letter state,
   a region name, and the counties you accept) and the towns around you in `places.json` (name, latitude, longitude, county). The examples use the
   Austin, Texas area; without `places.json` the feed prints a note and only remote jobs and jobs that list your state can match.
2. **Test the boards** without saving anything: `node fetch-jobs.mjs --check`
3. **Run the feed:** `node fetch-jobs.mjs` (the first run treats every match as new). Results are in `output/`.
4. **Local scoring (optional).** Install Ollama, run `ollama pull qwen2.5:7b`, save your resume text to `data\resume-soc.txt`
   (for example `pdftotext -layout resume.pdf data\resume-soc.txt`), then run `.\score-local.ps1 -All -Max 3` to try it.
5. **Phone push (optional).** Install the ntfy app, then create a random topic name stored encrypted and show it once to type into the app:
   ```powershell
   .\tools\save-secret.ps1 -Path secrets\ntfy-topic.dat -Generate -Show
   .\notify.ps1 -Test
   ```
6. **Every morning (optional).** `schtasks /Create /SC DAILY /ST 07:10 /TN "Job Hunter Feed" /TR "\"C:\full\path\to\run-feed.cmd\""`
   runs the feed, the scoring and the push. The log is `logs\feed.log`.
7. **With an AI assistant (optional).** Start an assistant such as Claude Code in this folder and say `review`, `fast lane`, `panel <company> <role>` or
   `apply to 1, 3`. It follows `PROMPT.md`. Form filling uses the Playwright MCP server pinned to an exact version:
   `npx @playwright/mcp@0.0.85 --browser msedge`.
8. **USAJobs (optional).** Get a free key at developer.usajobs.gov, save it with `.\tools\save-secret.ps1 -Path secrets\usajobs-key.dat`,
   put your email in `contactEmail`, and set `enabled` to true in `companies.json`.

## Tech used

- **Node.js** (no packages): the feed, adapters, filters and labels in one file, `fetch-jobs.mjs`
- **PowerShell 5.1:** local scoring, the push, secrets (DPAPI), PDF checks
- **Python 3, standard library only:** a `.docx` text editor and the facts guard
- **Ollama with a 7B open model:** keyword extraction and first pass scores, on the same machine
- **LibreOffice:** turns the tailored `.docx` into a one page PDF
- **ntfy.sh:** the push to the phone
- **Claude Code with Playwright MCP:** review, the resume panel and visible browser form filling, always with a human at Submit
- **Windows Task Scheduler:** the daily run

## What I learned

- **The best data source is not scraping.** Most applicant tracking systems expose their public job lists as simple APIs. Reading those directly
  was more reliable, faster and more polite than any page scraper, and it kept the project clear of the big job boards' terms.
- **When a site pushes back, back off.** A Cloudflare bot challenge looks like an ordinary HTTP 429, and retrying harder only extends the block.
  Sending far fewer requests, caching what was already checked, and giving up for the run at the first challenge fixed it. Skipping a source is better than evading it.
- **Use the small model for what it is good at.** A 7B model lists keywords from a posting well, but its 0 to 100 fit scores are noisy
  (it once scored a mismatched senior role above a good entry level one). So a script verifies everything the model extracts, and the score is only a tiebreaker inside a rule based label.
- **Guard rails beat promises for AI written text.** "Never invent experience" in a prompt is not enough. A small vocabulary check that flags any new tool, number
  or certification caught real mistakes. It is a heuristic, so a human still reads every resume.
- **Supply limits results more than logic.** After the filters were right, only about one in nine matches was a Good fit, because most boards post mid and senior roles.
  Measuring that pointed at the next work (more entry level sources) instead of more tuning.
- **A human at the last step is a feature.** Dropdowns that fail to register, forms that need a sign in, and confusing validation messages all showed up in real use.
  Saving every answer to a file made those failures cheap.
- **Backups and scratch copies make an AI assistant safe to work with.** Every script change was backed up and tested on a copy first, which made it easy to roll back.

## Limits

Windows only. One user. HTML only job systems (iCIMS, Dayforce, Phenom, Taleo, PeopleSoft, SuccessFactors, NEOGOV) are not read yet.
Pay is often not listed. The local model is small. Years of experience are found with text patterns. Workday may block a run.
More in [docs/SCOPE.md](docs/SCOPE.md), section 7.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with any company named in the examples; company names in `companies.example.json` are only
examples of public career sites.
