// Unmodified supplied platform marks, composed and rasterized locally with the existing Playwright dependency.
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
let svg = await readFile(resolve(root, 'assets/icon.svg'), 'utf8');
for (const name of ['facebook', 'instagram', 'youtube']) {
  const bytes = await readFile(resolve(root, `public/brands/${name}.svg`));
  svg = svg.replace(
    `../public/brands/${name}.svg`,
    `data:image/svg+xml;base64,${bytes.toString('base64')}`,
  );
}
const out = resolve(root, 'public/icons');
await mkdir(out, { recursive: true });
await mkdir(resolve(root, 'docs/images'), { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    const artSize = size;
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:grid;place-items:center}svg{width:${artSize}px;height:${artSize}px}</style>${svg}`,
    );
    await page.screenshot({ path: resolve(out, `${size}.png`), omitBackground: true });
  }
  await page.setViewportSize({ width: 720, height: 420 });
  const tiles = await Promise.all(
    [16, 32, 48, 128].map(async (size) => {
      const png = await readFile(resolve(out, `${size}.png`));
      return `<figure><img width="${size}" height="${size}" src="data:image/png;base64,${png.toString('base64')}"><figcaption>${size} px</figcaption></figure>`;
    }),
  );
  await page.setContent(
    `<style>body{margin:0;font:14px system-ui}section{height:210px;display:flex;align-items:center;justify-content:space-around}section:first-child{background:#fff;color:#193d73}section:last-child{background:#202124;color:#fff}figure{width:144px;margin:0;text-align:center}figcaption{margin-top:18px}img{vertical-align:middle}</style><section>${tiles.join('')}</section><section>${tiles.join('')}</section>`,
  );
  await page.screenshot({ path: resolve(root, 'docs/images/icon-sizes.png') });
} finally {
  await browser.close();
}
console.log('icons: 16/32/48/128.png + docs/images/icon-sizes.png');
