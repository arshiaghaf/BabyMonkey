import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { encodeBase64url, sha256Bytes } from '@/server/identity/crypto';

type FixtureAlgorithm = 'ES256' | 'RS256';

type CborValue = number | string | Uint8Array<ArrayBuffer> | CborMap;
type CborMap = ReadonlyArray<readonly [number | string, CborValue]>;

const concatenate = (parts: readonly Uint8Array<ArrayBuffer>[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const cborHead = (major: number, value: number): Uint8Array<ArrayBuffer> => {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 256) return Uint8Array.of((major << 5) | 24, value);
  if (value < 65_536) {
    return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  }
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
};

const encodeCbor = (value: CborValue): Uint8Array<ArrayBuffer> => {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concatenate([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concatenate([cborHead(2, value.length), value]);
  }
  const entries = value.flatMap(([key, entryValue]) => [
    encodeCbor(key),
    encodeCbor(entryValue),
  ]);
  return concatenate([cborHead(5, value.length), ...entries]);
};

const decodeJwkValue = (value: string | undefined) => {
  if (!value) throw new Error('Fixture JWK value is missing.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const counterBytes = (counter: number) => Uint8Array.of(
  (counter >>> 24) & 0xff,
  (counter >>> 16) & 0xff,
  (counter >>> 8) & 0xff,
  counter & 0xff,
);

const encodeDerInteger = (value: Uint8Array<ArrayBuffer>) => {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset += 1;
  const trimmed = value.slice(offset);
  const needsLeadingZero = (trimmed[0] & 0x80) !== 0;
  return concatenate([
    Uint8Array.of(0x02, trimmed.length + (needsLeadingZero ? 1 : 0)),
    needsLeadingZero ? Uint8Array.of(0) : new Uint8Array(0),
    trimmed,
  ]);
};

const encodeEcdsaDerSignature = (signature: ArrayBuffer) => {
  const bytes = new Uint8Array(signature);
  if (bytes.length !== 64) throw new Error('Unexpected ES256 fixture signature.');
  const r = encodeDerInteger(bytes.slice(0, 32));
  const s = encodeDerInteger(bytes.slice(32));
  return concatenate([Uint8Array.of(0x30, r.length + s.length), r, s]);
};

const clientData = (type: string, challenge: string, origin: string) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin }));

export interface RegistrationFixture {
  algorithm: FixtureAlgorithm;
  credentialId: Uint8Array<ArrayBuffer>;
  credentialPublicKey: Uint8Array<ArrayBuffer>;
  privateKey: CryptoKey;
  response: RegistrationResponseJSON;
}

export async function createRegistrationFixture(input: {
  algorithm: FixtureAlgorithm;
  challenge: string;
  origin: string;
  rpId: string;
  userHandle: Uint8Array<ArrayBuffer>;
  backupEligible?: boolean;
  userVerified?: boolean;
}): Promise<RegistrationFixture> {
  const keyPair = input.algorithm === 'ES256'
    ? await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    : await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: Uint8Array.of(1, 0, 1),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const credentialPublicKey = input.algorithm === 'ES256'
    ? encodeCbor([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, decodeJwkValue(jwk.x)],
      [-3, decodeJwkValue(jwk.y)],
    ])
    : encodeCbor([
      [1, 3],
      [3, -257],
      [-1, decodeJwkValue(jwk.n)],
      [-2, decodeJwkValue(jwk.e)],
    ]);
  const credentialId = new Uint8Array(32);
  credentialId.fill(input.algorithm === 'ES256' ? 0x45 : 0x52);
  const rpIdHash = await sha256Bytes(input.rpId);
  const credentialLength = Uint8Array.of(
    (credentialId.length >>> 8) & 0xff,
    credentialId.length & 0xff,
  );
  const authenticatorData = concatenate([
    rpIdHash,
    Uint8Array.of(
      (input.userVerified === false ? 0x41 : 0x45)
      | (input.backupEligible ? 0x08 : 0),
    ),
    counterBytes(0),
    new Uint8Array(16),
    credentialLength,
    credentialId,
    credentialPublicKey,
  ]);
  const attestationObject = encodeCbor([
    ['fmt', 'none'],
    ['attStmt', []],
    ['authData', authenticatorData],
  ]);
  const encodedCredentialId = encodeBase64url(credentialId);
  const response: RegistrationResponseJSON = {
    id: encodedCredentialId,
    rawId: encodedCredentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: encodeBase64url(
        clientData('webauthn.create', input.challenge, input.origin),
      ),
      attestationObject: encodeBase64url(attestationObject),
      transports: ['internal', 'hybrid'],
    },
  };
  return {
    algorithm: input.algorithm,
    credentialId,
    credentialPublicKey,
    privateKey: keyPair.privateKey,
    response,
  };
}

export async function createAuthenticationFixture(input: {
  registration: RegistrationFixture;
  challenge: string;
  origin: string;
  rpId: string;
  userHandle: Uint8Array<ArrayBuffer>;
  counter: number;
  backupEligible?: boolean;
  userVerified?: boolean;
}): Promise<AuthenticationResponseJSON> {
  const flags = 0x01
    | (input.userVerified === false ? 0 : 0x04)
    | (input.backupEligible ? 0x08 : 0);
  const authenticatorData = concatenate([
    await sha256Bytes(input.rpId),
    Uint8Array.of(flags),
    counterBytes(input.counter),
  ]);
  const encodedClientData = clientData(
    'webauthn.get',
    input.challenge,
    input.origin,
  );
  const signatureBase = concatenate([
    authenticatorData,
    await sha256Bytes(encodedClientData),
  ]);
  const rawSignature = await crypto.subtle.sign(
    input.registration.algorithm === 'ES256'
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : { name: 'RSASSA-PKCS1-v1_5' },
    input.registration.privateKey,
    signatureBase,
  );
  const signature = input.registration.algorithm === 'ES256'
    ? encodeEcdsaDerSignature(rawSignature)
    : new Uint8Array(rawSignature);
  const credentialId = encodeBase64url(input.registration.credentialId);
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: encodeBase64url(encodedClientData),
      authenticatorData: encodeBase64url(authenticatorData),
      signature: encodeBase64url(signature),
      userHandle: encodeBase64url(input.userHandle),
    },
  };
}
