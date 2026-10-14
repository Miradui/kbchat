export const MAX_IMPORT_FILES = 200;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export type PreparedImportFile = { file: File; sourcePath?: string };

export function preparePlainImportFiles(files: File[]) {
  if (files.length > MAX_IMPORT_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) throw new Error('单批最多 200 个文件，总大小不超过 200 MiB。');
  return { files: files.map((file) => ({ file, ...(file.webkitRelativePath ? { sourcePath: normalizeImportPath(file.webkitRelativePath) } : {}) })), warnings: [] as string[] };
}

export function normalizeImportPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /[:\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || new TextEncoder().encode(normalized).length > 1024
    || normalized.split('/').some((part) => !part || part === '.' || part === '..' || Array.from(part).length > 255)) {
    throw new Error(`无效的来源相对路径：${path.slice(0, 120)}`);
  }
  return normalized;
}

/** Expand locally, then hand ordinary Files to the existing upload queue. */
export async function prepareImportFiles(files: File[], maxFileBytes: number, allowed: string[], signal: AbortSignal): Promise<{ files: PreparedImportFile[]; warnings: string[] }> {
  const prepared: PreparedImportFile[] = []; const warnings: string[] = [];
  let totalBytes = 0; let count = 0;
  function reserve(size: number) {
    count++; totalBytes += size;
    if (count > MAX_IMPORT_FILES || !Number.isSafeInteger(size) || size < 0 || totalBytes > MAX_IMPORT_BYTES) throw new Error('单批最多 200 个文件，展开后总大小不超过 200 MiB。');
  }
  for (const file of files) {
    signal.throwIfAborted();
    if (!file.name.toLowerCase().endsWith('.zip')) {
      reserve(file.size);
      prepared.push({ file, ...(file.webkitRelativePath ? { sourcePath: normalizeImportPath(file.webkitRelativePath) } : {}) });
      continue;
    }
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件本身不能超过 100 MiB。');
    const { ZipReader, BlobReader } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(file), { strictness: 'strict', checkCrc32: true, signal });
    const paths = new Set<string>(); let entries = 0;
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        signal.throwIfAborted();
        if (++entries > 1000) throw new Error('ZIP 目录项超过 1000 个。');
        const path = normalizeImportPath(entry.directory ? entry.filename.replace(/\/$/, '') : entry.filename);
        if (entry.encrypted) throw new Error('不支持加密 ZIP，请先解密。');
        if ((entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000) throw new Error('ZIP 中不能包含符号链接。');
        if (entry.directory) continue;
        if (paths.has(path)) throw new Error(`ZIP 包含重复路径：${path}`); paths.add(path);
        reserve(entry.uncompressedSize);
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        if (!allowed.includes(extension)) { warnings.push(`${path}：${extension === 'zip' ? '不展开嵌套 ZIP' : '不支持此文件类型'}`); continue; }
        if (entry.uncompressedSize > maxFileBytes) { warnings.push(`${path}：超过单文件上传限制`); continue; }
        if (![0, 8].includes(entry.compressionMethod)) throw new Error('ZIP 仅支持 Store 或 Deflate 压缩。');
        let written = 0; const chunks: BlobPart[] = [];
        // Count actual decompressed bytes before retaining them; do not trust the
        // central directory sizes when enforcing the memory limit.
        const writer = new WritableStream<Uint8Array>({ write(chunk) {
          written += chunk.byteLength;
          if (written > entry.uncompressedSize || written > maxFileBytes) throw new Error('ZIP 展开大小异常或超过限制。');
          signal.throwIfAborted(); chunks.push(new Uint8Array(chunk).buffer);
        } });
        await entry.getData(writer, { signal, checkCrc32: true });
        if (written !== entry.uncompressedSize) throw new Error('ZIP 文件大小校验失败。');
        const name = path.split('/').at(-1)!;
        const sourcePath = normalizeImportPath(`${file.webkitRelativePath || file.name}/${path}`);
        prepared.push({ file: new File(chunks, name, { lastModified: entry.lastModDate?.getTime() ?? 0 }), sourcePath });
      }
    } finally { await reader.close(); }
  }
  return { files: prepared, warnings };
}
