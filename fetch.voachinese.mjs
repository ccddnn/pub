/**
 * fetch.voachinese.mjs
 *
 * Watches the VOA 中文 front page and raises a Windows notification when the
 * lead story changes or a new article title appears. Polls every 5 minutes by
 * default; override with --t <minutes>.
 *
 * Run:  node fetch.voachinese.mjs --t 10
 *
 * The shared polling/notification logic lives in dispatch.mjs; what this site
 * watches lives in sites/voachinese.mjs.
 */

import { runWatcher } from './dispatch.mjs';
import { voaChinese } from './sites/voachinese.mjs';

runWatcher(voaChinese);
