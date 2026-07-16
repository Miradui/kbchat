import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { getErrorMessage } from './errors';

describe('getErrorMessage', () => {
  it('uses the backend message for ApiError', () => {
    const error = new ApiError(400, { code: 'INVALID_INPUT', message: '名称不能为空' });
    expect(getErrorMessage(error, '保存失败')).toBe('名称不能为空');
  });

  it('uses the supplied fallback for unknown errors', () => {
    expect(getErrorMessage(new Error('internal detail'), '保存失败')).toBe('保存失败');
  });
});
