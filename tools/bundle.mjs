/** Inlines the app's CSS and JS into one self-contained HTML document. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src/app');

const readDirSorted = (dir, ext) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort()
      .map((f) => ({ name: f, code: fs.readFileSync(path.join(dir, f), 'utf8') }))
    : [];

export function buildHTML() {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const css = readDirSorted(path.join(APP, 'css'), '.css');
  const js = readDirSorted(path.join(APP, 'js'), '.js');

  const styleTag = '<style>\n' + css.map((f) => `/* ${f.name} */\n${f.code}`).join('\n') + '\n</style>';
  const scriptTag = js.map((f) => `<script>\n/* ${f.name} */\n${f.code}\n</script>`).join('\n');

  if (!html.includes('<!--INLINE_CSS-->') || !html.includes('<!--INLINE_JS-->')) {
    throw new Error('index.html is missing an <!--INLINE_CSS--> or <!--INLINE_JS--> placeholder');
  }
  /*
   * Replacer FUNCTIONS, not strings. A string replacement treats $&, $`, $' and
   * $1 as special patterns, and our code is full of literal '$' characters — a
   * plain string replace silently eats them and corrupts the bundle.
   */
  return html
    .replace('<!--INLINE_CSS-->', () => styleTag)
    .replace('<!--INLINE_JS-->', () => scriptTag);
}
