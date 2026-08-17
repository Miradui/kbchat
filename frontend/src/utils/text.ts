/** JavaScript string length counts UTF-16 units; API text limits count code points. */
export function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}
