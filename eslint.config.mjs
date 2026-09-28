// ESLint 9 flat config used only by CI's `npm run lint:inline`.
// Lints the extracted main inline <script> from index.html
// (.lint-tmp/app.js, written by scripts/lint-inline.js) for real
// no-undef / rules-of-hooks bugs. Never touched by the runtime app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const globalsFile = path.join(__dirname, '.lint-tmp', 'globals.json');
let windowGlobals = [];
try {
  windowGlobals = JSON.parse(fs.readFileSync(globalsFile, 'utf8'));
} catch (e) {
  // scripts/lint-inline.js hasn't run yet; CI always runs it first.
}

const windowGlobalsMap = Object.fromEntries(windowGlobals.map((n) => [n, 'readonly']));

export default [
  {
    files: ['.lint-tmp/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...windowGlobalsMap,
        React: 'readonly',
        ReactDOM: 'readonly',
        THREE: 'readonly',
        JSZip: 'readonly',
        pdfjsLib: 'readonly',
        htm: 'readonly',
        html: 'readonly',
      },
    },
    plugins: { 'react-hooks': hooks },
    rules: {
      'no-undef': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
