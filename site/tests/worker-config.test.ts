import { describe, expect, it } from 'vitest';
import { validProductionEnvironment } from '../worker-config';
const complete = () => ({
  ASSETS: { fetch() {} }, DB: { prepare() {} },
  BABYMONKEY_RP_ID: 'app.owner-domain.net', BABYMONKEY_ORIGIN: 'https://app.owner-domain.net',
  BABYMONKEY_RELAY_ORIGIN: 'https://relay.owner-domain.net', BABYMONKEY_RELAY_MTLS: { fetch() {} },
});
describe('production Worker configuration gate', () => {
  it('requires exact trusted owner values and every binding', () => {
    expect(validProductionEnvironment(complete())).toBe(true);
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_ORIGIN: 'https://other.owner-domain.net' })).toBe(false);
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_RELAY_MTLS: undefined })).toBe(false);
    expect(validProductionEnvironment({ ...complete(), DB: undefined })).toBe(false);
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_RELAY_ORIGIN: 'http://relay.owner-domain.net' })).toBe(false);
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_RP_ID: 'localhost', BABYMONKEY_ORIGIN: 'http://localhost:3000' })).toBe(false);
  });
  it('cannot activate local fake delivery flags', () => {
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_LOCAL_DEMO: '1' })).toBe(false);
    expect(validProductionEnvironment({ ...complete(), BABYMONKEY_FAKE_DELIVERY: 'confirmed' })).toBe(false);
  });
});
