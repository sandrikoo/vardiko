const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);

if (!scriptMatch) {
  throw new Error('Inline app script was not found');
}

new Function(scriptMatch[1]);

const requiredIds = [
  'mainCanvas',
  'stage',
  'stageInner',
  'emptyState',
  'handlesOverlay',
  'notesList',
  'topMsg',
];

for (const id of requiredIds) {
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Missing required DOM id: ${id}`);
  }
}

if (!html.includes('APP_VERSION')) {
  throw new Error('APP_VERSION marker is missing');
}

if (!html.includes('🚨 𝗖𝗥𝗔𝗭𝗬 𝗙𝗔𝗖𝗧:')) {
  throw new Error('Expected notes snippet is missing');
}

console.log('smoke test ok');
