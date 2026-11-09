/**
 * fetch.bbc.zhongwen.mjs
 *
 * Watches the BBC 中文（繁）front page and raises a Windows notification when
 * the hero story changes or a new article title appears. Polls every 5 minutes
 * by default; override with --t <minutes>.
 *
 * Run:  node fetch.bbc.zhongwen.mjs --t 10
 *
 * The shared polling/notification logic lives in dispatch.mjs; what this site
 * watches lives in sites/bbc.zhongwen.mjs.
 */

import { runWatcher } from './dispatch.mjs';
import { bbcZhongwen } from './sites/bbc.zhongwen.mjs';

runWatcher(bbcZhongwen);
