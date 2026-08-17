export const DEFAULT_MAX_PASSWORD_BYTES = 72;

export type PasswordLengthError = 'tooShort' | 'tooLong';

export function passwordUTF8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validatePasswordLength(
  value: string,
  minCharacters: number,
  maxBytes: number,
): PasswordLengthError | null {
  if (Array.from(value).length < minCharacters) return 'tooShort';
  if (passwordUTF8ByteLength(value) > maxBytes) return 'tooLong';
  return null;
}
