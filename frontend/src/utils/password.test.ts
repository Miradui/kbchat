import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_PASSWORD_BYTES,
  passwordUTF8ByteLength,
  validatePasswordLength,
} from './password';

describe('password UTF-8 limits', () => {
  it('uses the bcrypt 72-byte boundary for ASCII', () => {
    expect(DEFAULT_MAX_PASSWORD_BYTES).toBe(72);
    expect(validatePasswordLength('a'.repeat(72), 8, DEFAULT_MAX_PASSWORD_BYTES)).toBeNull();
    expect(validatePasswordLength('a'.repeat(73), 8, DEFAULT_MAX_PASSWORD_BYTES)).toBe('tooLong');
  });

  it('counts multibyte passwords in UTF-8 bytes', () => {
    expect(passwordUTF8ByteLength('界'.repeat(24))).toBe(72);
    expect(passwordUTF8ByteLength('界'.repeat(25))).toBe(75);
    expect(validatePasswordLength('界'.repeat(24), 8, 72)).toBeNull();
    expect(validatePasswordLength('界'.repeat(25), 8, 72)).toBe('tooLong');
  });

  it('keeps the minimum in Unicode code points rather than UTF-16 units', () => {
    expect(validatePasswordLength('😀'.repeat(4), 8, 72)).toBe('tooShort');
    expect(validatePasswordLength('😀'.repeat(8), 8, 72)).toBeNull();
  });
});
