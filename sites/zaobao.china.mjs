/**
 * sites/zaobao.china.mjs
 *
 * Site config for the Zaobao China section. The page has no headline to watch;
 * each <article> carries one story whose title is the <div> inside
 * <a class="article-link"> (the sibling <div> holds the timestamp, so it is
 * skipped).
 */

import {
  extractLinks,
  extractSectionsByTag,
  hasClass,
  toText,
} from '../html.mjs';

const SITE_URL = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.zaobao.com/news/china';
const ARTICLE_LINK_CLASS = 'article-link';
const TITLE_DIV_RE = /<div\b[^>]*>([\s\S]*?)<\/div>/i;

export const zaobaoChina = {
  name: 'zaobao.china',
  url: SITE_URL,
  stateFile: 'last-headline.zaobao.china.json',
  requestTimeoutMs: 20_000,
  userAgent: 'news-watcher/1.0 (+node)',

  headline: null,

  watchedTitles: {
    patterns: [], // empty = every article title counts; fill in keywords later

    /** One { title, url, key } per <article>, in document order. */
    extract(html) {
      const found = [];
      const seenTitles = new Set();
      for (const article of extractSectionsByTag(html, 'article')) {
        const link = extractLinks(article, SITE_URL).find((candidate) =>
          hasClass(candidate.attrs, ARTICLE_LINK_CLASS),
        );
        if (!link) continue;

        const div = TITLE_DIV_RE.exec(link.inner);
        const title = (div ? toText(div[1]) : '') || toText(link.inner) || link.title;
        if (!title || seenTitles.has(title)) continue;
        seenTitles.add(title);
        found.push({ title, url: link.url, key: title });
      }
      return found;
    },
  },
};
