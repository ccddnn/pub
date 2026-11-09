/**
 * sites/voachinese.mjs
 *
 * Site config for the VOA 中文 homepage. Watches the lead story — the first
 * "media-block" whose title carries the --size-1 modifier — and every
 * media-block title (an <h4> wrapped by the story link) as a watched article.
 * Each block links to its article twice (image and title), so titles are
 * deduplicated by url.
 */

import {
  extractLinks,
  extractSectionsByClass,
  firstLinkUrl,
  toText,
} from '../html.mjs';

const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.voachinese.com';
const BLOCK_CLASS = 'media-block';
const TITLE_CLASS = 'media-block__title';
const LEAD_MODIFIER = 'media-block__title--size-1';

/** First /a/ article link in a media block, or null. */
function articleUrl(section) {
  const link = extractLinks(section, SITE_URL).find(
    (candidate) => candidate.url && /\/a\//.test(candidate.url),
  );
  return link ? link.url : null;
}

/** { title, url } for one media block, or null when it has no title. */
function blockTitle(section) {
  const titleSection = extractSectionsByClass(section, TITLE_CLASS, 'h4')[0];
  if (!titleSection) return null;

  const title = toText(titleSection);
  if (!title) return null;
  return { title, url: firstLinkUrl(titleSection, SITE_URL) ?? articleUrl(section) };
}

export const voaChinese = {
  name: 'voachinese',
  url: SITE_URL,
  stateFile: 'last-headline.voachinese.json',
  requestTimeoutMs: 20_000,
  userAgent: 'news-watcher/1.0 (+node)',

  headline: {
    /** { headline, url } for the lead media block, or null when there is none. */
    extract(html) {
      const lead = extractSectionsByClass(html, BLOCK_CLASS, 'div').find((section) =>
        section.includes(LEAD_MODIFIER),
      );
      if (!lead) return null;

      const found = blockTitle(lead);
      if (!found) return null;
      return { headline: found.title, url: found.url };
    },
  },

  watchedTitles: {
    patterns: [], // empty = every article title counts; fill in keywords later

    /**
     * One { title, url, key } per media block, in document order. The lead
     * block is skipped so a lead change raises only the headline notification.
     */
    extract(html) {
      const lead = voaChinese.headline.extract(html);
      const found = [];
      const seenKeys = new Set();
      for (const section of extractSectionsByClass(html, BLOCK_CLASS, 'div')) {
        const item = blockTitle(section);
        if (!item) continue;

        const key = item.url ?? item.title;
        if (seenKeys.has(key) || (lead && lead.url === item.url)) continue;
        seenKeys.add(key);
        found.push({ ...item, key });
      }
      return found;
    },
  },
};
