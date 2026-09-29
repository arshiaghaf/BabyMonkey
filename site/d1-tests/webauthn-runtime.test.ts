import { describe, expect, it } from 'vitest';

import type { ActiveCredentialAuthority } from '@/server/d1/identity-repository';
import { encodeBase64url, randomBytes, sha256Hex } from '@/server/identity/crypto';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthenticationCeremony,
  verifyRegistrationCeremony,
} from '@/server/identity/webauthn';
import {
  createAuthenticationFixture,
  createRegistrationFixture,
} from './webauthn-fixtures';

const config = {
  rpId: 'localhost',
  origin: 'http://localhost:4173',
  localAutomatedHarness: true,
} as const;

describe('SimpleWebAuthn in workerd', () => {
  for (const algorithm of ['ES256', 'RS256'] as const) {
    it(`verifies ${algorithm} registration and authentication with exact RP, origin, challenge, UV, handle, and signature`, async () => {
      const userHandle = randomBytes(32);
      const principalId = encodeBase64url(userHandle);
      const registrationChallenge = randomBytes(32);
      const registrationOptions = await createRegistrationOptions(
        config,
        principalId,
        registrationChallenge,
      );
      expect(registrationOptions).toMatchObject({
        rp: { id: 'localhost', name: 'A little corner' },
        user: { id: principalId, name: 'visitor', displayName: 'Visitor' },
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
      });
      expect(registrationOptions?.pubKeyCredParams.map(({ alg }) => alg))
        .toEqual([-7, -257]);
      const registration = await createRegistrationFixture({
        algorithm,
        challenge: registrationOptions!.challenge,
        origin: config.origin,
        rpId: config.rpId,
        userHandle,
      });
      const verifiedRegistration = await verifyRegistrationCeremony({
        config,
        response: registration.response,
        challengeHash: await sha256Hex(registrationOptions!.challenge),
      });
      expect(verifiedRegistration).toMatchObject({
        credentialIdentifier: registration.credentialId,
        signatureCounter: 0,
        transports: ['internal', 'hybrid'],
      });

      const authenticationChallenge = randomBytes(32);
      const authenticationOptions = await createAuthenticationOptions(
        config,
        authenticationChallenge,
      );
      expect(authenticationOptions).toMatchObject({
        rpId: 'localhost',
        userVerification: 'required',
      });
      expect(authenticationOptions?.allowCredentials).toBeUndefined();
      const response = await createAuthenticationFixture({
        registration,
        challenge: authenticationOptions!.challenge,
        origin: config.origin,
        rpId: config.rpId,
        userHandle,
        counter: 1,
      });
      const credential: ActiveCredentialAuthority = {
        slot: 1,
        authorizationGeneration: 1,
        principalId,
        credentialIdentifier: registration.credentialId,
        verificationMaterial: verifiedRegistration!.verificationMaterial,
        signatureCounter: 0,
        transports: ['hybrid', 'internal'],
      };
      await expect(verifyAuthenticationCeremony({
        config,
        response,
        challengeHash: await sha256Hex(authenticationOptions!.challenge),
        credential,
      })).resolves.toEqual({ newCounter: 1 });

      const wrongHandle = structuredClone(response);
      wrongHandle.response.userHandle = encodeBase64url(randomBytes(32));
      await expect(verifyAuthenticationCeremony({
        config,
        response: wrongHandle,
        challengeHash: await sha256Hex(authenticationOptions!.challenge),
        credential,
      })).resolves.toBeNull();

      const wrongOrigin = structuredClone(response);
      const clientData = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(
          wrongOrigin.response.clientDataJSON.replaceAll('-', '+').replaceAll('_', '/'),
        ), (character) => character.charCodeAt(0)),
      ));
      clientData.origin = 'http://localhost:9999';
      wrongOrigin.response.clientDataJSON = encodeBase64url(
        new TextEncoder().encode(JSON.stringify(clientData)),
      );
      await expect(verifyAuthenticationCeremony({
        config,
        response: wrongOrigin,
        challengeHash: await sha256Hex(authenticationOptions!.challenge),
        credential,
      })).resolves.toBeNull();
    });
  }

  it('accepts a cryptographically valid synchronized zero-counter assertion without weakening single-device counters', async () => {
    const userHandle = randomBytes(32);
    const principalId = encodeBase64url(userHandle);
    const challenge = encodeBase64url(randomBytes(32));
    const registration = await createRegistrationFixture({
      algorithm: 'ES256',
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      backupEligible: true,
    });
    const response = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 0,
      backupEligible: true,
    });
    await expect(verifyAuthenticationCeremony({
      config,
      response,
      challengeHash: await sha256Hex(challenge),
      credential: {
        slot: 1,
        authorizationGeneration: 1,
        principalId,
        credentialIdentifier: registration.credentialId,
        verificationMaterial: registration.credentialPublicKey,
        signatureCounter: 0,
      },
    })).resolves.toEqual({ newCounter: 0 });
  });

  it('fails closed for wrong RP, challenge, UV, credential, ceremony type, signature, and counter', async () => {
    const userHandle = randomBytes(32);
    const principalId = encodeBase64url(userHandle);
    const challenge = encodeBase64url(randomBytes(32));
    const registration = await createRegistrationFixture({
      algorithm: 'ES256',
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
    });
    const credential: ActiveCredentialAuthority = {
      slot: 1,
      authorizationGeneration: 1,
      principalId,
      credentialIdentifier: registration.credentialId,
      verificationMaterial: registration.credentialPublicKey,
      signatureCounter: 5,
    };
    const challengeHash = await sha256Hex(challenge);
    const verify = (response: Awaited<ReturnType<typeof createAuthenticationFixture>>) =>
      verifyAuthenticationCeremony({
        config,
        response,
        challengeHash,
        credential,
      });

    const wrongRp = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: 'wrong.example',
      userHandle,
      counter: 6,
    });
    await expect(verify(wrongRp)).resolves.toBeNull();

    const wrongChallenge = await createAuthenticationFixture({
      registration,
      challenge: encodeBase64url(randomBytes(32)),
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 6,
    });
    await expect(verify(wrongChallenge)).resolves.toBeNull();

    const noUv = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 6,
      userVerified: false,
    });
    await expect(verify(noUv)).resolves.toBeNull();

    const wrongCredential = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 6,
    });
    wrongCredential.id = encodeBase64url(randomBytes(32));
    wrongCredential.rawId = wrongCredential.id;
    await expect(verify(wrongCredential)).resolves.toBeNull();

    const wrongType = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 6,
    });
    const decodedClientData = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(
        wrongType.response.clientDataJSON.replaceAll('-', '+').replaceAll('_', '/'),
      ), (character) => character.charCodeAt(0)),
    ));
    decodedClientData.type = 'webauthn.create';
    wrongType.response.clientDataJSON = encodeBase64url(
      new TextEncoder().encode(JSON.stringify(decodedClientData)),
    );
    await expect(verify(wrongType)).resolves.toBeNull();

    const badSignature = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 6,
    });
    badSignature.response.signature = encodeBase64url(randomBytes(64));
    await expect(verify(badSignature)).resolves.toBeNull();

    const counterRegression = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 4,
    });
    await expect(verify(counterRegression)).resolves.toBeNull();

    const backupEligibilitySwitch = await createAuthenticationFixture({
      registration,
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      counter: 0,
      backupEligible: true,
    });
    await expect(verify(backupEligibilitySwitch)).resolves.toBeNull();

    const registrationWithoutUv = await createRegistrationFixture({
      algorithm: 'ES256',
      challenge,
      origin: config.origin,
      rpId: config.rpId,
      userHandle,
      userVerified: false,
    });
    await expect(verifyRegistrationCeremony({
      config,
      response: registrationWithoutUv.response,
      challengeHash: await sha256Hex(challenge),
    })).resolves.toBeNull();
  });
});
