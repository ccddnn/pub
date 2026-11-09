/**
 * html.mjs
 *
 * Dependency-free HTML helpers shared by the site watchers. The pages are
 * parsed with regexes on purpose (no DOM library), so these hold the escaping,
 * text-extraction and section-slicing primitives; each file under sites/ only
 * has to say *what* to look for.
 */

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

const A_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CLASS_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TITLE_ATTR_RE = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export function decodeEntities(text) {
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
export function toText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a mirror base ("<proxy origin>/<target url>") into
 * { origin, targetUrl }, or null when the base is not a mirror URL.
 */
function splitMirror(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  // "/https://example.com" -> "https://example.com"; keeps the base's own query.
  const targetUrl = url.pathname.slice(1) + url.search;
  if (!/^https?:\/\//i.test(targetUrl)) return null;
  return { origin: url.origin, targetUrl };
}

/** Resolves an href from the page into an absolute URL, or null. */
export function resolveHref(rawHref, baseUrl) {
  if (!rawHref) return null;
  const decoded = decodeEntities(rawHref).trim();
  if (!decoded || /^(javascript|mailto|tel):/i.test(decoded) || decoded.startsWith('#')) {
    return null;
  }
  try {
    const mirror = splitMirror(baseUrl);
    // Resolve against the *target* site so relative hrefs land on the right host.
    const absolute = new URL(decoded, mirror ? mirror.targetUrl : baseUrl).href;
    if (!mirror) return absolute;
    // Already addressed through this same mirror: leave it alone.
    const nested = splitMirror(absolute);
    if (nested && nested.origin === mirror.origin) return absolute;
    return `${mirror.origin}/${absolute}`;
  } catch {
    return null;
  }
}

/** Reads one attribute (double-quoted, single-quoted or bare) from a tag's attrs. */
function attrValue(re, attrs) {
  const match = re.exec(attrs);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/** True when a tag's class attribute contains `className` as a whole token. */
export function hasClass(attrs, className) {
  const value = attrValue(CLASS_RE, attrs);
  return value !== null && value.split(/\s+/).includes(className);
}

/**
 * Returns every <a> in document order as { attrs, inner, title, url }.
 * `title` is the tag's title attribute (or null); `url` is the resolved href.
 */
export function extractLinks(html, baseUrl) {
  const links = [];
  const re = new RegExp(A_RE.source, A_RE.flags);
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = HREF_RE.exec(match[1]);
    links.push({
      attrs: match[1],
      inner: match[2],
      title: attrValue(TITLE_ATTR_RE, match[1]),
      url: href ? resolveHref(href[1] ?? href[2] ?? href[3] ?? '', baseUrl) : null,
    });
  }
  return links;
}

/** URL of the first <a> inside `html`, resolved against `baseUrl`, or null. */
export function firstLinkUrl(html, baseUrl) {
  const link = extractLinks(html, baseUrl)[0];
  return link ? link.url : null;
}

/**
 * Returns the inner HTML of every element whose open tag matches `openTagRe`
 * (and whose name is `tagName`). Nested same-name elements are handled by
 * counting open/close tags rather than by a single lazy regex.
 */
export function extractTagSections(html, openTagRe, tagName) {
  const sections = [];
  const openRe = new RegExp(
    openTagRe.source,
    openTagRe.flags.includes('g') ? openTagRe.flags : openTagRe.flags + 'g',
  );
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');

  let open;
  while ((open = openRe.exec(html)) !== null) {
    const bodyStart = open.index + open[0].length;
    const re = new RegExp(tagRe.source, tagRe.flags);
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

/** Inner HTML of every <div id="..."> in `ids`, in the order the ids are listed. */
export function extractSectionsById(html, ids, tagName = 'div') {
  const sections = [];
  for (const id of ids) {
    const openRe = new RegExp(
      `<${tagName}\\b[^>]*\\bid\\s*=\\s*(?:"${id}"|'${id}'|${id}(?=[\\s>]))[^>]*>`,
      'i',
    );
    sections.push(...extractTagSections(html, openRe, tagName));
  }
  return sections;
}

/** Inner HTML of every <tagName> element on the page, in document order. */
export function extractSectionsByTag(html, tagName) {
  return extractTagSections(html, new RegExp(`<${tagName}\\b[^>]*>`, 'i'), tagName);
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Inner HTML of every <tagName> element whose class attribute holds `className`
 * as a whole token, in document order. Matching stops at whitespace/quotes so
 * "media-block" does not also select "media-block-wrap" or "media-block__title".
 * The leading whitespace in `\sclass` keeps data-class/aria-class out.
 */
export function extractSectionsByClass(html, className, tagName = 'div') {
  const name = className.replace(ESCAPE_RE, '\\$&');
  const token = `${name}(?=[\\s"'])`;
  const openRe = new RegExp(
    `<${tagName}\\b[^>]*\\sclass\\s*=\\s*(?:"(?:[^"]*\\s)?${token}[^"]*"|'(?:[^']*\\s)?${token}[^']*')[^>]*>`,
    'i',
  );
  return extractTagSections(html, openRe, tagName);
}
