/**
 * dispatch.test.mjs
 *
 * Tests for how new arrivals are turned into a notification: the message
 * shape, and the toast XML that shape is rendered into.
 *
 * Run:  node --test dispatch.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToastXml, newItemsMessage } from './dispatch.mjs';

const links = (count) =>
  Array.from({ length: count }, (_, i) => ({
    title: `标题 ${i + 1}`,
    url: `https://example.com/${i + 1}`,
  }));

/**
 * Every <text> element's content, in order.
 *
 * The toast shows only the first few <text> elements (measured: title + 2
 * more render, the rest are dropped) but keeps newlines inside one element
 * (measured: 4 body lines fit before the toast height clips the rest). So the
 * whole body has to be a single element.
 */
const toastTexts = (xml) =>
  [...xml.matchAll(/<text>([\s\S]*?)<\/text>/g)].map((m) => m[1]);

test('a single arrival keeps its own title and link', () => {
  const message = newItemsMessage('zaobao.china', links(1));
  assert.equal(message.title, '标题 1');
  assert.equal(message.url, 'https://example.com/1');
  assert.equal(message.lines.length, 1);
});

test('several arrivals become one grouped message', () => {
  const message = newItemsMessage('zaobao.china', links(2));
  assert.equal(message.title, '2 new items on zaobao.china');
  assert.equal(message.url, null);
  assert.deepEqual(message.lines, ['• 标题 1', '• 标题 2']);
});

test('grouped messages fit the three body lines a toast can show', () => {
  for (const [count, expected] of [
    [3, ['• 标题 1', '• 标题 2', '• 标题 3']],
    [4, ['• 标题 1', '• 标题 2', '… and 2 more']],
    [9, ['• 标题 1', '• 标题 2', '… and 7 more']],
  ]) {
    const message = newItemsMessage('voachinese', links(count));
    assert.deepEqual(message.lines, expected);
    assert.equal(message.title, `${count} new items on voachinese`);
  }
});

test('the body is one <text> element with newline-separated lines', () => {
  const message = newItemsMessage('zaobao.china', links(3));
  const texts = toastTexts(buildToastXml(message));
  assert.equal(texts.length, 2, 'expected a title element and one body element');
  assert.deepEqual(texts, ['3 new items on zaobao.china', message.lines.join('\n')]);
});

test('no toast ever needs more than two <text> elements', () => {
  for (const count of [1, 2, 3, 4, 20]) {
    const texts = toastTexts(buildToastXml(newItemsMessage('voachinese', links(count))));
    assert.ok(texts.length <= 2, `${count} items produced ${texts.length} text elements`);
  }
});

test('grouped bodies stay within the toast height', () => {
  // Measured on Windows 10: a fourth body line is clipped off the toast.
  for (const count of [2, 3, 4, 20]) {
    const message = newItemsMessage('voachinese', links(count));
    assert.ok(message.lines.length <= 3, `${count} items produced ${message.lines.length} lines`);
  }
});

test('toast text and attributes are XML-escaped', () => {
  const xml = buildToastXml({
    title: 'A & B <c>',
    lines: ['"quoted" & <tagged>'],
    url: 'https://example.com/x?a=1&b=2',
  });
  assert.ok(xml.includes('A &amp; B &lt;c&gt;'));
  assert.ok(xml.includes('&quot;quoted&quot; &amp; &lt;tagged&gt;'));
  assert.ok(xml.includes('launch="https://example.com/x?a=1&amp;b=2"'));
});

test('only a single-item toast carries a launch url', () => {
  const single = buildToastXml(newItemsMessage('s', links(1)));
  const grouped = buildToastXml(newItemsMessage('s', links(2)));
  assert.match(single, /activationType="protocol"/);
  assert.doesNotMatch(grouped, /activationType="protocol"/);
});
