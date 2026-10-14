import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { File as NativeFile } from 'node:buffer';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { normalizeImportPath, prepareImportFiles } from './importFiles';

beforeAll(() => vi.stubGlobal('File', NativeFile));
afterAll(() => vi.unstubAllGlobals());

async function archive(entries: [string, string][], options: { password?: string } = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, useCompressionStream: false });
  for (const [path, text] of entries) await writer.add(path, new TextReader(text), { level: 0, ...options });
  const bytes = await writer.close();
  return new File([new Uint8Array(bytes).buffer], '资料.zip');
}
const prepare = (file: File, max = 1024) => prepareImportFiles([file], max, ['md', 'txt'], new AbortController().signal);

it('expands real archives with relative paths, skips unsupported files and does not recursively expand archives', async () => {
  const result = await prepare(await archive([['目录/说明.md', '中文内容'], ['另一个/说明.md', 'different'], ['image.png', 'image'], ['inner.zip', 'zip']]));
  expect(result.files.map((item) => item.sourcePath)).toEqual(['资料.zip/目录/说明.md', '资料.zip/另一个/说明.md']);
  expect(await result.files[0].file.text()).toBe('中文内容');
  expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('不展开嵌套 ZIP'), expect.stringContaining('不支持此文件类型')]));
});
it('rejects corrupt and encrypted archives and traversal paths', async () => {
  await expect(prepare(new File(['invalid'], 'bad.zip'))).rejects.toThrow();
  await expect(prepare(await archive([['a.txt', 'secret']], { password: 'synthetic' }))).rejects.toThrow('加密');
  for (const path of ['../secret', 'x/../../a', 'C:/secret.txt', '/abs', 'a//b', 'a\u0000b']) expect(() => normalizeImportPath(path)).toThrow();
  expect(normalizeImportPath('资料\\手册.txt')).toBe('资料/手册.txt');
  const file = await archive([['ok.txt', 'checksum text']]); const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextEncoder().encode('checksum text');
  const offset = bytes.findIndex((_, index) => text.every((value, j) => bytes[index + j] === value));
  expect(offset).toBeGreaterThan(0); bytes[offset] ^= 1;
  await expect(prepare(new File([bytes], 'corrupt.zip'))).rejects.toThrow();
});
it('bounds file count, file bytes and cancellation before expansion', async () => {
  await expect(prepareImportFiles(Array.from({ length: 201 }, () => new File(['a'], 'a.txt')), 1024, ['txt'], new AbortController().signal)).rejects.toThrow('200');
  const result = await prepare(await archive([['large.txt', '0123456789']]), 5);
  expect(result.files).toHaveLength(0); expect(result.warnings[0]).toContain('超过');
  const controller = new AbortController(); controller.abort();
  await expect(prepareImportFiles([], 1024, ['txt'], controller.signal)).resolves.toEqual({ files: [], warnings: [] });
  await expect(prepareImportFiles([new File(['a'], 'a.txt')], 1024, ['txt'], controller.signal)).rejects.toThrow();
});
