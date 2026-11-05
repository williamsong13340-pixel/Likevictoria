// Generates one image with the OpenAI Images API from a self-describing prompt file:
//
//   ---
//   model: gpt-image-2.6-sunburst
//   size: 1536x1024
//   quality: high
//   ---
//   <prompt text>
//
// Usage: pnpm art --prompt-file <prompt.md> --out <image.webp>
// Paths are relative to the directory pnpm was started from. Generation has no seed: the prompt
// file reproduces the request, not the exact pixels.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const FORMATS = new Set(['png', 'jpeg', 'webp']);
const SETTINGS = ['model', 'size', 'quality'] as const;

const { values } = parseArgs({
  options: {
    'prompt-file': { type: 'string' },
    out: { type: 'string' },
  },
});

const promptFile = values['prompt-file'];
const out = values.out;
if (promptFile === undefined || out === undefined) {
  throw new Error('usage: pnpm art --prompt-file <prompt.md> --out <image.webp>');
}
const format = extname(out).slice(1).toLowerCase();
if (!FORMATS.has(format)) {
  throw new Error(`output extension must be one of: ${[...FORMATS].join(', ')}`);
}
const apiKey = process.env['OPENAI_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  throw new Error('OPENAI_API_KEY is not set');
}

const base = process.env['INIT_CWD'] ?? process.cwd();
const text = await readFile(resolve(base, promptFile), 'utf8');
const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
if (match === null) {
  throw new Error(`${promptFile} must start with front matter declaring ${SETTINGS.join(', ')}`);
}
const [, header = '', prompt = ''] = match;
const declared = new Map(
  header.split('\n').map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const;
  }),
);
const setting = (key: (typeof SETTINGS)[number]): string => {
  const value = declared.get(key);
  if (value === undefined || value === '') {
    throw new Error(`${promptFile}: front matter is missing "${key}"`);
  }
  return value;
};
const model = setting('model');
const size = setting('size');
const quality = setting('quality');

const response = await fetch('https://api.openai.com/v1/images/generations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    prompt: prompt.trim(),
    size,
    quality,
    output_format: format,
    n: 1,
  }),
});
if (!response.ok) {
  throw new Error(`OpenAI API ${String(response.status)}: ${await response.text()}`);
}
const body = (await response.json()) as { data?: { b64_json?: string }[] };
const image = body.data?.[0]?.b64_json;
if (image === undefined) {
  throw new Error('OpenAI API returned no image data');
}
const outPath = resolve(base, out);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, Buffer.from(image, 'base64'));
console.log(`saved ${out} (${model}, ${size}, ${quality})`);
