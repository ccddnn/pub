/**
 * fetch.cn.nytimes.mjs
 *
 * Watches the NYT 中文 front page and raises a Windows notification when the
 * lead story changes or a new article title appears. Polls every 5 minutes by
 * default; override with --t <minutes>.
 *
 * Run:  node fetch.cn.nytimes.mjs --t 10
 *
 * The shared polling/notification logic lives in dispatch.mjs; what this site
 * watches lives in sites/cn.nytimes.mjs.
 */

import { runWatcher } from './dispatch.mjs';
import { cnNytimes } from './sites/cn.nytimes.mjs';

runWatcher(cnNytimes);
