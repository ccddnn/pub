/**
 * sites/cn.nytimes.mjs
 *
 * Site config for the NYT 中文 homepage. Watches the lead story in
 * <h2 class="leadHeadline"> for a headline change, and every <h3> that wraps a
 * link (lead sub-headline, regular summaries, opinion, slider items) as a
 * watched article title. Section labels are <h4>, so they are not picked up.
 */

import {
  extractSectionsByClass,
  extractSectionsByTag,
  extractLinks,
  firstLinkUrl,
  toText,
} from '../html.mjs';

const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://cn.nytimes.com';
const LEAD_CLASS = 'leadHeadline';

export const cnNytimes = {
  name: 'cn.nytimes',
  url: SITE_URL,
  stateFile: 'last-headline.cn.nytimes.json',
  requestTimeoutMs: 20_000,
  userAgent: 'news-watcher/1.0 (+node)',

  headline: {
    /** { headline, url } for the lead story, or null when there is none. */
    extract(html) {
      const section = extractSectionsByClass(html, LEAD_CLASS, 'h2')[0];
      if (!section) return null;

      const headline = toText(section);
      if (!headline) return null;
      return { headline, url: firstLinkUrl(section, SITE_URL) };
    },
  },

  watchedTitles: {
    patterns: [], // empty = every article title counts; fill in keywords later

    /**
     * One { title, url, key } per linked <h3>, in document order. Tracked and
     * persisted by title, so the state file stays readable; a headline edited
     * in place on the same article is reported once more. The lead story is
     * skipped so a headline change raises a single notification.
     */
    extract(html) {
      const lead = cnNytimes.headline.extract(html);
      const found = [];
      const seenKeys = new Set();
      for (const section of extractSectionsByTag(html, 'h3')) {
        const link = extractLinks(section, SITE_URL).find((candidate) => candidate.url);
        if (!link) continue;

        const title = toText(section);
        if (!title) continue;
        const key = title;
        if (seenKeys.has(key) || (lead && lead.url === link.url)) continue;
        seenKeys.add(key);
        found.push({ title, url: link.url, key });
      }
      return found;
    },
  },
};
