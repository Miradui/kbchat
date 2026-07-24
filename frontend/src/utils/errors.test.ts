import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { getDocumentProcessingErrorMessage, getErrorMessage } from './errors';

describe('getErrorMessage', () => {
  it('uses the backend message for ApiError', () => {
    const error = new ApiError(400, { code: 'INVALID_INPUT', message: '名称不能为空' });
    expect(getErrorMessage(error, '保存失败')).toBe('名称不能为空');
  });

  it('uses the supplied fallback for unknown errors', () => {
    expect(getErrorMessage(new Error('internal detail'), '保存失败')).toBe('保存失败');
  });

  it('maps model provider failures to a recoverable business message', () => {
    const error = new ApiError(500, {
      code: 'CHAT_COMPLETION_FAILED',
      message: 'chat completion failed',
    });

    expect(getErrorMessage(error, '消息发送失败')).toBe('回答生成失败，请稍后重试。');
  });

  it('does not expose internal errors returned by the API', () => {
    const error = new ApiError(500, {
      code: 'INTERNAL_ERROR',
      message: 'retrieval service is not configured',
    });

    expect(getErrorMessage(error, '知识库检索失败')).toBe('知识库检索失败');
  });

  it('hides technical details even when the backend error code is unknown', () => {
    const error = new ApiError(500, {
      code: 'PROVIDER_ERROR',
      message: 'EMBEDDING_API_KEY is required',
    });
    expect(getErrorMessage(error, '知识库检索失败')).toBe('知识库检索失败');
  });

  it('explains that document processing configuration must be fixed before retrying', () => {
    expect(getDocumentProcessingErrorMessage('EMBEDDING_API_KEY is required')).toBe(
      '文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。',
    );
    expect(getDocumentProcessingErrorMessage(
      '文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。',
    )).toBe('文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。');
  });

  it('hides unknown document processing details', () => {
    expect(getDocumentProcessingErrorMessage('dial tcp 127.0.0.1: connection refused')).toBe(
      '文档处理失败，请检查文件内容或稍后重处理。',
    );
  });
});
