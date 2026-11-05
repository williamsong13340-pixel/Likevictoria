// Generates one image with the OpenAI Images API.
// Usage: pnpm art --prompt-file <prompt.md> --out <image.webp> [--size 1536x1024] [--quality high]
// The prompt file is kept next to the output so every image can be reproduced.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { parseArgs } from 'node:util';

const MODEL = 'gpt-image-2.6-sunburst';
const FORMATS = new Set(['png', 'jpeg', 'webp']);

const { values } = parseArgs({
  options: {
    'prompt-file': { type: 'string' },
    out: { type: 'string' },
    size: { type: 'string', default: '1536x1024' },
    quality: { type: 'string', default: 'high' },
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

const prompt = (await readFile(promptFile, 'utf8')).trim();
const response = await fetch('https://api.openai.com/v1/images/generations', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    prompt,
    size: values.size,
    quality: values.quality,
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
await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(image, 'base64'));
console.log(`saved ${out} (${MODEL}, ${values.size}, ${values.quality})`);
