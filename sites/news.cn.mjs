/**
 * sites/news.cn.mjs
 *
 * Site config for the news.cn front page. Watches the first <h1> for a
 * headline change and any <a> inside #focus, #depth or #cardRS whose text
 * matches one of the watched patterns.
 */

import {
  extractLinks,
  extractSectionsById,
  firstLinkUrl,
  toText,
} from '../html.mjs';

const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.news.cn';

const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;

// Watched links are only collected from these <div id="..."> sections.
const WATCHED_SECTION_IDS = ['focus', 'depth', 'cardRS'];

// An <a> is reported when its text matches one of these patterns.
const WATCHED_TITLE_PATTERNS = [
  /主要负责同志职务调整/,
  /任.+代省长/,
  /任.+代市长/,
  /严重违纪/,
  /同志逝世/,
  /在京火化/,
];

export const newsCn = {
  name: 'news.cn',
  url: SITE_URL,
  stateFile: 'last-headline.news.cn.json',
  requestTimeoutMs: 20_000,
  userAgent: 'news-watcher/1.0 (+node)',

  headline: {
    /** { headline, url } for the first <h1>, or null when there is none. */
    extract(html) {
      const match = H1_RE.exec(html);
      if (!match) return null;

      const inner = match[1];
      const headline = toText(inner);
      if (!headline) return null;
      return { headline, url: firstLinkUrl(inner, SITE_URL) };
    },
  },

  watchedTitles: {
    patterns: WATCHED_TITLE_PATTERNS,

    /**
     * Every <a> inside the watched sections, as { title, url, key }. A link is
     * tracked by its title (not its href), so state files stay readable and an
     * article that keeps its headline isn't reported twice.
     */
    extract(html) {
      const found = [];
      const seenTitles = new Set();
      for (const section of extractSectionsById(html, WATCHED_SECTION_IDS)) {
        for (const link of extractLinks(section, SITE_URL)) {
          const title = toText(link.inner);
          if (!title || seenTitles.has(title)) continue;
          seenTitles.add(title);
          found.push({ title, url: link.url, key: title });
        }
      }
      return found;
    },
  },
};
