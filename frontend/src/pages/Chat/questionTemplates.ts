/** Substitute once: user-entered braces are literal text, never another template. */
export function fillQuestionTemplate(body: string, values: Record<string, string>) {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => values[name.trim()] ?? '');
}

export function questionTemplateVariables(body: string): string[] | null {
  const variables: string[] = [];
  let rest = body;
  while (rest.includes('{{') || rest.includes('}}')) {
    const start = rest.indexOf('{{'); const end = rest.indexOf('}}');
    if (start < 0 || end < start) return null;
    const name = rest.slice(start + 2, end).trim();
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name)) return null;
    if (!variables.includes(name)) variables.push(name);
    if (variables.length > 20) return null;
    rest = rest.slice(end + 2);
  }
  return variables;
}
