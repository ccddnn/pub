/**
 * fetch.news.cn.mjs
 *
 * Watches a hard-coded news site and raises a Windows notification when the
 * first <h1> changes or when a link with a watched title appears inside one of
 * the watched content sections (#focus, #depth, #cardRS). Polls every
 * 5 minutes by default; override with --t <minutes>.
 *
 * Run:  node fetch.news.cn.mjs --t 10
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration (the site is hard-coded on purpose, per task.md)
// ---------------------------------------------------------------------------
const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.news.cn';
const DEFAULT_POLL_INTERVAL_MIN = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const STATE_FILE = path.join(__dirname, 'last-headline.json');

// An <a> is reported when its text matches one of these patterns.
const WATCHED_TITLE_PATTERNS = [
  /主要负责同志职务调整/,
  /任.+代省长/,
  /任.+代市长/,
  /严重违纪/,
  /同志逝世/,
  /在京火化/,
];

// Watched links are only collected from these <div id="..."> sections.
const WATCHED_SECTION_IDS = ['focus', 'depth', 'cardRS'];

// setTimeout's delay is a signed 32-bit int; anything longer fires immediately.
const MAX_INTERVAL_MS = 2 ** 31 - 1;

/**
 * Reads the poll interval (in minutes) from the command line:
 *   --t 10, --t=10, -t 10   -> 10 minutes
 *   npm run start --t 10    -> npm swallows the flag and forwards a bare "10",
 *                              so a lone numeric argument is also accepted.
 * Falls back to DEFAULT_POLL_INTERVAL_MIN when no interval is given.
 */
function parseIntervalMinutes(argv) {
  let raw;

  for (let i = 0; i < argv.length && raw === undefined; i++) {
    const arg = argv[i];

    if (arg === '--t' || arg === '-t') {
      raw = argv[i + 1];
      if (raw === undefined) {
        fatal('missing value for ' + arg + ' (expected minutes, e.g. ' + arg + ' 10)');
      }
      i++;
    } else if (arg.startsWith('--t=') || arg.startsWith('-t=')) {
      raw = arg.slice(arg.indexOf('=') + 1);
    }
  }

  if (raw === undefined) {
    // Accept a lone numeric argument as the interval (npm swallows --t and
    // forwards a bare number). Only the last such argument is considered, so
    // future positional args (e.g. an ID) won't be mistaken for an interval.
    for (let i = argv.length - 1; i >= 0; i--) {
      if (/^\d+(\.\d+)?$/.test(argv[i])) {
        raw = argv[i];
        break;
      }
    }
  }

  if (raw === undefined) {
    return DEFAULT_POLL_INTERVAL_MIN;
  }

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fatal(`invalid interval "${raw}": expected a positive number of minutes`);
  }
  if (minutes * 60_000 > MAX_INTERVAL_MS) {
    fatal(`interval "${raw}" min is too large (max ${Math.floor(MAX_INTERVAL_MS / 60_000)} min)`);
  }
  return minutes;
}

function fatal(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

const POLL_INTERVAL_MIN = parseIntervalMinutes(process.argv.slice(2));
const POLL_INTERVAL_MS = Math.round(POLL_INTERVAL_MIN * 60_000);

// ---------------------------------------------------------------------------
// Extraction (<h1> headline + watched links)
// ---------------------------------------------------------------------------
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const A_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text) {
  return text.replace(ENTITY_RE, (match, code) => {
    if (code[0] === '#') {
      const value =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      try {
        return Number.isFinite(value) ? String.fromCodePoint(value) : match;
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Turns raw markup into display text: strip tags, decode entities, collapse space. */
function toText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves an href from the page into an absolute URL, or null. */
function resolveHref(rawHref) {
  if (!rawHref) return null;
  const decoded = decodeEntities(rawHref).trim();
  if (!decoded || /^(javascript|mailto|tel):/i.test(decoded) || decoded.startsWith('#')) {
    return null;
  }
  try {
    return new URL(decoded, SITE_URL).href;
  } catch {
    return null;
  }
}

function firstLinkUrl(html) {
  const re = new RegExp(A_RE.source, A_RE.flags);
  const match = re.exec(html);
  if (!match) return null;
  const href = HREF_RE.exec(match[1]);
  return href ? resolveHref(href[1] ?? href[2] ?? href[3] ?? '') : null;
}

const DIV_TAG_RE = /<div\b[^>]*>|<\/div\s*>/gi;

/**
 * Returns the inner HTML of every <div> whose id is one of WATCHED_SECTION_IDS.
 * Sections contain nested <div>s, so the closing tag is found by counting
 * open/close tags rather than by a single lazy regex.
 */
export function extractWatchedSections(html) {
  const sections = [];
  for (const id of WATCHED_SECTION_IDS) {
    const openRe = new RegExp(
      `<div\\b[^>]*\\bid\\s*=\\s*(?:"${id}"|'${id}'|${id}(?=[\\s>]))[^>]*>`,
      'i',
    );
    const open = openRe.exec(html);
    if (!open) continue;

    const bodyStart = open.index + open[0].length;
    const re = new RegExp(DIV_TAG_RE.source, DIV_TAG_RE.flags);
    re.lastIndex = bodyStart;

    let depth = 1;
    let match;
    while ((match = re.exec(html)) !== null) {
      depth += match[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        sections.push(html.slice(bodyStart, match.index));
        break;
      }
    }
  }
  return sections;
}

/**
 * Returns { headline, url } for the first <h1> on the page, or null when the
 * page has no usable <h1> (treated as "site broken", not "headline changed").
 */
export function extractFirstH1(html) {
  const match = H1_RE.exec(html);
  if (!match) return null;

  const inner = match[1];
  const headline = toText(inner);

  if (!headline) return null;
  return { headline, url: firstLinkUrl(inner) };
}

/**
 * Returns every <a> inside one of WATCHED_SECTION_IDS whose visible text
 * matches a watched pattern, as { title, url } in document order. A link is
 * tracked by its title (not its href), so state files stay readable and an
 * article that keeps its headline isn't reported twice.
 */
export function extractWatchedLinks(html) {
  const found = [];
  const seenKeys = new Set();
  for (const section of extractWatchedSections(html)) {
    const re = new RegExp(A_RE.source, A_RE.flags);
    let match;
    while ((match = re.exec(section)) !== null) {
      const title = toText(match[2]);
      if (!title || !WATCHED_TITLE_PATTERNS.some((re) => re.test(title))) continue;
      if (seenKeys.has(title)) continue;
      seenKeys.add(title);
      const href = HREF_RE.exec(match[1]);
      const url = href ? resolveHref(href[1] ?? href[2] ?? href[3] ?? '') : null;
      found.push({ title, url, key: title });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Persisted state (written atomically so a crash can't leave a corrupt file)
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, message) {
  const stamp = new Date().toLocaleString();
  const prefix = { info: 'INFO ', warn: 'WARN ', error: 'ERROR', alert: 'ALERT' }[level] ?? level;
  (level === 'error' ? console.error : console.log)(`[${stamp}] ${prefix} ${message}`);
}

// ---------------------------------------------------------------------------
// Windows notification (PowerShell toast, with msg.exe fallback)
// ---------------------------------------------------------------------------
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildToastXml({ title, body, url }) {
  const launch = url
    ? ` activationType="protocol" launch="${xmlEscape(url)}"`
    : '';
  return (
    `<toast${launch}>` +
    '<visual><binding template="ToastGeneric">' +
    `<text>${xmlEscape(title)}</text>` +
    `<text>${xmlEscape(body)}</text>` +
    '</binding></visual>' +
    '<audio silent="true" />' +
    '</toast>'
  );
}

// The XML arrives base64-encoded in NW_XML and is pasted in verbatim, so no
// quote/encoding problems with arbitrary headline text.
const PS_TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NW_XML))
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $ids = @('News Watcher', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe')
  $lastErr = $null
  foreach ($id in $ids) {
    try {
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id)
      $notifier.Show($toast)
      exit 0
    } catch { $lastErr = $_ }
  }
  throw $lastErr
} catch {
  # plain text on stderr; an uncaught error would be serialised as CLIXML
  [Console]::Error.WriteLine('toast failed: ' + $_.Exception.Message)
  exit 1
}
`;

function runPowerShell(script, extraEnv) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { env: { ...process.env, ...extraEnv }, windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function msgFallback(headline) {
  const child = spawn('msg', ['*', headline], { stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => log('warn', `msg.exe fallback unavailable: ${err.message}`));
}

async function notify(message) {
  const toastXml = buildToastXml(message);
  const result = await runPowerShell(PS_TOAST_SCRIPT, {
    NW_XML: Buffer.from(toastXml, 'utf8').toString('base64'),
  });
  if (result.code === 0) return;

  log(
    'warn',
    `toast notification failed (${result.stderr.trim() || `exit ${result.code}`}); falling back to msg.exe`,
  );
  msgFallback(message.title);
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------
async function checkOnce() {
  const res = await fetch(SITE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'news-watcher/1.0 (+node)',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const found = extractFirstH1(html);
  if (!found) {
    log('warn', 'no <h1> found on the page; keeping the previous headline');
    return;
  }

  const prev = loadState();
  const state = {
    headline: found.headline,
    url: found.url,
    checkedAt: new Date().toISOString(),
  };

  if (!prev || !prev.headline) {
    state.watchedLinks = extractWatchedLinks(html).map((link) => link.key);
    saveState(state);
    log('info', `baseline saved: "${found.headline}"`);
    return;
  }

  const headlineChanged = prev.headline !== found.headline;
  const watchedLinks = extractWatchedLinks(html);
  // Older state files have no watchedLinks; treat their keys as already seen
  // when the baseline exists so the first scan after upgrading stays quiet.
  // Keys used to be hrefs, so a stored URL also counts as seen.
  const seenKeys = new Set(prev.watchedLinks ?? []);
  const newLinks = watchedLinks.filter(
    (link) => !seenKeys.has(link.key) && !(link.url && seenKeys.has(link.url)),
  );

  saveState({ ...state, watchedLinks: watchedLinks.map((link) => link.key) });

  if (headlineChanged) {
    log('alert', `HEADLINE CHANGED\n  old: ${prev.headline}\n  new: ${found.headline}`);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await notify({
      title: found.headline,
      body: `Headline changed at ${time}` + (found.url ? ' — click to open the article' : ''),
      url: found.url,
    });
  } else {
    log('info', `unchanged: "${found.headline}"`);
  }

  for (const link of newLinks) {
    log('alert', `WATCHED LINK APPEARED\n  ${link.title}\n  ${link.url ?? '(no url)'}`);
    await notify({
      title: link.title,
      body: 'New item on the watched page' + (link.url ? ' — click to open the article' : ''),
      url: link.url,
    });
  }
}

let timer = null;
let shuttingDown = false;

function scheduleNext() {
  if (shuttingDown) return;
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function tick() {
  timer = null;
  try {
    await checkOnce();
  } catch (err) {
    log('error', `check failed: ${err.message}`);
  } finally {
    scheduleNext();
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  log('info', `received ${signal}; stopping watcher`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  // Allow a single check then exit, for tests and manual smoke runs.
  const once = process.argv.includes('--once');
  log(
    'info',
    `watching ${SITE_URL} every ${POLL_INTERVAL_MIN} min (state: ${STATE_FILE})`,
  );
  if (once) {
    checkOnce()
      .catch((err) => log('error', `check failed: ${err.message}`))
      .finally(() => process.exit(0));
  } else {
    tick();
  }
}
