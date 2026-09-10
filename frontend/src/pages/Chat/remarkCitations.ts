import type { Link, Parent, Root, RootContent, Text } from 'mdast';

/** Only turn backend-resolvable markers in prose into controls; code and links stay literal. */
export function remarkCitations({ citationCount }: { citationCount: number }) {
  return (tree: Root) => {
    function walk(parent: Parent) {
      const children: RootContent[] = [];
      for (const node of parent.children) {
        if (node.type !== 'text') {
          if ('children' in node && !['link', 'linkReference', 'imageReference'].includes(node.type)) {
            walk(node);
          }
          children.push(node);
          continue;
        }
        const pattern = /\[source:\s*(\d+(?:\s*,\s*\d+)*)\s*\]/giu;
        let cursor = 0;
        for (const match of node.value.matchAll(pattern)) {
          const numbers = match[1].split(',').map((value) => Number(value.trim()));
          if (numbers.length > 20 || numbers.some((value) => value < 1 || value > citationCount)) continue;
          if (match.index > cursor) children.push({ type: 'text', value: node.value.slice(cursor, match.index) } satisfies Text);
          [...new Set(numbers)].forEach((number, index) => {
            if (index > 0) children.push({ type: 'text', value: ', ' });
            children.push({
              type: 'link',
              url: `#source-${number}`,
              children: [{ type: 'text', value: String(number) }],
              data: { hProperties: { 'data-citation-number': number } },
            } satisfies Link);
          });
          cursor = match.index + match[0].length;
        }
        if (cursor < node.value.length) children.push({ type: 'text', value: node.value.slice(cursor) });
      }
      parent.children = children;
    }
    walk(tree);
  };
}
