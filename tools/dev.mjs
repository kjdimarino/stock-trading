/** Dev server: rebuilds the HTML from src/ on every request, so edits are live. */
import { buildHTML } from './bundle.mjs';
import { start } from '../src/server.mjs';

await start(() => buildHTML());
console.log('  (dev mode: sources are re-read from src/ on every page load)\n');
