#!/usr/bin/env node
// Bump the app version everywhere it appears, so a release stays consistent.
//   Usage:  node bump-version.mjs <major.minor.patch>     e.g. node bump-version.mjs 2.0.6
// Updates: APP_VERSION (app.js); and in index.html the <meta vardiko-version>,
// every ?v= cache-buster (core.js / app.js / styles.css), and the visible label.
import { readFileSync, writeFileSync } from 'node:fs';

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('Usage: node bump-version.mjs <major.minor.patch>   (e.g. 2.0.6)');
  process.exit(1);
}

const appURL = new URL('./app.js', import.meta.url);
let app = readFileSync(appURL, 'utf8');
const appNext = app.replace(/const APP_VERSION = '[\d.]+';/, `const APP_VERSION = '${next}';`);
if (appNext === app) { console.error('APP_VERSION not found in app.js'); process.exit(1); }
writeFileSync(appURL, appNext);

const htmlURL = new URL('./index.html', import.meta.url);
const html = readFileSync(htmlURL, 'utf8')
  .replace(/(<meta name="vardiko-version" content=")[\d.]+(">)/, `$1${next}$2`)
  .replace(/(\?v=)[\d.]+/g, `$1${next}`)
  .replace(/(id="appVersion">v)[\d.]+(<)/, `$1${next}$2`);
writeFileSync(htmlURL, html);

console.log(`Bumped to ${next}. Now commit + push to ship it.`);
