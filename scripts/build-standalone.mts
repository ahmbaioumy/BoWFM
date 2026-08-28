/**
 * Build a single self-contained HTML file (BoWFM.html) with no runtime files or CDN.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist-standalone');
const outFile = path.join(root, 'BoWFM.html');

execSync('npx vite build --config vite.standalone.config.ts', {
  cwd: root,
  stdio: 'inherit',
});

const htmlPath = path.join(distDir, 'index.html');
if (!existsSync(htmlPath)) {
  throw new Error(`Vite standalone build did not produce ${htmlPath}`);
}

let html = readFileSync(htmlPath, 'utf8');

html = html.replace(
  /<title>[\s\S]*?<\/title>/,
  '<title>Backoffice WFM Sizing Engine</title>'
);

html = html.replace(/<link[^>]+rel=["']modulepreload["'][^>]*>\s*/gi, '');

html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, (tag) => {
  const hrefMatch = tag.match(/href=["']([^"']+)["']/);
  if (!hrefMatch) return tag;
  const href = hrefMatch[1];
  if (/^https?:\/\//i.test(href)) {
    throw new Error(`Standalone build still references remote CSS: ${href}`);
  }
  const cssPath = path.join(distDir, href.replace(/^\.\//, ''));
  if (!existsSync(cssPath)) {
    throw new Error(`Missing CSS asset: ${cssPath}`);
  }
  const css = readFileSync(cssPath, 'utf8');
  return `<style>\n${css}\n</style>`;
});

html = html.replace(/<script([^>]*)><\/script>/gi, (full, attrs: string) => {
  const srcMatch = String(attrs).match(/src=["']([^"']+)["']/);
  if (!srcMatch) return full;
  const src = srcMatch[1];
  if (/^https?:\/\//i.test(src)) {
    throw new Error(`Standalone build still references remote JS: ${src}`);
  }
  const jsPath = path.join(distDir, src.replace(/^\.\//, ''));
  if (!existsSync(jsPath)) {
    throw new Error(`Missing JS asset: ${jsPath}`);
  }
  const js = readFileSync(jsPath, 'utf8');
  const isModule = /\stype=["']module["']/.test(attrs);
  const typeAttr = isModule ? ' type="module"' : '';
  return `<script${typeAttr}>\n${js}\n</script>`;
});

if (/src=["'][^"']+["']/.test(html) || /href=["']\.\/assets\//.test(html)) {
  throw new Error('Standalone HTML still has external asset references');
}
if (/https?:\/\/cdn|unpkg\.com|jsdelivr/i.test(html)) {
  throw new Error('Standalone HTML contains CDN references');
}

html = html.replace(
  '<head>',
  `<head>
    <!-- Self-contained offline build. Open this file directly. No npm/Node/network required. -->`
);

writeFileSync(outFile, html, 'utf8');
console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(1)} KB)`);
