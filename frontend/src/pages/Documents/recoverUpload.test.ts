import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { DocumentItem } from '../../types/api';
import { recoverUpload } from './recoverUpload';

const document = { id: 'committed-document' } as DocumentItem;
const networkError = new ApiError(0, { code: 'NETWORK_ERROR', message: 'offline' });
function scenario() {
  return { send: vi.fn<() => Promise<DocumentItem>>(), check: vi.fn(), signal: new AbortController().signal, reconcileFirst: false, onReconciling: vi.fn() };
}

describe('recoverUpload', () => {
  it('returns a lost response from its receipt without resending', async () => {
    const args = scenario(); args.send.mockRejectedValue(networkError); args.check.mockResolvedValue({ status: 'committed', document });
    expect(await recoverUpload(args)).toBe(document);
    expect(args.send).toHaveBeenCalledTimes(1);
  });
  it('retries once after a reachable server confirms no receipt, then checks an ambiguous retry', async () => {
    const args = scenario(); args.send.mockRejectedValue(networkError); args.check.mockResolvedValueOnce({ status: 'notFound' }).mockResolvedValueOnce({ status: 'committed', document });
    expect(await recoverUpload(args)).toBe(document);
    expect(args.send).toHaveBeenCalledTimes(2);
  });
  it('keeps uncertainty when the receipt query is offline', async () => {
    const args = scenario(); args.send.mockRejectedValue(networkError); args.check.mockRejectedValue(networkError);
    await expect(recoverUpload(args)).rejects.toBe(networkError);
    expect(args.send).toHaveBeenCalledTimes(1);
  });
  it('reconciles a stopped upload before sending and never resurrects unavailable documents', async () => {
    const args = scenario(); args.reconcileFirst = true; args.check.mockResolvedValue({ status: 'unavailable' });
    await expect(recoverUpload(args)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_RESULT_UNAVAILABLE' });
    expect(args.send).not.toHaveBeenCalled();
  });
  it('does not continue after cancellation or a permission rejection', async () => {
    const args = scenario(); const controller = new AbortController(); args.signal = controller.signal;
    args.send.mockImplementation(async () => { controller.abort(); throw networkError; });
    await expect(recoverUpload(args)).rejects.toBe(networkError); expect(args.check).not.toHaveBeenCalled();
    const denied = scenario(); denied.send.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN', message: 'denied' }));
    await expect(recoverUpload(denied)).rejects.toMatchObject({ status: 403 }); expect(denied.check).not.toHaveBeenCalled();
  });
});
