// Offline adapter: use precisely the application's Markdown parser and plugin.
// Node 22.18+ strips the plugin's TypeScript types; no bundle or browser needed.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { remarkCitations } from '../frontend/src/pages/Chat/remarkCitations.ts';

// Resolve via the app's installed dependency graph, not a second parser stack.
const requireApp = createRequire(new URL('../frontend/package.json', import.meta.url));
const requireMarkdown = createRequire(requireApp.resolve('react-markdown'));
const { unified } = await import(pathToFileURL(requireMarkdown.resolve('unified')).href);
const { default: remarkParse } = await import(pathToFileURL(requireMarkdown.resolve('remark-parse')).href);
const { default: remarkRehype } = await import(pathToFileURL(requireMarkdown.resolve('remark-rehype')).href);
const { default: remarkGfm } = await import(pathToFileURL(requireApp.resolve('remark-gfm')).href);

// A subprocess pipe may be nonblocking (notably on macOS). Await chunks through
// EOF instead of readFileSync(0), which can throw EAGAIN for full-sized runs.
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const results = Object.create(null);
for (const sample of JSON.parse(Buffer.concat(input).toString('utf8'))) {
  const processor = unified().use(remarkParse).use(remarkGfm)
    .use(remarkCitations, { citationCount: sample.citationCount }).use(remarkRehype);
  const tree = processor.runSync(processor.parse(sample.answer));
  const numbers = new Set();
  let valid = true;
  function walk(node) {
    const number = node.properties?.['data-citation-number'];
    if (Number.isInteger(number)) {
      numbers.add(number);
      return;
    }
    // Score the rendered tree: unused footnote definitions are not displayed.
    // Keep literal code and existing links excluded, just as in the product.
    if (node.type === 'element' && ['a', 'code', 'pre'].includes(node.tagName)) return;
    // Remaining markers in prose were malformed, oversized, or out of range.
    if (node.type === 'text' && /\[source:/iu.test(node.value)) valid = false;
    for (const child of node.children ?? []) walk(child);
  }
  walk(tree);
  results[sample.sampleId] = { numbers: [...numbers], sourceIndexesValid: valid };
}
process.stdout.write(JSON.stringify(results));
