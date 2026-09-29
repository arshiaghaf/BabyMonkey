import 'server-only';

const base64urlPattern = /^[A-Za-z0-9_-]+$/;

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(length) || length < 1 || length > 1024) {
    throw new Error('Invalid random byte length.');
  }
  return crypto.getRandomValues(new Uint8Array(length));
}

export function encodeBase64url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !base64urlPattern.test(value)
    || value.includes('=')
  ) {
    return null;
  }
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
      + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export async function sha256Bytes(
  value: string | ArrayBuffer | ArrayBufferView,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer));
}

export async function sha256Hex(
  value: string | ArrayBuffer | ArrayBufferView,
): Promise<string> {
  const digest = await sha256Bytes(value);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(
  left: ArrayBuffer | ArrayBufferView,
  right: ArrayBuffer | ArrayBufferView,
): boolean {
  const leftBytes = left instanceof ArrayBuffer
    ? new Uint8Array(left)
    : new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const rightBytes = right instanceof ArrayBuffer
    ? new Uint8Array(right)
    : new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
