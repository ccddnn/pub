/**
 * dispatch.mjs
 *
 * Site-independent watcher: polls a page, diffs a headline (when the site has
 * one) and a set of watched article titles, and raises a Windows notification
 * on change. A site config (see sites/) supplies the URL, the state file name
 * and the extraction functions; everything else lives here.
 *
 *   site = {
 *     name, url, stateFile, requestTimeoutMs, userAgent,
 *     headline: { extract(html) -> { headline, url } | null } | null,
 *     watchedTitles: {
 *       patterns: RegExp[],                  // empty = keep every extracted title
 *       extract(html) -> { title, url, key }[],
 *     },
 *   }
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_POLL_INTERVAL_MIN = 5;

// A failed fetch is retried a few times before the poll counts as failed.
const MAX_FETCH_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000;

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

// ---------------------------------------------------------------------------
// Persisted state (written atomically so a crash can't leave a corrupt file)
// ---------------------------------------------------------------------------
function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, stateFile);
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
/** Sleeps for the retry backoff. SIGINT during it exits the process outright. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient failures are worth retrying: no HTTP response at all (network
 * error or timeout) or a status that may clear up (408, 425, 429, 5xx).
 * Other statuses (403, 404, ...) will not fix themselves.
 */
function isRetryable(err) {
  if (err.status === undefined) return true;
  return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
}

/** Equal-jitter exponential backoff: half fixed, half random, capped. */
function backoffDelayMs(attempt) {
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** One fetch attempt. requestTimeoutMs applies to this attempt alone. */
async function fetchOnce(site) {
  const res = await fetch(site.url, {
    redirect: 'follow',
    // Fresh per attempt, so each retry gets its own timeout.
    signal: AbortSignal.timeout(site.requestTimeoutMs ?? 20_000),
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': site.userAgent ?? 'news-watcher/1.0 (+node)',
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Fetches the site's page, retrying transient failures with exponential
 * backoff. Resolves with the HTML text, or throws once the attempts are
 * exhausted or the failure is not retryable (e.g. HTTP 404).
 */
async function fetchPage(site) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(site);
    } catch (err) {
      if (attempt >= MAX_FETCH_ATTEMPTS || !isRetryable(err)) throw err;
      const delayMs = backoffDelayMs(attempt);
      log(
        'warn',
        `fetch failed (attempt ${attempt}/${MAX_FETCH_ATTEMPTS}): ${err.message}; retrying in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }
}

/** An empty pattern list means "every extracted title counts". */
function matchPatterns(links, patterns) {
  if (!patterns || patterns.length === 0) return links;
  return links.filter((link) => patterns.some((re) => re.test(link.title)));
}

async function checkOnce(site, stateFile) {
  const html = await fetchPage(site);

  let found = null;
  if (site.headline) {
    found = site.headline.extract(html);
    if (!found) {
      log('warn', 'no <h1> found on the page; keeping the previous headline');
      return;
    }
  }

  const prev = loadState(stateFile);
  const state = {
    headline: found ? found.headline : null,
    url: found ? found.url : null,
    checkedAt: new Date().toISOString(),
  };

  const watchedLinks = matchPatterns(
    site.watchedTitles.extract(html),
    site.watchedTitles.patterns,
  );

  // A site without a headline has a valid baseline as soon as a state file
  // exists; a headline site needs a non-empty headline recorded.
  const hasBaseline = prev !== null && (site.headline ? Boolean(prev.headline) : true);

  if (!hasBaseline) {
    saveState(stateFile, { ...state, watchedLinks: watchedLinks.map((link) => link.key) });
    log(
      'info',
      found
        ? `baseline saved: "${found.headline}"`
        : `baseline saved: ${site.name} (${watchedLinks.length} watched keys)`,
    );
    return;
  }

  const headlineChanged = Boolean(site.headline) && prev.headline !== state.headline;
  // Older state files have no watchedLinks; treat their keys as already seen
  // when the baseline exists so the first scan after upgrading stays quiet.
  // Keys used to be hrefs, so a stored URL also counts as seen.
  const seenKeys = new Set(prev.watchedLinks ?? []);
  const newLinks = watchedLinks.filter(
    (link) => !seenKeys.has(link.key) && !(link.url && seenKeys.has(link.url)),
  );

  saveState(stateFile, { ...state, watchedLinks: watchedLinks.map((link) => link.key) });

  if (headlineChanged) {
    log('alert', `HEADLINE CHANGED\n  old: ${prev.headline}\n  new: ${state.headline}`);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await notify({
      title: state.headline,
      body: `Headline changed at ${time}` + (state.url ? ' — click to open the article' : ''),
      url: state.url,
    });
  } else if (site.headline) {
    log('info', `unchanged: "${state.headline}"`);
  } else {
    log('info', `checked: ${watchedLinks.length} watched keys`);
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

/**
 * Starts watching `site`: one check with --once, otherwise a self-scheduling
 * poll loop. Interval comes from --t / -t / a bare numeric arg (minutes).
 */
export function runWatcher(site) {
  const pollIntervalMin = parseIntervalMinutes(process.argv.slice(2));
  const pollIntervalMs = Math.round(pollIntervalMin * 60_000);
  const stateFile = path.join(__dirname, site.stateFile);

  let timer = null;
  let shuttingDown = false;

  function scheduleNext() {
    if (shuttingDown) return;
    timer = setTimeout(tick, pollIntervalMs);
  }

  async function tick() {
    timer = null;
    try {
      await checkOnce(site, stateFile);
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

  // Allow a single check then exit, for tests and manual smoke runs.
  const once = process.argv.includes('--once');
  log(
    'info',
    `watching ${site.url} every ${pollIntervalMin} min (state: ${stateFile})`,
  );
  if (once) {
    checkOnce(site, stateFile)
      .catch((err) => log('error', `check failed: ${err.message}`))
      .finally(() => process.exit(0));
  } else {
    tick();
  }
}
