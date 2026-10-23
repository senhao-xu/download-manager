import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const svg = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
const directory = new URL('../public/icons/', import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
  for (const size of [16, 24, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: fileURLToPath(new URL(`icon${size}.png`, directory)), omitBackground: true });
  }
} finally { await browser.close(); }
