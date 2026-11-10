/**
 * sites/bbc.zhongwen.mjs
 *
 * Site config for the BBC 中文（繁）homepage. Each story is a "promo-text"
 * block whose <h3> holds the link; the first one in the page is the hero
 * headline. Watches that headline for a change and every promo title as a
 * watched article. Navigation, topic and footer links live outside
 * promo-text, so they are not picked up.
 */

import {
  extractSectionsByClass,
  extractTagSections,
  firstLinkUrl,
  toText,
} from '../html.mjs';

const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.bbc.com/zhongwen/trad';
const PROMO_CLASS = 'promo-text';
const H3_RE = /<h3\b[^>]*>/i;

/** { headline, url } for a promo block's <h3>, or null when there is none. */
function promoTitle(section) {
  const h3 = extractTagSections(section, H3_RE, 'h3')[0];
  if (!h3) return null;

  const headline = toText(h3);
  if (!headline) return null;
  return { headline, url: firstLinkUrl(h3, SITE_URL) };
}

export const bbcZhongwen = {
  name: 'bbc.zhongwen',
  url: SITE_URL,
  stateFile: 'last-headline.bbc.zhongwen.json',
  requestTimeoutMs: 20_000,
  userAgent: 'news-watcher/1.0 (+node)',

  headline: {
    /** { headline, url } for the hero promo, or null when there is none. */
    extract(html) {
      const promos = extractSectionsByClass(html, PROMO_CLASS, 'div');
      return promos.length > 0 ? promoTitle(promos[0]) : null;
    },
  },

  watchedTitles: {
    patterns: [], // empty = every article title counts; fill in keywords later

    /**
     * One { title, url, key } per promo block, in document order. Tracked and
     * persisted by title, so the state file stays readable. The hero promo is
     * skipped so its change raises only the headline notification.
     */
    extract(html) {
      const lead = bbcZhongwen.headline.extract(html);
      const found = [];
      const seenKeys = new Set();
      for (const section of extractSectionsByClass(html, PROMO_CLASS, 'div')) {
        const item = promoTitle(section);
        if (!item) continue;

        const key = item.headline;
        if (seenKeys.has(key) || (lead && lead.url === item.url)) continue;
        seenKeys.add(key);
        found.push({ title: item.headline, url: item.url, key });
      }
      return found;
    },
  },
};
