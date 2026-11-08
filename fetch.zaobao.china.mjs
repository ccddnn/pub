/**
 * fetch.zaobao.china.mjs
 *
 * Watches the Zaobao China section for new article titles and raises a Windows
 * notification for each one. Polls every 5 minutes by default; override with
 * --t <minutes>. The section has no headline to watch.
 *
 * Run:  node fetch.zaobao.china.mjs --t 10
 *
 * The shared polling/notification logic lives in dispatch.mjs; what this site
 * watches lives in sites/zaobao.china.mjs.
 */

import { runWatcher } from './dispatch.mjs';
import { zaobaoChina } from './sites/zaobao.china.mjs';

runWatcher(zaobaoChina);
