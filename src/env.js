// Tiny .env loader (no dependency). Existing environment variables win.
const fs = require('fs');
const path = require('path');

// Reads .env.local first, then .env, so .env.local wins over .env.
function loadEnv() {
  for (const name of ['.env.local', '.env']) loadFile(path.join(__dirname, '..', name));
}

function loadFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

module.exports = { loadEnv };
