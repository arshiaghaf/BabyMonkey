import type {
  D1Bindable,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../../site/server/d1/types.ts';

import { createStatusReader } from '../src/status.ts';

class Statement implements D1PreparedStatementLike {
  readonly query: string;
  readonly database: FakeDatabase;
  bindings: D1Bindable[] = [];
  constructor(database: FakeDatabase, query: string) { this.database = database; this.query = query; }
  bind(...values: D1Bindable[]): D1PreparedStatementLike { this.bindings = values; return this; }
  async first<T>(): Promise<T | null> { return this.database.firstResult as T | null; }
  async run<T>(): Promise<D1ResultLike<T>> { return this.database.runResult as D1ResultLike<T>; }
}

class FakeDatabase implements D1DatabaseLike {
  batchResult: D1ResultLike[] = [];
  firstResult: unknown = null;
  runResult: D1ResultLike = { success: true, results: [], meta: { changes: 0 } };
  statements: Statement[] = [];
  prepare(query: string): D1PreparedStatementLike {
    const statement = new Statement(this, query);
    this.statements.push(statement);
    return statement;
  }
  async batch<T>(): Promise<D1ResultLike<T>[]> { return this.batchResult as D1ResultLike<T>[]; }
}

const principalRows = [
  {
    slot: 1, principalState: null, generation: null, credentialState: null,
    credentialGeneration: null, activeSessions: 0, operationalReservations: 0,
  },
  {
    slot: 2, principalState: 'active', generation: 3, credentialState: 'active',
    credentialGeneration: 3, activeSessions: 1, operationalReservations: 0,
  },
];

describe('fixed maintenance status reads', () => {
  it('translates ordered bound status results without exposing credential or session identifiers', async () => {
    const db = new FakeDatabase();
    db.batchResult = [
      { success: true, results: principalRows, meta: { changes: 0 } },
      { success: true, results: [], meta: { changes: 0 } },
      { success: true, results: [{ enabled: 1, revision: 4 }], meta: { changes: 0 } },
    ];
    const snapshot = await createStatusReader(db).readSnapshot(123);
    expect(snapshot.principals[1]).toMatchObject({ slot: 2, state: 'active', generation: 3 });
    expect(snapshot.notification).toEqual({ enabled: true, revision: 4 });
    expect(db.statements[0]?.bindings).toEqual([123]);
    const sql = db.statements.map((value) => value.query).join('\n');
    expect(sql).not.toMatch(/credential_identifier|session_hash|verification_material/);
  });

  it('fails closed on partial or malformed provider rows', async () => {
    const db = new FakeDatabase();
    db.batchResult = [
      { success: true, results: principalRows, meta: { changes: 0 } },
      { success: true, results: [], meta: { changes: 0 } },
    ];
    await expect(createStatusReader(db).readSnapshot(123)).rejects.toMatchObject({ code: 'status-unavailable' });
    db.firstResult = { enabled: 'yes', revision: 4 };
    await expect(createStatusReader(db).readNotification()).rejects.toMatchObject({ code: 'status-unavailable' });
  });

  it.each([
    { ...principalRows[1], credentialState: 'revoked' },
    { ...principalRows[1], credentialGeneration: 2 },
    { ...principalRows[0], activeSessions: 1 },
    { ...principalRows[1], operationalReservations: 2 },
    {
      ...principalRows[1], principalState: 'reset', credentialState: 'revoked',
      activeSessions: 1,
    },
  ])('rejects contradictory principal authority rows', async (row) => {
    const db = new FakeDatabase();
    db.firstResult = row;
    await expect(createStatusReader(db).readPrincipal(2, 123)).rejects.toMatchObject({
      code: 'status-unavailable',
    });
  });

  it.each([
    { createdAtMs: 20, expiresAtMs: 20, revokedAtMs: null, consumedAtMs: null },
    { createdAtMs: 20, expiresAtMs: 30, revokedAtMs: 19, consumedAtMs: null },
    { createdAtMs: 20, expiresAtMs: 30, revokedAtMs: 25, consumedAtMs: 26 },
  ])('rejects contradictory invitation chronology', async (timestamps) => {
    const db = new FakeDatabase();
    db.firstResult = {
      invitationId: 'synthetic-invitation',
      tokenHash: 'a'.repeat(64),
      slot: 1,
      purpose: 'initial',
      requiredGeneration: null,
      ...timestamps,
    };
    await expect(createStatusReader(db).readInvitationById('synthetic-invitation'))
      .rejects.toMatchObject({ code: 'status-unavailable' });
  });

  it('rejects integers that cannot preserve exact generation or revision values', async () => {
    const db = new FakeDatabase();
    db.firstResult = { enabled: 1, revision: Number.MAX_SAFE_INTEGER + 1 };
    await expect(createStatusReader(db).readNotification()).rejects.toMatchObject({
      code: 'status-unavailable',
    });
    db.firstResult = {
      ...principalRows[1],
      generation: Number.MAX_SAFE_INTEGER + 1,
      credentialGeneration: Number.MAX_SAFE_INTEGER + 1,
    };
    await expect(createStatusReader(db).readPrincipal(2, 123)).rejects.toMatchObject({
      code: 'status-unavailable',
    });
  });
});
