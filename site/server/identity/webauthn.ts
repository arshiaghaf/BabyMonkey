import 'server-only';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { ActiveCredentialAuthority } from '@/server/d1/identity-repository';
import {
  constantTimeEqual,
  decodeBase64url,
  encodeBase64url,
  sha256Hex,
} from './crypto';
import type { WebAuthnRuntimeConfig } from './runtime';

export const supportedWebAuthnAlgorithms = [-7, -257] as const;
export const webAuthnChallengeLifetimeMs = 5 * 60 * 1000;
export const webAuthnCeremonyTimeoutMs = 2 * 60 * 1000;

export interface VerifiedRegistrationCredential {
  credentialIdentifier: Uint8Array;
  verificationMaterial: Uint8Array;
  signatureCounter: number;
  transports?: readonly string[];
}

export interface VerifiedAuthenticationCredential {
  newCounter: number;
}

const challengeMatches = (expectedHash: string) => async (candidate: string) =>
  constantTimeEqual(
    new TextEncoder().encode(await sha256Hex(candidate)),
    new TextEncoder().encode(expectedHash),
  );

const decodePrincipalId = (principalId: string) => {
  const decoded = decodeBase64url(principalId);
  return decoded?.byteLength === 32 ? decoded : null;
};

export async function createRegistrationOptions(
  config: WebAuthnRuntimeConfig,
  principalId: string,
  challenge: Uint8Array<ArrayBuffer>,
): Promise<PublicKeyCredentialCreationOptionsJSON | null> {
  const userId = decodePrincipalId(principalId);
  if (!userId || challenge.byteLength !== 32) return null;
  return generateRegistrationOptions({
    rpName: 'A little corner',
    rpID: config.rpId,
    userName: 'visitor',
    userDisplayName: 'Visitor',
    userID: userId,
    challenge,
    timeout: webAuthnCeremonyTimeoutMs,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [...supportedWebAuthnAlgorithms],
  });
}

export async function createAuthenticationOptions(
  config: WebAuthnRuntimeConfig,
  challenge: Uint8Array<ArrayBuffer>,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  if (challenge.byteLength !== 32) return null;
  return generateAuthenticationOptions({
    rpID: config.rpId,
    challenge,
    timeout: webAuthnCeremonyTimeoutMs,
    userVerification: 'required',
  });
}

export async function verifyRegistrationCeremony(input: {
  config: WebAuthnRuntimeConfig;
  response: RegistrationResponseJSON;
  challengeHash: string;
}): Promise<VerifiedRegistrationCredential | null> {
  try {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challengeMatches(input.challengeHash),
      expectedOrigin: input.config.origin,
      expectedRPID: input.config.rpId,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...supportedWebAuthnAlgorithms],
    });
    if (!result.verified || !result.registrationInfo.userVerified) return null;
    if (
      result.registrationInfo.origin !== input.config.origin
      || result.registrationInfo.rpID !== input.config.rpId
    ) {
      return null;
    }
    const identifier = decodeBase64url(result.registrationInfo.credential.id);
    if (!identifier || identifier.byteLength === 0 || identifier.byteLength > 4096) {
      return null;
    }
    return {
      credentialIdentifier: identifier,
      verificationMaterial: new Uint8Array(
        result.registrationInfo.credential.publicKey,
      ),
      signatureCounter: result.registrationInfo.credential.counter,
      transports: input.response.response.transports,
    };
  } catch {
    return null;
  }
}

export async function verifyAuthenticationCeremony(input: {
  config: WebAuthnRuntimeConfig;
  response: AuthenticationResponseJSON;
  challengeHash: string;
  credential: ActiveCredentialAuthority;
}): Promise<VerifiedAuthenticationCredential | null> {
  try {
    const expectedCredentialId = encodeBase64url(
      input.credential.credentialIdentifier,
    );
    if (input.response.id !== expectedCredentialId || input.response.rawId !== expectedCredentialId) {
      return null;
    }
    const expectedUserHandle = decodePrincipalId(input.credential.principalId);
    const submittedUserHandle = input.response.response.userHandle
      ? decodeBase64url(input.response.response.userHandle)
      : null;
    if (
      !expectedUserHandle
      || !submittedUserHandle
      || !constantTimeEqual(expectedUserHandle, submittedUserHandle)
    ) {
      return null;
    }

    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challengeMatches(input.challengeHash),
      expectedOrigin: input.config.origin,
      expectedRPID: input.config.rpId,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: expectedCredentialId,
        publicKey: Uint8Array.from(input.credential.verificationMaterial),
        counter: input.credential.signatureCounter,
        transports: input.credential.transports,
      },
    });
    if (
      !result.verified
      || !result.authenticationInfo.userVerified
      || result.authenticationInfo.origin !== input.config.origin
      || result.authenticationInfo.rpID !== input.config.rpId
    ) {
      return null;
    }
    return { newCounter: result.authenticationInfo.newCounter };
  } catch {
    return null;
  }
}
