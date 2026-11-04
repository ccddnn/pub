// pruna.js — Interactive CLI for Pruna AI via Cloudflare Workers AI
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');

// Prefer IPv4 over IPv6 for all outgoing requests (fetch/undici). Some networks
// resolve hostnames to an IPv6 (AAAA) address first but cannot actually route
// IPv6, which makes fetch() fail with "fetch failed" / ECONNREFUSED. Reordering
// DNS results so IPv4 comes first avoids that.
dns.setDefaultResultOrder('ipv4first');

// Disable "Happy Eyeballs" dual-stack connection attempts. With autoSelectFamily
// enabled (the Node 20 default), fetch() tries the A and AAAA addresses in
// parallel; when both stall it surfaces an AggregateError with ETIMEOUT. Turning
// it off makes fetch() connect to a single resolved address (IPv4, per above),
// which both avoids the AggregateError and is more reliable on IPv4-only paths.
net.setDefaultAutoSelectFamily(false);

const { stdin, stdout } = process;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, '.config.txt');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = {};
      for (const line of fs.readFileSync(CONFIG_PATH, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      return config;
    }
  } catch (err) {
    console.error('Error reading config:', err);
  }
  return {};
}

function saveConfig(config) {
  const lines = Object.entries(config)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(CONFIG_PATH, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// History (prompts and media URLs, each with their own file)
// ---------------------------------------------------------------------------
const HISTORY_MAX = 50;
const HISTORY_PATHS = {
  prompt: path.join(__dirname, '.prompt-history.txt'),
  image: path.join(__dirname, '.image-history.txt'),
  video: path.join(__dirname, '.video-history.txt'),
  audio: path.join(__dirname, '.audio-history.txt'),
};

function loadHistory(type = 'prompt') {
  try {
    const file = HISTORY_PATHS[type];
    if (file && fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch (err) {
    console.error(`Error reading ${type} history:`, err);
  }
  return [];
}

function saveHistory(type = 'prompt', history) {
  fs.writeFileSync(HISTORY_PATHS[type], history.slice(0, HISTORY_MAX).join('\n') + '\n');
}

function recordHistory(type, value) {
  // Media history only stores http(s) URLs, not base64 data URIs.
  if (type !== 'prompt' && !/^https?:\/\//i.test(value)) return;
  const history = loadHistory(type).filter((item) => item !== value);
  history.unshift(value);
  saveHistory(type, history);
}

// ---------------------------------------------------------------------------
// Interactive primitives
// ---------------------------------------------------------------------------
let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

// Simple text question
function question(prompt) {
  return new Promise((resolve) => {
    getRl().question(prompt, (answer) => resolve(answer));
  });
}

// Arrow-key selection menu (wrapped as a Promise)
function selectMenu({ prompt, choices, defaultValue, quiet = false }) {
  return new Promise((resolve) => {
    const iface = getRl();
    iface.pause();
    readline.emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume();

    let selectedIndex = choices.indexOf(defaultValue);
    if (selectedIndex < 0) selectedIndex = 0;

    function render() {
      console.clear();
      console.log(prompt + '\n');
      choices.forEach((choice, index) => {
        if (index === selectedIndex) {
          console.log(`\x1b[36m❯ ${choice}\x1b[0m`);
        } else {
          console.log(`  ${choice}`);
        }
      });
      console.log('\nPress ↑/↓ to move, Enter to confirm, Ctrl+C to cancel');
    }

    function cleanup() {
      stdin.removeListener('keypress', onKeypress);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      stdin.pause();
      iface.resume();
    }

    function onKeypress(str, key) {
      if (key.ctrl && key.name === 'c') {
        console.log('\nCancelled');
        process.exit(1);
      }
      switch (key.name) {
        case 'up':
          selectedIndex = Math.max(0, selectedIndex - 1);
          render();
          break;
        case 'down':
          selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
          render();
          break;
        case 'return':
          cleanup();
          if (!quiet) console.log(`\nSelected: ${choices[selectedIndex]}\n`);
          resolve(choices[selectedIndex]);
          break;
      }
    }

    stdin.on('keypress', onKeypress);
    render();
  });
}

// ---------------------------------------------------------------------------
// Model + parameter metadata (descriptions from the model docs)
// ---------------------------------------------------------------------------
const MODELS = {
  'p-image-edit': {
    name: 'pruna/p-image-edit',
    outputKey: 'image',
    params: [
      {
        name: 'prompt', type: 'string', required: true,
        description: 'Text instruction describing the desired edit or composition.',
      },
      {
        name: 'images', type: 'array', required: true, minItems: 1, maxItems: 5, media: 'image',
        description: '1-5 reference images. Each entry is an HTTP(S) URL or a base64 data URI (data:image/...;base64,...).',
      },
      {
        name: 'turbo', type: 'boolean', required: true, default: false,
        description: 'Run faster with additional optimizations. For complicated tasks, it is recommended to turn this off.',
      },
      {
        name: 'aspect_ratio', type: 'enum', required: true, default: 'match_input_image',
        enum: ['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
        description: 'Output aspect ratio.',
      },
      {
        name: 'seed', type: 'integer', required: false,
        min: -9007199254740991, max: 9007199254740991,
        description: 'Random seed for reproducible generation.',
      },
      {
        name: 'disable_safety_checker', type: 'boolean', required: true, default: true,
        description: 'Disable safety checker for generated images.',
      },
    ],
  },

  'p-video': {
    name: 'pruna/p-video',
    outputKey: 'video',
    params: [
      {
        name: 'prompt', type: 'string', required: true,
        description: 'Text prompt for video generation.',
      },
      {
        name: 'image', type: 'string', required: false, media: 'image',
        description: 'Input image to generate video from (image-to-video). HTTP(S) URL or data URI. Supports jpg, jpeg, png, webp. When provided, aspect_ratio is ignored.',
      },
      {
        name: 'audio', type: 'string', required: false, media: 'audio',
        description: 'Input audio to condition video generation. HTTP(S) URL or data URI. Supports flac, mp3, wav. When provided, duration is ignored.',
      },
      {
        name: 'duration', type: 'integer', required: true, default: 5, min: 1, max: 20,
        description: 'Duration of the video in seconds (1-20). Ignored when audio is provided.',
      },
      {
        name: 'resolution', type: 'enum', required: true, default: '720p',
        enum: ['720p', '1080p'],
        description: 'Video resolution.',
      },
      {
        name: 'fps', type: 'enum', required: true, default: 48,
        enum: [24, 48],
        description: 'Frames per second: 24 or 48.',
      },
      {
        name: 'aspect_ratio', type: 'enum', required: true, default: '16:9',
        enum: ['16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '1:1'],
        description: 'Aspect ratio of the video. Ignored when an input image is provided.',
      },
      {
        name: 'seed', type: 'integer', required: false,
        min: -9007199254740991, max: 9007199254740991,
        description: 'Random seed for reproducible generation.',
      },
      {
        name: 'draft', type: 'boolean', required: true, default: false,
        description: 'Draft mode. Generates a lower-quality preview of the video.',
      },
      {
        name: 'save_audio', type: 'boolean', required: true, default: false,
        description: 'Save the video with audio.',
      },
      {
        name: 'last_frame_image', type: 'string', required: false, media: 'image',
        description: 'Reference image for the last frame of the video. HTTP(S) URL or data URI.',
      },
      {
        name: 'prompt_upsampling', type: 'boolean', required: true, default: true,
        description: 'Use prompt upsampling to enhance the prompt.',
      },
      {
        name: 'disable_safety_filter', type: 'boolean', required: true, default: true,
        description: 'Disable safety filter for prompts and input images.',
      },
    ],
  },

  'p-video-replace': {
    name: 'pruna/p-video-replace',
    outputKey: 'video',
    params: [
      {
        name: 'video', type: 'string', required: true, media: 'video',
        description: 'Source RGB video (.mp4) used as the motion and audio source. HTTP(S) URL or data URI.',
      },
      {
        name: 'images', type: 'array', required: true, minItems: 1, maxItems: 3, media: 'image',
        description: 'Identity reference image(s), 1 to 3, to place into the video. Each entry is an HTTP(S) URL or a data URI.',
      },
      {
        name: 'turbo', type: 'boolean', required: true, default: false,
        description: 'Turbo mode: faster generation for slightly lower quality.',
      },
      {
        name: 'resolution', type: 'enum', required: true, default: '720p',
        enum: ['720p', '1080p'],
        description: 'Target resolution.',
      },
      {
        name: 'save_audio', type: 'boolean', required: true, default: false,
        description: 'Save the video with audio.',
      },
      {
        name: 'ignore_audio', type: 'boolean', required: true, default: true,
        description: 'Ignore source audio during generation.',
      },
      {
        name: 'target_fps', type: 'enum', required: true, default: 'original',
        enum: [24, 48, 'original'],
        description: 'Target FPS for the working video.',
      },
      {
        name: 'instruction_prompt', type: 'string', required: true, default: '',
        description: 'Further instruction on how to place people from the reference images into the scene.',
      },
      {
        name: 'seed', type: 'integer', required: false,
        min: -9007199254740991, max: 9007199254740991,
        description: 'Random seed for reproducible generation.',
      },
      {
        name: 'disable_safety_checker', type: 'boolean', required: true, default: true,
        description: 'Disable safety checker for generated videos.',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Parameter prompters
// ---------------------------------------------------------------------------
async function promptBoolean(param) {
  const hint = param.default ? 'Y/n' : 'y/N';
  const answer = await question(`${param.description} [${hint}]: `);
  if (answer.trim() === '') return param.default;
  const a = answer.trim().toLowerCase();
  if (['y', 'yes', 'true'].includes(a)) return true;
  if (['n', 'no', 'false'].includes(a)) return false;
  console.log('  Invalid input, please answer y or n.');
  return promptBoolean(param);
}

async function promptInteger(param) {
  const hasDefault = param.default !== undefined;
  const range = (param.min !== undefined && param.max !== undefined)
    ? ` (${param.min}-${param.max})` : '';
  const hint = hasDefault ? ` [default: ${param.default}]` : ' [Enter to skip]';
  const answer = await question(`${param.description}${range}${hint}: `);
  if (answer.trim() === '') return hasDefault ? param.default : null;
  const n = Number(answer.trim());
  if (!Number.isInteger(n)) {
    console.log('  Please enter an integer.');
    return promptInteger(param);
  }
  if (param.min !== undefined && n < param.min) {
    console.log(`  Minimum is ${param.min}.`);
    return promptInteger(param);
  }
  if (param.max !== undefined && n > param.max) {
    console.log(`  Maximum is ${param.max}.`);
    return promptInteger(param);
  }
  return n;
}

const TYPE_NEW = '✍️  Type new prompt';

async function promptString(param) {
  const hasDefault = param.default !== undefined;
  const hint = hasDefault
    ? ` [default: ${param.default || '(empty)'}]`
    : (param.required ? '' : ' [Enter to skip]');

  const history = loadHistory('prompt');
  if (history.length) {
    const choice = await selectMenu({
      prompt: `${param.description} — select a saved prompt or type a new one`,
      choices: [TYPE_NEW, ...history],
      defaultValue: TYPE_NEW,
      quiet: true,
    });
    if (choice !== TYPE_NEW) {
      recordHistory('prompt', choice);
      return choice;
    }
  }

  const answer = await question(`${param.description}${hint}: `);
  if (answer.trim() === '') {
    if (hasDefault) return param.default;
    if (!param.required) return null;
    console.log('  This field is required.');
    return promptString(param);
  }
  const value = answer.trim();
  recordHistory('prompt', value);
  return value;
}

async function promptEnum(param) {
  return selectMenu({
    prompt: `${param.name} — ${param.description}`,
    choices: param.enum,
    defaultValue: param.default,
  });
}

const ARRAY_SKIP = '⏭  Skip — omit this array';

// First step of array input: pick how many items there will be (1..max), with
// Enter (the default) skipping the array entirely.
async function promptArrayCount(param) {
  const min = param.minItems || 0;
  const max = param.maxItems;
  const upper = Number.isFinite(max) ? max : 10;
  const start = Math.max(1, min);
  const counts = [];
  for (let n = start; n <= upper; n++) counts.push(String(n));
  const choice = await selectMenu({
    prompt: `${param.description}\n\nHow many items? (Enter to skip)`,
    choices: [ARRAY_SKIP, ...counts],
    defaultValue: ARRAY_SKIP,
    quiet: true,
  });
  return choice === ARRAY_SKIP ? null : Number(choice);
}

async function promptArray(param) {
  const count = await promptArrayCount(param);
  if (count === null) return null;
  const items = [];
  for (let i = 0; i < count; i++) {
    const answer = await question(`  Item ${i + 1}/${count}: `);
    if (answer.trim() === '') {
      console.log('  This item is required.');
      i--;
      continue;
    }
    items.push(answer.trim());
  }
  return items;
}

// Offer saved history (if any) or fall back to a plain text prompt. Returns the
// chosen/typed trimmed value, or '' when the user typed an empty answer.
async function pickMediaValue(param) {
  const type = param.media;
  const history = loadHistory(type);
  if (history.length) {
    const choice = await selectMenu({
      prompt: `${param.description} — select a saved ${type} URL or type a new one`,
      choices: [TYPE_NEW, ...history],
      defaultValue: TYPE_NEW,
      quiet: true,
    });
    if (choice !== TYPE_NEW) {
      recordHistory(type, choice);
      return choice;
    }
  }
  const hasDefault = param.default !== undefined;
  const hint = hasDefault
    ? ` [default: ${param.default || '(empty)'}]`
    : (param.required ? '' : ' [Enter to skip]');
  return (await question(`${param.description}${hint}: `)).trim();
}

// Single media field: image, audio, video, last_frame_image.
async function promptMediaString(param) {
  const value = await pickMediaValue(param);
  if (value === '') {
    if (param.default !== undefined) return param.default;
    if (!param.required) return null;
    console.log('  This field is required.');
    return promptMediaString(param);
  }
  recordHistory(param.media, value);
  return value;
}

// Multi-item media array: the `images` fields.
async function promptMediaArray(param) {
  const count = await promptArrayCount(param);
  if (count === null) return null;
  const type = param.media;
  const items = [];
  for (let i = 0; i < count; i++) {
    const history = loadHistory(type);
    const choices = [TYPE_NEW, ...history];
    const choice = await selectMenu({
      prompt: `${type} ${i + 1} of ${count} — pick a saved URL or type a new one`,
      choices,
      defaultValue: TYPE_NEW,
      quiet: true,
    });

    if (choice !== TYPE_NEW) {
      recordHistory(type, choice);
      items.push(choice);
      continue;
    }

    const answer = await question(`  ${type} URL: `);
    if (answer.trim() === '') {
      console.log('  This item is required.');
      i--;
      continue;
    }
    recordHistory(type, answer.trim());
    items.push(answer.trim());
  }
  return items;
}

async function promptParam(param) {
  if (param.media) {
    return param.type === 'array' ? promptMediaArray(param) : promptMediaString(param);
  }
  switch (param.type) {
    case 'enum': return promptEnum(param);
    case 'boolean': return promptBoolean(param);
    case 'integer': return promptInteger(param);
    case 'string': return promptString(param);
    case 'array': return promptArray(param);
    default: return promptString(param);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Cloudflare credentials
// ---------------------------------------------------------------------------
async function ensureConfig(config) {
  const accountId = config.cloudflareAccountId;
  const apiToken = config.cloudflareApiToken;

  if (accountId && apiToken) {
    console.log(`Using saved CLOUDFLARE_ACCOUNT_ID: ${accountId}`);
    console.log(`Using saved CLOUDFLARE_API_TOKEN: ${apiToken}`);
    return { accountId, apiToken };
  }

  console.log('Enter your Cloudflare credentials (saved to .config.txt for next time):');
  const id = await question('  CLOUDFLARE_ACCOUNT_ID: ');
  const token = await question('  CLOUDFLARE_API_TOKEN: ');
  config.cloudflareAccountId = id.trim();
  config.cloudflareApiToken = token.trim();
  saveConfig(config);
  console.log('  Saved to .config.txt\n');
  return { accountId: id.trim(), apiToken: token.trim() };
}

// ---------------------------------------------------------------------------
// Step 5: download the result
// ---------------------------------------------------------------------------
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

async function download(url, model) {
  console.log('Downloading:', url);
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Download failed:', res.status, res.statusText);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  let ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) {
    ext = path.extname(new URL(url).pathname) || '.bin';
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const slug = model.split('/').pop();
  const file = path.join(outDir, `${slug}-${Date.now()}${ext}`);
  fs.writeFileSync(file, buf);
  console.log(`Saved to ${file}`);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main() {
  try {
    console.log('Pruna AI CLI\n');

    // Step 1
    const config = loadConfig();
    const { accountId, apiToken } = await ensureConfig(config);

    // Step 2
    const model = await selectMenu({
      prompt: 'Select a model',
      choices: Object.keys(MODELS),
    });

    // Step 3
    console.log(`\nConfigure parameters for ${model}:`);
    const input = {};
    for (const param of MODELS[model].params) {
      const value = await promptParam(param);
      if (value !== null && value !== undefined) input[param.name] = value;
    }

    console.log('\nRequest payload:', JSON.stringify({ model: MODELS[model].name, input }, null, 2));

    // Step 4 (no timeout — video generation can take minutes)
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
    console.log('\nCalling API (video can take minutes; waiting without timeout)...');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODELS[model].name, input }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error('API error:', JSON.stringify(json, null, 2));
      process.exit(1);
    }

    // Cloudflare returns a nested result: { result: { state, result: { <output> } } }.
    const outer = json.result || {};
    if (outer.state !== 'Completed') {
      console.error('API error:', JSON.stringify(json, null, 2));
      process.exit(1);
    }

    const inner = outer.result || {};
    const url = inner[MODELS[model].outputKey];
    if (!url) {
      console.error('No result URL in response:', JSON.stringify(json, null, 2));
      process.exit(1);
    }

    // Step 5
    await download(url, model);

    getRl().close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
