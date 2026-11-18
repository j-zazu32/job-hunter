#!/usr/bin/env node
// Job Hunter feed
// Pulls current openings from company career boards (Greenhouse, Lever, Ashby, Workday),
// keeps the ones that fit criteria.json, and writes the new matches to output/.
//
// Usage (from this folder):
//   node fetch-jobs.mjs            normal daily run, only jobs not seen before
//   node fetch-jobs.mjs --all      show every current match, even ones seen before
//   node fetch-jobs.mjs --check    test every company board, change nothing
//   node fetch-jobs.mjs --only=huntress   run a single company (slug, tenant, or name)

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.JOB_HUNTER_ROOT || path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const FLAG = (name) => ARGS.includes(`--${name}`);
const OPT = (name) => (ARGS.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

const UA = 'job-hunter/1.0 (personal job search script)';
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

// ---------------------------------------------------------------- helpers

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (fallback !== undefined && e.code === 'ENOENT') return fallback; throw new Error(`Could not read ${path.basename(file)}: ${e.message}`); }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function http(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
      if (res.status === 404) { const e = new Error('board not found (404)'); e.fatal = true; throw e; }
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); try { await res.body?.cancel(); } catch {} await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e; }
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timed out') : e;
      if (e.fatal) throw e;
      await sleep(1000 * (i + 1));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
export function htmlToText(html = '') {
  let s = decodeEntities(html || ''); // Greenhouse sends escaped HTML, so decode before stripping tags
  s = s.replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const safeName = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);

// ---------------------------------------------------------------- geography

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const STATE_RES = Object.entries(STATES).map(([ab, name]) => [ab, new RegExp(`\\b${name}\\b`, 'i'), new RegExp(`(^|[\\s,(/-])${ab}(?=$|[\\s,).;/-])`)]);

export function detectStates(s) {
  const found = new Set();
  for (const [ab, nameRe, abRe] of STATE_RES) if (nameRe.test(s) || abRe.test(s)) found.add(ab);
  if (/\bD\.?C\.?\b|District of Columbia/.test(s)) { found.add('DC'); if (!/Washington State|\bWA\b/.test(s)) found.delete('WA'); }
  if (found.has('WV')) {
    const rest = s.replace(/West Virginia/gi, '');
    if (!/\bVirginia\b/i.test(rest) && !/(^|[\s,(/-])VA(?=$|[\s,).;/-])/.test(rest)) found.delete('VA');
  }
  return [...found];
}

// Places for your area come from places.json (see places.example.json): [{ name, lat, lon, county }, ...].
// The feed uses them to tell whether an on site job is inside your radius. Without the file only remote jobs and jobs that list your state can match.
let PLACES = [];
export function setPlaces(list) {
  PLACES = (list || []).map(({ name, lat, lon, county }) => ({ name, lat, lon, county, re: new RegExp(`\\b${String(name).replace(/[.]/g, '\\.')}\\b`, 'i') }));
}

function milesBetween(a, b) {
  const R = 3958.8, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const FOREIGN_RE = /\b(canada|mexico|united kingdom|\buk\b|england|london|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|netherlands|amsterdam|poland|warsaw|krakow|india|bengaluru|bangalore|hyderabad|pune|chennai|singapore|japan|tokyo|australia|sydney|melbourne|brazil|s[aã]o paulo|argentina|buenos aires|colombia|bogot[aá]|costa rica|philippines|manila|israel|tel aviv|emea|apac|latam|europe|toronto|vancouver|montreal|quebec|korea|seoul|china|hong kong|taiwan|dubai|uae|south africa|czech|prague|romania|ukraine|sweden|stockholm|denmark|copenhagen|norway|oslo|finland|helsinki|switzerland|zurich|italy|milan|belgium|brussels|austria|vienna|hungary|budapest|greece|turkey|egypt|chile|peru|uruguay|new zealand|serbia|belgrade|estonia|lithuania|latvia)\b/i;
const US_GENERIC_RE = /united states|\bU\.?S\.?A?\b|\bU\.S\.|\bamericas\b|north america|nationwide|us national|anywhere in the us/i;
const REMOTE_RE = /\bremote\b|\banywhere\b|work from home|\bwfh\b|telecommut|home[- ]based|\bvirtual\b|\bdistributed\b/i;

export function checkLocation(job, crit) {
  const home = { lat: crit.home.lat, lon: crit.home.lon };
  const counties = new Set(crit.home.allowedCounties || []);
  const homeState = crit.home.state || '';              // two letter code, for example TX
  const areaName = STATES[homeState] || 'your area';    // used in notes and flags
  const regionRe = crit.home.regionName ? new RegExp(crit.home.regionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const flags = [];

  // "(Remote in VA, MD, PA...)" style restriction written into the title
  const restr = /\(\s*remote in ([^)]*)\)/i.exec(job.title || '');
  if (restr) {
    const st = detectStates(restr[1]);
    if (st.length && !st.includes(homeState) && !US_GENERIC_RE.test(restr[1])) return { ok: false, reason: `remote only in ${st.join(', ')}` };
  }

  const title = String(job.title || '');
  if (job.country && job.country !== 'US') return { ok: false, reason: `based in ${job.country}` };
  if (FOREIGN_RE.test(title)) return { ok: false, reason: 'non US location in title' };
  const region = new RegExp(crit.excludeRegionPattern || '$^', 'i').exec(title);
  if (region) return { ok: false, reason: `regional role (${region[0]})` };
  const titleUS = /anywhere in the u\.?s|remote in the u\.?s|\bus remote\b|u\.s\. remote|\(remote,? us\)/i.test(title);

  const text = String(job.locationText || '').trim();
  const pieces = text ? text.split(/\s*(?:;|\||•|\n|\s+or\s+)\s*/i).map((p) => p.trim()).filter(Boolean) : [];
  if (!pieces.length) {
    if (job.isRemote) return { ok: true, mode: 'remote', note: 'remote (location not listed)', flags: ['remote: confirm US eligibility'] };
    return { ok: false, reason: 'no location listed' };
  }

  let best = null;
  const reasons = [];
  for (const piece of pieces) {
    const explicitRemote = REMOTE_RE.test(piece);
    const remote = explicitRemote || job.isRemote === true;
    const foreign = FOREIGN_RE.test(piece);
    const usGeneric = US_GENERIC_RE.test(piece);
    const states = detectStates(piece);
    // a place name from places.json only counts if no other state is named (avoids West Hollywood, CA and similar)
    const place = states.length && !states.includes(homeState) ? null : PLACES.find((p) => p.re.test(piece));

    if (remote) {
      if (states.includes(homeState) || (place && counties.has(place.county))) { best = pick(best, { ok: true, mode: 'remote', note: `remote (${areaName} OK)`, rank: 0 }); continue; }
      if (explicitRemote && states.length && !states.includes(homeState)) { reasons.push(`remote only in ${states.join(', ')}`); continue; }
      if (foreign && !usGeneric) { reasons.push(`remote outside the US (${piece})`); continue; }
      if (usGeneric || titleUS) { best = pick(best, { ok: true, mode: 'remote', note: 'remote (US)', rank: 0 }); continue; }
      if (!explicitRemote) { // remote flag from the board, location is an office or timezone hint
        best = pick(best, { ok: true, mode: 'remote', note: `remote, listed under ${piece}`, rank: 1, flags: [`remote: confirm ${areaName} is eligible`] }); continue;
      }
      best = pick(best, { ok: true, mode: 'remote', note: 'remote (country not stated)', rank: 2, flags: ['remote: confirm US eligibility'] });
      continue;
    }

    if (place) {
      const miles = Math.round(milesBetween(home, place));
      const extra = (crit.extraAllowedPlaces || []).map((x) => x.toLowerCase()).includes(place.name);
      if (!counties.has(place.county) && !extra) { reasons.push(`${place.name} is in ${place.county} County`); continue; }
      if (extra) flags.push(`${place.name.replace(/\b\w/g, (ch) => ch.toUpperCase())}: your outer limit, worth it only for the right job`);
      if (miles > crit.home.radiusMiles) { reasons.push(`${place.name} is ${miles} mi away`); continue; }
      const mode = job.workplace === 'hybrid' || /hybrid/i.test(piece) ? 'hybrid' : 'onsite';
      best = pick(best, { ok: true, mode, note: `${mode} in ${piece} (~${miles} mi)`, miles, rank: 0 });
      continue;
    }
    if (regionRe && regionRe.test(piece)) { best = pick(best, { ok: true, mode: job.workplace || 'onsite', note: `${piece}`, rank: 1, flags: [`${crit.home.regionName}, exact city not listed`] }); continue; }
    if (homeState && states.includes(homeState)) { best = pick(best, { ok: true, mode: job.workplace || 'unclear', note: `${piece}`, rank: 2, flags: [`${areaName} listed, city unclear (may be remote by state)`] }); continue; }
    if (usGeneric && !states.length && !foreign) { best = pick(best, { ok: true, mode: 'remote', note: `${piece} (likely remote)`, rank: 2, flags: ['listed as US only: confirm remote'] }); continue; }
    reasons.push(foreign ? `outside the US (${piece})` : `not in range (${piece})`);
  }
  if (best) { best.flags = [...(best.flags || []), ...flags]; return best; }
  return { ok: false, reason: reasons[0] || 'location does not fit' };
}
// location order: fully remote first, then hybrid, then on site
const MODE_ORDER = { remote: 0, hybrid: 1, onsite: 2 };
const modeRank = (m) => MODE_ORDER[m] ?? 3;
function pick(a, b) {
  if (!a) return b;
  if ((b.rank ?? 0) !== (a.rank ?? 0)) return (b.rank ?? 0) < (a.rank ?? 0) ? b : a;
  if (modeRank(b.mode) !== modeRank(a.mode)) return modeRank(b.mode) < modeRank(a.mode) ? b : a;
  return (b.miles ?? 999) < (a.miles ?? 999) ? b : a;
}

// ---------------------------------------------------------------- titles, pay, shifts

export function classifyTitle(title, crit) {
  const t = String(title || '');
  if (new RegExp(crit.excludeTitlePattern, 'i').test(t)) return { ok: false, reason: 'not a target role' };
  const intern = /\bintern(ship)?\b|\bco-?op\b/i.test(t);
  if (intern && !crit.allowInternships) return { ok: false, reason: 'internship' };
  if (new RegExp(crit.seniorityExcludePattern, 'i').test(t)) return { ok: false, reason: 'senior level' };
  for (const [key, cat] of Object.entries(crit.categories)) {
    if (new RegExp(cat.titlePattern, 'i').test(t)) return { ok: true, category: key, intern };
  }
  return { ok: false, reason: 'not a target role' };
}

function num(s) { return parseFloat(String(s).replace(/,/g, '')); }
function annualize(v, unit) {
  if (v == null || isNaN(v) || v <= 0) return null;
  if (unit === 'hour' || v < 300) return Math.round(v * 2080);
  if (unit === 'month') return Math.round(v * 12);
  return Math.round(v);
}
export function normalizePay(p) {
  if (!p) return null;
  const unit = p.unit || 'year';
  const min = annualize(p.min, unit), max = annualize(p.max ?? p.min, unit);
  if (!min && !max) return null;
  return { min: min || max, max: max || min, source: p.source, text: p.text || null };
}

const PAY_CONTEXT = /(salary|pay|compensation|base|wage|hourly|per hour|\/\s?hr|annual|range|\bote\b|usd|earn)/i;
export function parsePayText(text) {
  if (!text) return null;
  const s = String(text);
  const re = /(?:\$|USD\s?)\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?(?:\s*(?:-|–|—|to)\s*(?:\$|USD\s?)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kK])?)?(\s*(?:\/|per|an|a)\s*(hour|hr|year|yr|annum|month))?/g;
  const found = [];
  let m;
  while ((m = re.exec(s))) {
    const after = s.slice(re.lastIndex, re.lastIndex + 12);
    if (/^\s*(million|billion|mm\b|bn\b|m\b|b\b)/i.test(after)) continue;
    const ctx = s.slice(Math.max(0, m.index - 160), Math.min(s.length, re.lastIndex + 80));
    if (!PAY_CONTEXT.test(ctx)) continue;
    const a = num(m[1]) * (m[2] ? 1000 : 1);
    const b = m[3] ? num(m[3]) * (m[4] ? 1000 : 1) : null;
    let unit = m[6] ? (/hour|hr/i.test(m[6]) ? 'hour' : /month/i.test(m[6]) ? 'month' : 'year') : null;
    if (!unit) unit = (/per hour|hourly|\/\s?hr|an hour/i.test(ctx) && a < 300) ? 'hour' : 'year';
    const lo = annualize(a, unit), hi = b ? annualize(b, unit) : null;
    if (!lo || lo < 15000) continue; // stipends, small bonuses, odd numbers
    if (hi && hi < lo) continue;
    found.push({ min: lo, max: hi || lo, range: !!hi, text: s.slice(Math.max(0, m.index - 40), Math.min(s.length, re.lastIndex + 10)).replace(/\s+/g, ' ').trim() });
  }
  if (!found.length) return null;
  const pickOne = found.find((f) => f.range) || found[0];
  return { min: pickOne.min, max: pickOne.max, source: 'description', text: pickOne.text };
}

export function scanFlags(text, crit) {
  const flags = [];
  const s = String(text || '');
  if (new RegExp(crit.shifts.dropPattern, 'i').test(s)) return { drop: 'third shift / overnight', flags };
  for (const [label, pat] of Object.entries(crit.shifts.flags)) if (new RegExp(pat, 'i').test(s)) flags.push(label);
  for (const [label, pat] of Object.entries(crit.otherFlags || {})) if (new RegExp(pat, 'i').test(s)) flags.push(label);
  if (flags.some((f) => f.startsWith('clearance:'))) { const i = flags.indexOf('clearance mentioned'); if (i >= 0) flags.splice(i, 1); }
  const years = [...s.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*years?(?:'|’)?\s*(?:of\s+)?(?:\w+\s+){0,4}?(?:experience|exp\b)/gi)].map((x) => +x[1]).filter((n) => n > 0 && n < 21);
  return { drop: null, flags, minYears: years.length ? Math.min(...years) : null };
}

// Good fit / Stretch / Reach (rules in criteria.json "fit")
export function fitLabel(title, text, minYears, crit) {
  const f = crit.fit;
  const re = (p) => new RegExp(p, 'i');
  const t = String(title || '');
  if (minYears != null && minYears > f.stretchMaxYears) return { fit: 'Reach', why: `${minYears}+ years asked` };
  if (re(f.reachRequiredPattern).test(String(text || ''))) return { fit: 'Reach', why: 'KQL/SPL required' };
  const engineer = re(f.engineerTitlePattern).test(t);
  const engineerOk = re(f.engineerOkPattern).test(t);
  if (engineer && !engineerOk) return { fit: 'Reach', why: 'engineer title (not associate, junior, support or sysadmin)' };
  if (re(f.goodTitlePattern).test(t)) {
    if (re(f.reachTitlePattern).test(t)) return { fit: 'Stretch', why: 'entry level engineer title' };
    if (minYears != null && minYears > f.goodMaxYears) return { fit: 'Stretch', why: `${minYears} years asked` };
    return { fit: 'Good fit', why: 'entry level title' };
  }
  if (!engineerOk && re(f.reachTitlePattern).test(t)) return { fit: 'Reach', why: 'engineer or researcher title' };
  if (re(f.stretchTitlePattern).test(t)) return { fit: 'Stretch', why: 'level II title' };
  if (minYears != null && minYears > f.goodMaxYears) return { fit: 'Stretch', why: `${minYears} years asked` };
  if (minYears != null) return { fit: 'Good fit', why: `${minYears} years asked` };
  return { fit: 'Stretch', why: 'no level or years listed' };
}

function postedDaysAgo(job) {
  if (job.postedAt) { const t = Date.parse(job.postedAt); if (!isNaN(t)) return Math.floor((Date.now() - t) / 86400000); }
  const p = String(job.postedText || '');
  if (/today/i.test(p)) return 0;
  if (/yesterday/i.test(p)) return 1;
  const m = /(\d+)\+?\s*days?/i.exec(p);
  return m ? +m[1] : null;
}

// ---------------------------------------------------------------- job boards

async function listGreenhouse(c) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${c.slug}`;
  const d = await http(`${base}/jobs`);
  return (d.jobs || []).map((j) => ({
    ats: 'greenhouse', company: c.name, id: `gh:${c.slug}:${j.id}`, title: (j.title || '').trim(), url: j.absolute_url,
    locationText: j.location?.name || '', isRemote: null, workplace: null, postedAt: j.first_published || j.updated_at || null,
    loadDetail: async () => {
      const x = await http(`${base}/jobs/${j.id}?pay_transparency=true`);
      const r = x.pay_input_ranges || [];
      const pay = r.length ? { min: Math.min(...r.map((p) => p.min_cents / 100)), max: Math.max(...r.map((p) => p.max_cents / 100)), source: 'posting' } : null;
      return { description: htmlToText(x.content || ''), pay, postedAt: x.first_published || x.updated_at || null };
    },
  }));
}

async function listLever(c) {
  const d = await http(`https://api.lever.co/v0/postings/${c.slug}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => {
    const desc = [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n');
    const sr = j.salaryRange;
    const pay = sr && (sr.min || sr.max) ? { min: sr.min, max: sr.max, unit: /hour/i.test(sr.interval || '') ? 'hour' : /month/i.test(sr.interval || '') ? 'month' : 'year', source: 'posting' } : null;
    const locs = [...new Set([j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean))];
    const wt = j.workplaceType && j.workplaceType !== 'unspecified' ? j.workplaceType : null;
    return {
      ats: 'lever', company: c.name, id: `lv:${c.slug}:${j.id}`, title: (j.text || '').trim(), url: j.hostedUrl, applyUrl: j.applyUrl,
      locationText: locs.join('; ') + (j.country === 'US' ? ' (USA)' : ''), country: j.country || null,
      isRemote: wt ? wt === 'remote' : null, workplace: wt, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      description: desc, pay, commitment: j.categories?.commitment || '',
    };
  });
}

async function listAshby(c) {
  const d = await http(`https://api.ashbyhq.com/posting-api/job-board/${c.slug}?includeCompensation=true`);
  return (d.jobs || []).filter((j) => j.isListed !== false).map((j) => {
    const locs = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean);
    const comp = (j.compensation?.summaryComponents || []).find((x) => /salary/i.test(x.compensationType || ''));
    let pay = null;
    if (comp && (comp.minValue || comp.maxValue)) pay = { min: comp.minValue, max: comp.maxValue, unit: /hour/i.test(comp.interval || '') ? 'hour' : 'year', source: 'posting' };
    else if (j.compensation?.compensationTierSummary) pay = { ...(parsePayText(`salary ${j.compensation.compensationTierSummary}`) || {}), source: 'posting' };
    const wt = (j.workplaceType || '').toLowerCase();
    return {
      ats: 'ashby', company: c.name, id: `ab:${c.slug}:${j.id}`, title: (j.title || '').trim(), url: j.jobUrl, applyUrl: j.applyUrl,
      locationText: [...new Set(locs)].join('; '), isRemote: wt ? wt === 'remote' : !!j.isRemote, workplace: wt === 'onsite' ? 'onsite' : wt || null,
      postedAt: j.publishedAt || null, description: j.descriptionPlain || htmlToText(j.descriptionHtml || ''), pay: pay && (pay.min || pay.max) ? pay : null,
      commitment: j.employmentType || '',
    };
  });
}

// Workday sits behind Cloudflare. After a burst it answers HTTP 429 with a bot challenge (cf-mitigated: challenge), and every
// further request only prolongs the block. So: keep the honest user agent, send few requests (one at a time, WD_GAP_MS apart,
// detail pages only for jobs not checked in the last 14 days, at most WD_MAX_DETAILS per run), and on the first 429 stop
// all Workday requests for this run and report it. Nothing is retried until the next run.
const WD_GAP_MS = Number(process.env.WD_GAP_MS ?? 6000), WD_MAX_DETAILS = 25, WD_RECHECK_DAYS = 14;
let workdayQueue = Promise.resolve();
let workdayBlocked = false, wdDetailCount = 0;
function wdBlockedError() { const e = new Error('Workday blocked requests (HTTP 429 Cloudflare challenge): skipped for this run, will retry next run'); e.skipJob = true; return e; }
function wdHttp(url, opts) {
  const run = workdayQueue.then(async () => {
    if (workdayBlocked) throw wdBlockedError();
    await sleep(WD_GAP_MS);
    try { return await http(url, opts, 1); }
    catch (e) { if (/HTTP 429/.test(e.message)) { workdayBlocked = true; throw wdBlockedError(); } throw e; }
  });
  workdayQueue = run.catch(() => {});
  return run;
}

async function listWorkday(c, crit) {
  const base = c.baseUrl || `https://${c.tenant}.${c.wd}.myworkdayjobs.com`;
  const api = `${base}/wday/cxs/${c.tenant}/${c.site}`;
  const terms = c.searchTerms || crit.workdaySearchTerms || ['security'];
  const found = new Map();
  for (const term of terms) {
    let total = null;
    for (let offset = 0; offset < 60; offset += 20) {
      const d = await wdHttp(`${api}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: term }) });
      if (total === null) total = d.total || 0;
      const posts = d.jobPostings || [];
      for (const p of posts) if (p.externalPath && !found.has(p.externalPath)) found.set(p.externalPath, p);
      if (posts.length < 20 || offset + 20 >= total) break;
    }
  }
  return [...found.values()].map((p) => ({
    ats: 'workday', company: c.name, id: `wd:${c.tenant}:${p.externalPath.split('_').pop()}`, title: (p.title || '').trim(),
    url: `${base}/en-US/${c.site}${p.externalPath}`, locationText: p.locationsText || '', isRemote: null, workplace: null, postedAt: null, postedText: p.postedOn || '',
    loadDetail: async () => {
      if (wdDetailCount >= WD_MAX_DETAILS) { const e = new Error('Workday detail budget for this run used up'); e.skipJob = true; throw e; }
      wdDetailCount++;
      const x = await wdHttp(`${api}${p.externalPath}`);
      const info = x.jobPostingInfo || {};
      const locs = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
      const rt = String(info.remoteType || '').toLowerCase();
      return {
        description: htmlToText(info.jobDescription || ''), locationText: locs.length ? locs.join('; ') : undefined,
        isRemote: rt ? /remote/.test(rt) && !/hybrid/.test(rt) : null, workplace: /hybrid/.test(rt) ? 'hybrid' : /remote/.test(rt) ? 'remote' : rt ? 'onsite' : null,
        commitment: info.timeType || '', url: info.externalUrl || undefined,
      };
    },
  }));
}

// Paylocity public job board (no API key). Needs boardId (the GUID in the board URL) and slug (the name at the end of the URL).
async function httpText(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/json', ...(opts.headers || {}) } });
      if (res.status === 404) { const e = new Error('board not found (404)'); e.fatal = true; throw e; }
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); try { await res.body?.cancel(); } catch {} await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e; }
      return await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('timed out') : e;
      if (e.fatal) throw e;
      await sleep(1000 * (i + 1));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

// pulls the first JSON object that follows `marker` in text, respecting strings and escapes
function jsonAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length - 1);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

async function listPaylocity(c) {
  const html = await httpText(`https://recruiting.paylocity.com/recruiting/jobs/All/${c.boardId}/${c.slug}`);
  const data = jsonAfter(html, 'window.pageData =');
  if (!data || !Array.isArray(data.Jobs)) throw new Error('could not read the Paylocity job list');
  return data.Jobs.map((j) => ({
    ats: 'paylocity', company: c.name, id: `pl:${c.boardId.slice(0, 8)}:${j.JobId}`, title: String(j.JobTitle || '').trim(),
    url: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${j.JobId}`, locationText: j.LocationName || '',
    isRemote: j.IsRemote ? true : null, workplace: j.IsRemote ? 'remote' : null, postedAt: j.PublishedDate ? new Date(j.PublishedDate).toISOString() : null,
    loadDetail: async () => {
      const page = await httpText(`https://recruiting.paylocity.com/Recruiting/Jobs/Details/${j.JobId}`);
      const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page);
      if (m) {
        const ld = JSON.parse(m[1]);
        return { description: htmlToText(ld.description || ''), postedAt: ld.datePosted ? new Date(ld.datePosted).toISOString() : null };
      }
      // some postings have no structured data block: use the visible description section
      const at = page.indexOf('job-preview-details');
      if (at < 0) throw new Error('no posting text on detail page');
      const end = page.indexOf('preview-bottom-apply-btn', at);
      return { description: htmlToText(page.slice(page.indexOf('>', at) + 1, end > at ? end : at + 30000)) };
    },
  }));
}

// UltiPro / UKG public job board (no API key). Needs company (like NTI1000NTVA) and boardId (GUID).
async function listUltipro(c) {
  const base = `https://recruiting.ultipro.com/${c.company}/JobBoard/${c.boardId}`;
  const all = [];
  for (let skip = 0; skip < 500; skip += 100) {
    const d = await http(`${base}/JobBoardView/LoadSearchResults`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunitySearch: { Top: 100, Skip: skip, QueryString: '', OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [] } }),
    });
    all.push(...(d.opportunities || []));
    if ((d.opportunities || []).length < 100 || all.length >= (d.totalCount || 0)) break;
  }
  return all.map((o) => {
    const locs = (o.Locations || []).map((l) => {
      const a = l.Address || {};
      const where = [a.City, a.State?.Code].filter(Boolean).join(', ');
      return [l.LocalizedDescription, where && `(${where})`].filter(Boolean).join(' ');
    });
    const remote = (o.Locations || []).some((l) => /remote/i.test(l.LocalizedDescription || ''));
    return {
      ats: 'ultipro', company: c.name, id: `up:${c.company}:${o.Id}`, title: String(o.Title || '').trim(),
      url: `${base}/OpportunityDetail?opportunityId=${o.Id}`, locationText: [...new Set(locs)].join('; '),
      isRemote: remote ? true : null, workplace: remote ? 'remote' : null, postedAt: o.PostedDate || null,
      commitment: o.FullTime === false ? 'part time' : '',
      loadDetail: async () => {
        const page = await httpText(`${base}/OpportunityDetail?opportunityId=${o.Id}`);
        const det = jsonAfter(page, 'CandidateOpportunityDetail(');
        if (!det) throw new Error('no posting data on detail page');
        return { description: htmlToText(det.Description || ''), postedAt: det.PostedDate || o.PostedDate || null };
      },
    };
  });
}

// USAJobs public API (free key, saved DPAPI encrypted at secrets\usajobs-key.dat, same method as the ntfy topic).
// IT Management series 2210 plus cybersecurity or SOC keywords, fully remote or near the location set in companies.json (locationName, radiusMiles). The key is read in memory only, never printed.
function readDpapiSecret(file) {
  if (!existsSync(file)) throw new Error(`secret file missing: ${path.basename(file)}`);
  const ps = '$s = (Get-Content -LiteralPath $env:JH_SECRET_FILE -Raw).Trim() | ConvertTo-SecureString; [Net.NetworkCredential]::new("", $s).Password';
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, JH_SECRET_FILE: file }, encoding: 'utf8', windowsHide: true }).trim();
}

async function listUsajobs(c) {
  const key = readDpapiSecret(path.join(ROOT, 'secrets', 'usajobs-key.dat'));
  const headers = { 'User-Agent': c.contactEmail, 'Authorization-Key': key };
  const keywords = c.keywords || ['cybersecurity', 'security operations', 'information security', 'SOC'];
  const where = [{ RemoteIndicator: 'True' }];
  if (c.locationName) where.push({ LocationName: c.locationName, Radius: String(c.radiusMiles || 40) });
  const found = new Map();
  for (const kw of keywords) {
    for (const w of where) {
      const q = new URLSearchParams({ JobCategoryCode: String(c.series || 2210), Keyword: kw, ResultsPerPage: '100', WhoMayApply: 'public', ...w });
      if (c.gradeLow) q.set('PayGradeLow', String(c.gradeLow));
      if (c.gradeHigh) q.set('PayGradeHigh', String(c.gradeHigh));
      const d = await http(`https://data.usajobs.gov/api/search?${q}`, { headers });
      for (const it of d.SearchResult?.SearchResultItems || []) if (!found.has(it.MatchedObjectId)) found.set(it.MatchedObjectId, it.MatchedObjectDescriptor);
      await sleep(300);
    }
  }
  return [...found.entries()].map(([id, m]) => {
    const det = m.UserArea?.Details || {};
    const rem = (m.PositionRemuneration || [])[0];
    const hourly = rem && /PH|hour/i.test(rem.RateIntervalCode || '');
    const pay = rem && Number(rem.MinimumRange) ? { min: Number(rem.MinimumRange), max: Number(rem.MaximumRange) || Number(rem.MinimumRange), unit: hourly ? 'hour' : 'year', source: 'posting' } : null;
    const locs = (m.PositionLocation || []).map((l) => l.LocationName).filter(Boolean);
    const remote = String(det.RemoteIndicator).toLowerCase() === 'true' || /remote/i.test(m.PositionTitle || '');
    const desc = [m.OrganizationName && `Agency: ${m.OrganizationName}`, det.LowGrade && `Grades: ${m.JobGrade?.[0]?.Code || 'GS'} ${det.LowGrade} to ${det.HighGrade}`,
      m.PositionSchedule?.[0]?.Name, det.SecurityClearance && `Security clearance: ${det.SecurityClearance}`, det.JobSummary, det.MajorDuties?.join?.('\n') || det.MajorDuties,
      m.QualificationSummary, det.Requirements, det.Education, det.Evaluations].filter(Boolean).join('\n\n');
    return {
      ats: 'usajobs', company: `${m.OrganizationName || 'US Government'} (USAJobs)`, id: `usa:${id}`, title: String(m.PositionTitle || '').trim(),
      url: m.PositionURI, applyUrl: m.ApplyURI?.[0] || m.PositionURI, locationText: remote ? `Remote; ${[...new Set(locs)].join('; ')}`.replace(/; $/, '') : [...new Set(locs)].join('; '),
      country: 'US', isRemote: remote ? true : null, workplace: remote ? 'remote' : null, postedAt: m.PublicationStartDate ? new Date(m.PublicationStartDate).toISOString() : null,
      description: htmlToText(desc), pay, commitment: m.PositionSchedule?.[0]?.Name || '',
    };
  });
}

// Remotive public API: remote jobs only, delayed 24h, max 4 calls a day (their terms). Links go back to Remotive.
async function listRemotive(c) {
  const d = await http('https://remotive.com/api/remote-jobs');
  return (d.jobs || []).map((j) => ({
    ats: 'remotive', company: `${String(j.company_name || '').trim()} (via Remotive)`, id: `rm:${j.id}`, title: (j.title || '').trim(), url: j.url,
    locationText: `Remote (${j.candidate_required_location || 'location not stated'})`, isRemote: true, workplace: 'remote',
    postedAt: j.publication_date ? new Date(j.publication_date).toISOString() : null, description: htmlToText(j.description || ''),
    pay: j.salary ? (parsePayText(`salary ${j.salary}`) || null) : null, commitment: String(j.job_type || '').replace(/_/g, ' '),
  }));
}

const ADAPTERS = { greenhouse: listGreenhouse, lever: listLever, ashby: listAshby, workday: listWorkday, remotive: listRemotive, paylocity: listPaylocity, ultipro: listUltipro, usajobs: listUsajobs };
const companyKey = (c) => (c.slug || c.tenant || c.name || '').toLowerCase();

// ---------------------------------------------------------------- main

export async function main() {
  const crit = await readJson(path.join(ROOT, 'criteria.json'));
  const placesFile = await readJson(path.join(ROOT, 'places.json'), null);
  setPlaces(placesFile?.places);
  if (!placesFile) console.log('Note: places.json not found. Copy places.example.json to places.json and edit it, or on site jobs cannot be matched to your area.');
  const { companies: allCompanies } = await readJson(path.join(ROOT, 'companies.json'));
  const only = OPT('only');
  let companies = allCompanies.filter((c) => (only ? [c.slug, c.tenant, c.name].filter(Boolean).some((v) => v.toLowerCase() === only.toLowerCase()) : c.enabled !== false));
  if (only && !companies.length) throw new Error(`No company matches --only=${only}`);

  if (FLAG('check')) return runCheck(companies, crit);

  const today = localDate();
  const dataDir = path.join(ROOT, 'data'), outDir = path.join(ROOT, 'output'), descDir = path.join(outDir, 'descriptions');
  await fs.mkdir(descDir, { recursive: true });
  const seen = await readJson(path.join(dataDir, 'seen.json'), {});
  const history = await readJson(path.join(dataDir, 'history.json'), {});
  const wdChecked = await readJson(path.join(dataDir, 'workday-checked.json'), {});

  const stats = { boardsOk: 0, boardsFailed: [], scanned: 0, dropped: {}, matched: 0, newMatches: 0 };
  const drop = (why) => { stats.dropped[why] = (stats.dropped[why] || 0) + 1; };
  const matches = [];
  const fresh = []; // fast lane: every current match first seen today or yesterday (last 48 hours)
  const freshSince = localDate(new Date(Date.now() - 86400000));

  console.log(`Job Hunter feed, ${today}: checking ${companies.length} companies...`);
  await pool(companies, CONCURRENCY, async (c) => {
    const adapter = ADAPTERS[c.ats];
    if (!adapter) { stats.boardsFailed.push(`${c.name}: unknown board type "${c.ats}"`); return; }
    let jobs;
    try { jobs = await adapter(c, crit); stats.boardsOk++; }
    catch (e) { stats.boardsFailed.push(`${c.name} (${c.ats}): ${e.message}`); return; }
    stats.scanned += jobs.length;

    for (const job of jobs) {
      const cls = classifyTitle(job.title, crit);
      if (!cls.ok) { drop(cls.reason); continue; }
      if (job.ats === 'workday' && !FLAG('all') && wdChecked[job.id] && (Date.parse(today) - Date.parse(wdChecked[job.id])) < WD_RECHECK_DAYS * 86400000) { if (seen[job.id]) seen[job.id].lastSeen = today; drop('workday job checked recently'); continue; }
      let loc = checkLocation(job, crit);
      if (!loc.ok && !job.loadDetail) { drop('location'); continue; }
      if (!loc.ok && job.ats === 'greenhouse') { drop('location'); continue; } // Greenhouse list already has the real location

      if (job.loadDetail) {
        try { const d = await job.loadDetail(); for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== null && v !== '') job[k] = v; }
        catch (e) { if (e.skipJob) { drop('workday not checked this run'); continue; } job.detailError = e.message; }
        if (job.ats === 'workday' && !job.detailError) wdChecked[job.id] = today;
        loc = checkLocation(job, crit);
        if (!loc.ok) { drop('location'); continue; }
      }

      const age = postedDaysAgo(job);
      if (age !== null && age > (crit.maxPostingAgeDays || 60)) { drop('older than max age'); continue; }

      const scan = scanFlags(`${job.title}\n${job.description || ''}`, crit);
      if (scan.drop) { drop(scan.drop); continue; }
      if (scan.minYears != null && scan.minYears > crit.fit.dropAboveYears) { drop(`asks more than ${crit.fit.dropAboveYears} years`); continue; }

      const cat = crit.categories[cls.category];
      const pay = normalizePay(job.pay) || normalizePay(parsePayText(job.description));
      if (pay && pay.max < cat.minPay) { drop('pay below your floor'); continue; }
      if (crit.stepDownTitlePattern && new RegExp(crit.stepDownTitlePattern, 'i').test(job.title) && !(pay && pay.max >= crit.stepDownMinPay)) { drop(`service or help desk Tier 1 below $${Math.round(crit.stepDownMinPay / 1000)}k (a step down)`); continue; }
      if (pay && crit.seniorPayFloor && pay.min > crit.seniorPayFloor) { drop('pay band suggests senior level'); continue; }

      // reposting history: same company + title showing up as new postings on several different days
      const hKey = `${companyKey({ slug: job.id.split(':')[1] })}|${job.title.toLowerCase().replace(/\s+/g, ' ')}`;
      const h = (history[hKey] ||= []);
      if (!h.some((x) => x.id === job.id)) h.push({ id: job.id, firstSeen: today });
      const windowStart = Date.now() - crit.reposting.windowDays * 86400000;
      const dates = new Set(h.filter((x) => Date.parse(x.firstSeen) >= windowStart).map((x) => x.firstSeen));
      if (dates.size >= crit.reposting.maxDistinctPostDates) { drop('constantly reposted'); continue; }

      const flags = [...(loc.flags || []), ...scan.flags];
      if (cls.intern) flags.push('internship');
      const bilingual = new RegExp(crit.bilingualPattern, 'i').test(`${job.title}\n${job.description || ''}`);
      if (bilingual) flags.push('bilingual: Spanish is a plus for you');
      if (/part[- ]time/i.test(job.commitment || '')) flags.push('part time');
      if (/contract|temporary|temp\b/i.test(job.commitment || '')) flags.push('contract');
      if (job.detailError) flags.push(`could not load full posting (${job.detailError})`);
      if (!pay) flags.push(cls.category === 'it_support' ? `pay not listed (IT support needs $${cat.minPay / 1000}k+)` : 'pay not listed');
      if (/\d+\+/.test(job.postedText || '')) flags.push(job.postedText.toLowerCase());

      const fitInfo = fitLabel(job.title, job.description, scan.minYears, crit);
      const record = {
        id: job.id, company: job.company, title: job.title, category: cls.category, categoryLabel: cat.label,
        url: job.url, applyUrl: job.applyUrl || job.url, board: job.ats,
        location: job.locationText, workMode: loc.mode, locationNote: loc.note, distanceMiles: loc.miles ?? null,
        locationRank: modeRank(loc.mode) * 3 + (loc.rank ?? 0),
        bilingual,
        fit: fitInfo.fit, fitReason: fitInfo.why,
        postedAt: job.postedAt || null, postedDaysAgo: age,
        pay: pay ? { min: pay.min, max: pay.max, source: pay.source, text: pay.text } : null,
        minYearsAsked: scan.minYears ?? null, flags: [...new Set(flags)],
        descriptionFile: job.description ? `output/descriptions/${safeName(job.id)}.txt` : null,
        firstSeen: seen[job.id]?.firstSeen || today,
      };
      if (job.description) await fs.writeFile(path.join(ROOT, record.descriptionFile), `${job.title}\n${job.company}\n${job.url}\n\n${job.description}`);
      stats.matched++;
      const isNew = !seen[job.id];
      if (isNew) stats.newMatches++;
      record.isNew = isNew;
      if (record.firstSeen >= freshSince) fresh.push(record);
      seen[job.id] = { firstSeen: seen[job.id]?.firstSeen || today, lastSeen: today, company: job.company, title: job.title, url: job.url };
      if (isNew || FLAG('all')) matches.push(record);
    }
  });

  const order = { cyber: 0, systems: 1, it_support: 2 };
  const fitOrder = { 'Good fit': 0, Stretch: 1, Reach: 2 };
  matches.sort((a, b) => order[a.category] - order[b.category] || fitOrder[a.fit] - fitOrder[b.fit] || (b.bilingual ? 1 : 0) - (a.bilingual ? 1 : 0) || a.locationRank - b.locationRank || a.company.localeCompare(b.company) || a.title.localeCompare(b.title));

  fresh.sort((a, b) => order[a.category] - order[b.category] || fitOrder[a.fit] - fitOrder[b.fit] || (b.bilingual ? 1 : 0) - (a.bilingual ? 1 : 0) || a.locationRank - b.locationRank || (b.pay?.max || 0) - (a.pay?.max || 0) || a.company.localeCompare(b.company));

  if (workdayBlocked && !stats.boardsFailed.some((x) => /Workday blocked/.test(x))) stats.boardsFailed.push('Workday: blocked requests (HTTP 429 Cloudflare challenge) while loading job details, those jobs will be checked next run');
  const report = { generatedAt: new Date().toISOString(), date: today, mode: FLAG('all') ? 'all current matches' : 'new matches only', stats, jobs: matches, fresh };
  await writeJson(path.join(outDir, `jobs-${today}.json`), report);
  await writeJson(path.join(outDir, 'jobs-latest.json'), report);
  await fs.writeFile(path.join(outDir, `jobs-${today}.md`), toMarkdown(report));
  // keep the state files small: forget jobs not seen for 180 days and repost history past twice the window
  const cutoffSeen = Date.now() - 180 * 86400000, cutoffHist = Date.now() - 2 * crit.reposting.windowDays * 86400000;
  for (const [k, v] of Object.entries(seen)) if (Date.parse(v.lastSeen) < cutoffSeen) delete seen[k];
  for (const [k, v] of Object.entries(history)) { history[k] = v.filter((x) => Date.parse(x.firstSeen) >= cutoffHist); if (!history[k].length) delete history[k]; }
  await writeJson(path.join(dataDir, 'seen.json'), seen);
  await writeJson(path.join(dataDir, 'history.json'), history);
  await writeJson(path.join(dataDir, 'workday-checked.json'), wdChecked);

  console.log(`\nBoards OK: ${stats.boardsOk}/${companies.length}   Jobs scanned: ${stats.scanned}   Matches: ${stats.matched}   New: ${stats.newMatches}`);
  if (stats.boardsFailed.length) console.log(`\nBoards that failed (fix or disable in companies.json):\n  - ${stats.boardsFailed.join('\n  - ')}`);
  const topDrops = Object.entries(stats.dropped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ');
  console.log(`\nFiltered out: ${topDrops || 'none'}`);
  console.log(`\nSaved: output/jobs-${today}.md and output/jobs-latest.json (${matches.length} jobs)`);
  for (const j of matches.slice(0, 15)) console.log(`  • ${j.company}: ${j.title} [${j.locationNote}]${j.pay ? ` $${Math.round(j.pay.min / 1000)}k-$${Math.round(j.pay.max / 1000)}k` : ''}`);
  if (matches.length > 15) console.log(`  ...and ${matches.length - 15} more in the file.`);
}

function toMarkdown(r) {
  const money = (p) => (p ? `$${Math.round(p.min / 1000)}k${p.max !== p.min ? `–$${Math.round(p.max / 1000)}k` : ''}` : 'not listed');
  const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = [`# Job feed for ${r.date}`, '', `${r.jobs.length} ${r.mode}. Boards checked: ${r.stats.boardsOk}, jobs scanned: ${r.stats.scanned}.`, ''];
  if (r.stats.boardsFailed.length) lines.push(`**Boards that failed:** ${r.stats.boardsFailed.map(esc).join('; ')}`, '');
  const age = (j) => (j.postedDaysAgo === null || j.postedDaysAgo === undefined ? 'not given' : j.postedDaysAgo === 0 ? 'today' : `${j.postedDaysAgo}d`);
  const role = (j) => `${j.isNew ? '**NEW** ' : ''}[${esc(j.title)}](${j.url})`;
  // fast lane: the "Top 5 fresh" section and reach out cards are added here by Claude's review (see PROMPT.md)
  lines.push(`## Top 5 fresh`, '', r.fresh.some((j) => j.fit !== 'Reach') ? `Not scored yet. Say "fast lane" to Claude to score these and fill this section.` : 'No matches first seen in the last 48 hours.', '');
  const fresh = r.fresh.filter((j) => j.fit !== 'Reach');
  if (fresh.length) {
    lines.push(`### Fresh, last 48 hours (${fresh.length})`, '', '| Fit | Company | Role | Where | Pay | Age | First seen |', '|---|---|---|---|---|---|---|');
    for (const j of fresh) lines.push(`| ${j.fit} | ${esc(j.company)} | ${role(j)} | ${esc(j.locationNote)} | ${money(j.pay)} | ${age(j)} | ${j.firstSeen} |`);
    lines.push('');
  }
  for (const [cat, label] of [['cyber', 'Cyber / security'], ['systems', 'Systems / network'], ['it_support', 'IT support (fallback)']]) {
    const rows = r.jobs.filter((j) => j.category === cat && j.fit !== 'Reach');
    if (!rows.length) continue;
    const n = (fit) => rows.filter((j) => j.fit === fit).length;
    lines.push(`## ${label} (${rows.length}: ${n('Good fit')} Good fit, ${n('Stretch')} Stretch)`, '', '| Fit | Company | Role | Where | Pay | Age | Flags |', '|---|---|---|---|---|---|---|');
    for (const j of rows) lines.push(`| ${j.fit} (${esc(j.fitReason)}) | ${esc(j.company)} | ${role(j)} | ${esc(j.locationNote)} | ${money(j.pay)} | ${age(j)} | ${esc(j.flags.join(', '))} |`);
    lines.push('');
  }
  const reach = r.jobs.filter((j) => j.fit === 'Reach');
  if (reach.length) {
    lines.push(`<details><summary>Reach (for later) (${reach.length})</summary>`, '', '| Company | Role | Why Reach | Where | Pay | Age |', '|---|---|---|---|---|---|');
    for (const j of reach) lines.push(`| ${esc(j.company)} | ${role(j)} | ${esc(j.fitReason)} | ${esc(j.locationNote)} | ${money(j.pay)} | ${age(j)} |`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

async function runCheck(companies, crit) {
  console.log(`Checking ${companies.length} company boards (nothing is saved)...\n`);
  let ok = 0;
  const results = await pool(companies, CONCURRENCY, async (c) => {
    try {
      const jobs = await ADAPTERS[c.ats](c, crit);
      const titleHits = jobs.filter((j) => classifyTitle(j.title, crit).ok).length;
      ok++;
      return `OK    ${c.name} (${c.ats}): ${jobs.length} open jobs, ${titleHits} with a target title`;
    } catch (e) { return `FAIL  ${c.name} (${c.ats}): ${e.message}`; }
  });
  console.log(results.join('\n'));
  console.log(`\n${ok}/${companies.length} boards working.`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
