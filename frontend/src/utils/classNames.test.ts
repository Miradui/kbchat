import { describe, expect, it } from 'vitest';

import { classNames } from './classNames';

describe('classNames', () => {
  it('joins truthy class names without leaking false values', () => {
    expect(classNames('button', false, undefined, 'primary', null)).toBe('button primary');
  });
});
