import type { Element, ElementContent, Root } from 'hast';

export type SourceRange = { start: number; end: number };

/** Highlight parsed text, never splice markup into the Markdown source. */
export function rehypeSourceHighlight({ source, range }: { source: string; range: SourceRange }) {
  return (tree: Root) => {
    let first = true;

    function visit(parent: Root | Element) {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        if (child.type === 'element') {
          visit(child);
          continue;
        }
        if (child.type !== 'text' || !child.value.trim()) continue;

        // Fenced/inline code can omit a text position; its code element retains
        // the source span. Other generated text (e.g. table whitespace) is ignored.
        const position = child.position ?? (parent.type === 'element' && parent.tagName === 'code' ? parent.position : undefined);
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (start === undefined || end === undefined || start >= range.end || end <= range.start) continue;

        // Plain text has a direct mapping. Entities, escapes and code fences do
        // not: highlight that rendered text unit as a whole instead of applying
        // raw-source indexes to decoded text and marking the wrong characters.
        const exact = source.slice(start, end) === child.value;
        const from = exact ? Math.max(0, range.start - start) : 0;
        const to = exact ? Math.min(child.value.length, range.end - start) : child.value.length;
        const mark: Element = {
          type: 'element', tagName: 'mark',
          properties: first ? { 'data-citation-start': true } : {},
          children: [{ type: 'text', value: child.value.slice(from, to) }],
        };
        first = false;
        const replacement: ElementContent[] = [
          ...(from ? [{ type: 'text' as const, value: child.value.slice(0, from) }] : []),
          mark,
          ...(to < child.value.length ? [{ type: 'text' as const, value: child.value.slice(to) }] : []),
        ];
        parent.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    }

    visit(tree);
  };
}
