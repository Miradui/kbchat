import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export type PdfLibrary = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pending: Promise<PdfLibrary> | undefined;

// Load the renderer only when a PDF is opened. The worker and support files are
// served by this application, so documents and credentials never go to a CDN.
export function loadPdfJs(): Promise<PdfLibrary> {
  pending ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((library) => {
    library.GlobalWorkerOptions.workerSrc = workerUrl;
    return library;
  }).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
