// npm run check:secrets: fails if a tracked file looks like it holds a real secret, or if an .env file is tracked.
// Matches are reported as file:line with the value masked.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @type {[string, RegExp][]} */
const PATTERNS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{24,}/],
  ['Assigned secret', /(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)\w*\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{24,}/],
];
const SKIP_FILES = /(^|\/)(package-lock\.json|.*\.(png|jpg|jpeg|gif|ico|joblib|woff2?|zip|bundle|pdf))$/;
// Fixtures and documentation use obvious placeholders; real code and config do not get this pass.
const PLACEHOLDER_PATHS = /^(tests\/|ml\/tests\/|docs?\/)/;

/** @param {string} path @param {string} text */
export function scanText(path, text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const [label, pattern] of PATTERNS) {
      if (label === 'Assigned secret' && PLACEHOLDER_PATHS.test(path)) continue;
      const match = pattern.exec(line);
      if (match) hits.push({ path, line: index + 1, label, preview: `${match[0].slice(0, 4)}…(${match[0].length} chars)` });
    }
  });
  return hits;
}

export function scanTracked(root = '.') {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z']).toString().split('\0').filter(Boolean);
  const problems = files.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example')).map((path) => ({ path, line: 0, label: 'Environment file is tracked', preview: '' }));
  for (const file of files) {
    if (SKIP_FILES.test(file)) continue;
    const full = `${root}/${file}`;
    if (statSync(full).size > 1_000_000) continue;
    const text = readFileSync(full, 'utf8');
    if (text.includes('\0')) continue;
    problems.push(...scanText(file, text));
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = scanTracked();
  for (const p of problems) console.error(`${p.path}:${p.line}  ${p.label} ${p.preview}`);
  console.log(problems.length ? `${problems.length} possible secret(s) found.` : 'No secrets found in tracked files.');
  process.exit(problems.length ? 1 : 0);
}
