
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;

const ignored = new Set([
  'node_modules',
  '.git',
  'data',
  'storage'
]);

const replacements = [
  [/Elite Services/g, 'Elite Services'],
  [/elite-services-api/g, 'elite-services-api']
];

let changed = 0;

function processDirectory(directory) {
  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) {
        processDirectory(path.join(directory, entry.name));
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const file = path.join(directory, entry.name);
    let content = fs.readFileSync(file, 'utf8');
    const original = content;

    for (const [pattern, replacement] of replacements) {
      content = content.replace(pattern, replacement);
    }

    if (content !== original) {
      fs.writeFileSync(file, content, 'utf8');
      console.log(`Updated: ${path.relative(root, file)}`);
      changed++;
    }
  }
}

console.log('Elite Services branding update starting...\n');

processDirectory(root);

console.log(`\nFinished. Updated ${changed} JavaScript file(s).`);
console.log('Existing database paths and nexus: interaction IDs were preserved.');
