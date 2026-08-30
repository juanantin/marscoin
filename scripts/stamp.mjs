#!/usr/bin/env node
/* ==========================================================================
   Cache-buster stamp
   --------------------------------------------------------------------------
   index.html loads styles.css, config.js and app.js with a ?v= query, and a
   CDN keys its cache on the full URL. Change a stylesheet without changing
   that query and browsers keep serving the old one — the change is pushed,
   deployed, and invisible.

   Run this as the last step before every deploy:

     node scripts/stamp.mjs            # today's date, next free suffix
     node scripts/stamp.mjs 2026-09-01.1

   It rewrites every ?v= in index.html and the matching `version:` in
   config.js, so the ?debug=1 panel names the build a browser actually has.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');
const CONFIG = path.join(ROOT, 'config.js');

const html = fs.readFileSync(HTML, 'utf8');
const config = fs.readFileSync(CONFIG, 'utf8');

const current = (html.match(/\?v=([\w.-]+)/) || [])[1] || '';

function nextStamp() {
  const today = new Date().toISOString().slice(0, 10);
  // Same day as the current stamp? Take the next suffix rather than clashing.
  const [day, n] = current.split(/\.(?=\d+$)/);
  return day === today ? `${today}.${Number(n || 0) + 1}` : `${today}.1`;
}

const stamp = process.argv[2] || nextStamp();

if (!/^[\w.-]+$/.test(stamp)) {
  console.error(`Refusing to write "${stamp}" — a stamp goes in a URL query, so keep it to letters, digits, dots and dashes.`);
  process.exit(1);
}

if (stamp === current) {
  console.error(`Stamp is already ${stamp}. Pass a different one, or let the script pick.`);
  process.exit(1);
}

const stampedHtml = html.replace(/\?v=[\w.-]+/g, `?v=${stamp}`);
const stampedConfig = config.replace(/(\n\s*version:\s*)'[^']*'/, `$1'${stamp}'`);

const hits = (html.match(/\?v=[\w.-]+/g) || []).length;
if (!hits) {
  console.error('No ?v= found in index.html — nothing to stamp, which is itself a bug.');
  process.exit(1);
}
if (stampedConfig === config) {
  console.error("No `version:` found in config.js — the debug panel would report the wrong build.");
  process.exit(1);
}

fs.writeFileSync(HTML, stampedHtml);
fs.writeFileSync(CONFIG, stampedConfig);
console.log(`${current || '(none)'} → ${stamp}   (${hits} URLs in index.html, plus config.js version)`);
