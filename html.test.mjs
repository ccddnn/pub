/**
 * html.test.mjs
 *
 * Tests for the mirror-aware href resolution in html.mjs.
 *
 * Run:  node --test html.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLinks,
  extractSectionsByClass,
  firstLinkUrl,
  resolveHref,
} from './html.mjs';

const MIRROR = 'https://d1to4i8ztrmt01.cloudfront.net/https://example.com';
const MIRRORED = (path) => `https://d1to4i8ztrmt01.cloudfront.net/https://example.com${path}`;

test('task.md table rows', () => {
  assert.equal(resolveHref('https://example.com/abc/def', MIRROR), MIRRORED('/abc/def'));
  assert.equal(resolveHref('/abc/def', MIRROR), MIRRORED('/abc/def'));
});

test('relative hrefs resolve against the mirrored target site', () => {
  assert.equal(resolveHref('abc/def', MIRROR), MIRRORED('/abc/def'));
  assert.equal(resolveHref('//example.com/abc/def', MIRROR), MIRRORED('/abc/def'));
  assert.equal(resolveHref('?q=1', MIRROR), MIRRORED('/?q=1'));
});

test('absolute hrefs are mirrored, including third-party hosts', () => {
  assert.equal(
    resolveHref('https://other.com/x', MIRROR),
    'https://d1to4i8ztrmt01.cloudfront.net/https://other.com/x',
  );
});

test('an href already addressed through the mirror is not prefixed twice', () => {
  const href = 'https://d1to4i8ztrmt01.cloudfront.net/https://example.com/a';
  assert.equal(resolveHref(href, MIRROR), href);
});

test('entity-encoded query separators are decoded before mirroring', () => {
  assert.equal(resolveHref('?a=1&amp;b=2', MIRROR), MIRRORED('/?a=1&b=2'));
});

test('unsupported and empty hrefs resolve to null', () => {
  for (const href of ['javascript:void(0)', 'mailto:a@b.c', 'tel:+1', '#top', '', '   ']) {
    assert.equal(resolveHref(href, MIRROR), null, `expected null for ${JSON.stringify(href)}`);
  }
});

test('non-mirror bases keep plain URL semantics', () => {
  const base = 'https://example.com/news/';
  assert.equal(resolveHref('/abc', base), 'https://example.com/abc');
  assert.equal(resolveHref('https://example.com/x', base), 'https://example.com/x');
});

test('a mirror base with a path keeps the target path for relative hrefs', () => {
  const base = 'https://d1to4i8ztrmt01.cloudfront.net/https://www.zaobao.com/news/china';
  assert.equal(resolveHref('/world', base), 'https://d1to4i8ztrmt01.cloudfront.net/https://www.zaobao.com/world');
});

test('extractLinks returns attrs, inner, title and a mirrored url', () => {
  const html = '<a class="article-link" title="Tip" href="/abc/def">Hello</a>';
  const [link] = extractLinks(html, MIRROR);

  assert.equal(link.attrs, ' class="article-link" title="Tip" href="/abc/def"');
  assert.equal(link.inner, 'Hello');
  assert.equal(link.title, 'Tip');
  assert.equal(link.url, MIRRORED('/abc/def'));
});

test('links without an href keep a null url', () => {
  const [link] = extractLinks('<a name="anchor">x</a>', MIRROR);
  assert.equal(link.url, null);
});

test('firstLinkUrl resolves the first link, or null when there is none', () => {
  assert.equal(firstLinkUrl('<a href="/abc/def">t</a>', MIRROR), MIRRORED('/abc/def'));
  assert.equal(firstLinkUrl('<p>no links</p>', MIRROR), null);
});

test('extractSectionsByClass matches a class token in double or single quotes', () => {
  const html = '<div class="promo-text one">a</div><div class="two promo-text">b</div>';
  assert.deepEqual(extractSectionsByClass(html, 'promo-text'), ['a', 'b']);

  const single = "<div class='x promo-text'><div>inner</div></div>";
  assert.deepEqual(extractSectionsByClass(single, 'promo-text'), ['<div>inner</div>']);
});

test('extractSectionsByClass matches whole tokens only', () => {
  const html =
    '<div class="media-block-wrap">wrap</div>' +
    '<div class="media-block__title">title</div>' +
    '<div class="media-block media-block--io">block</div>';
  assert.deepEqual(extractSectionsByClass(html, 'media-block'), ['block']);
});

test('extractSectionsByClass honours the tag name and nesting', () => {
  const html =
    '<h3 class="t">a</h3><div class="t">b<div class="t">c</div>d</div>';
  assert.deepEqual(extractSectionsByClass(html, 't', 'h3'), ['a']);
  assert.deepEqual(extractSectionsByClass(html, 't'), ['b<div class="t">c</div>d', 'c']);
});

test('extractSectionsByClass ignores other attributes ending in class', () => {
  const html =
    '<div data-class="t">no</div><div aria-class="t">no</div>' +
    '<div id="x" class="t">yes</div>';
  assert.deepEqual(extractSectionsByClass(html, 't'), ['yes']);
});
