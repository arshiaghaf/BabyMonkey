import { beforeEach, describe, expect, it, vi } from 'vitest';

const { consumeChallenge } = vi.hoisted(() => ({
  consumeChallenge: vi.fn(),
}));

vi.mock('@/server/d1/identity-repository', () => ({
  acceptAuthenticationAndIssueSession: vi.fn(),
  commitVerifiedEnrollment: vi.fn(),
  consumeWebAuthnChallenge: consumeChallenge,
  issueIdentitySession: vi.fn(),
  readActiveCredentialByIdentifier: vi.fn(),
}));

vi.mock('@/server/identity/runtime', () => ({
  getIdentityDatabase: () => ({}),
  getWebAuthnRuntimeConfig: () => ({
    rpId: 'localhost',
    origin: 'http://localhost:4173',
    localAutomatedHarness: true,
  }),
}));

import { POST } from '@/app/api/identity/verify/route';
import {
  ceremonyFlowCookieName,
  createOpaqueToken,
} from '@/server/identity/cookies';

const requestFor = async (body: string, origin = 'http://localhost:4173') => {
  const flow = await createOpaqueToken();
  const csrf = await createOpaqueToken();
  return new Request('http://localhost:4173/api/identity/verify', {
    method: 'POST',
    headers: {
      cookie: `${ceremonyFlowCookieName}=${flow.raw}.${csrf.raw}`,
      'content-type': 'application/json',
      origin,
      'x-bm-csrf': csrf.raw,
    },
    body,
  });
};

describe('verification challenge burn ordering', () => {
  beforeEach(() => {
    consumeChallenge.mockReset();
    consumeChallenge.mockResolvedValue({
      ceremony: 'authentication',
      challengeHash: 'a'.repeat(64),
    });
  });

  for (const [name, body] of [
    ['malformed JSON', '{'],
    ['wrong-shape JSON', '{"response":{},"extra":true}'],
    ['oversized JSON', JSON.stringify({ response: 'x'.repeat(33 * 1024) })],
  ] as const) {
    it(`burns the challenge before rejecting ${name}`, async () => {
      const response = await POST(await requestFor(body));
      expect(response.status).toBe(400);
      expect(consumeChallenge).toHaveBeenCalledTimes(1);
    });
  }

  it('does not burn a challenge for an invalid Origin envelope', async () => {
    const response = await POST(await requestFor('{}', 'http://localhost:9999'));
    expect(response.status).toBe(400);
    expect(consumeChallenge).not.toHaveBeenCalled();
  });
});
