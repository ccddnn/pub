/**
 * fetch.news.cn.mjs
 *
 * Watches the news.cn front page and raises a Windows notification when the
 * first <h1> changes or a watched article title appears. Polls every 5 minutes
 * by default; override with --t <minutes>.
 *
 * Run:  node fetch.news.cn.mjs --t 10
 *
 * The shared polling/notification logic lives in dispatch.mjs; what this site
 * watches lives in sites/news.cn.mjs.
 */

import { runWatcher } from './dispatch.mjs';
import { newsCn } from './sites/news.cn.mjs';

runWatcher(newsCn);
