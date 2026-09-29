import { describe, expect, it, vi } from 'vitest';

import {
  createD1RestDatabase,
  D1RestAdapterError,
  type D1RestTransport,
  type D1RestTransportRequest,
} from '../src/index.ts';

const successResponse = (
  result: unknown[] = [{ success: true, results: [], meta: { changes: 0 } }],
) => new Response(JSON.stringify({
  success: true,
  errors: [],
  messages: [],
  result,
}), {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
});

const captureTransport = (response: Response) => {
  const requests: D1RestTransportRequest[] = [];
  const transport: D1RestTransport = async (request) => {
    requests.push(request);
    return response.clone();
  };
  return { requests, transport };
};

const expectAdapterError = async (
  promise: Promise<unknown>,
  kind: D1RestAdapterError['kind'],
  outcome: D1RestAdapterError['commitOutcome'] = 'unknown',
) => {
  await expect(promise).rejects.toMatchObject({
    name: 'D1RestAdapterError',
    kind,
    commitOutcome: outcome,
  });
};

describe('Cloudflare D1 REST adapter', () => {
  it('serializes prepared bindings without retaining caller-owned binary buffers', async () => {
    const { requests, transport } = captureTransport(successResponse([
      { success: true, results: [], meta: { changes: 1, served_by_colo: 'XXX' } },
    ]));
    const db = createD1RestDatabase({ transport });
    const bytes = new Uint8Array([8, 9, 10, 11]);
    const view = bytes.subarray(1, 3);
    const buffer = new Uint8Array([4, 5]).buffer;
    const statement = db.prepare('UPDATE synthetic SET value = ?1')
      .bind('text', 7, null, view, buffer);
    bytes.fill(0);

    await expect(statement.run()).resolves.toEqual({
      success: true,
      results: [],
      meta: { changes: 1 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(requests[0].body)).toEqual({
      sql: 'UPDATE synthetic SET value = ?1',
      params: ['text', 7, null, [9, 10], [4, 5]],
    });
  });

  it('translates first rows and named columns with null for no rows', async () => {
    const responses = [
      successResponse([{ success: true, results: [{ value: 41 }, { value: 42 }], meta: { changes: 0 } }]),
      successResponse([{ success: true, results: [{ value: 41 }], meta: { changes: 0 } }]),
      successResponse([{ success: true, results: [], meta: { changes: 0 } }]),
    ];
    const transport = vi.fn<D1RestTransport>(async () => responses.shift()!);
    const statement = createD1RestDatabase({ transport }).prepare(
      'SELECT value FROM synthetic ORDER BY value',
    );

    await expect(statement.first()).resolves.toEqual({ value: 41 });
    await expect(statement.first<number>('value')).resolves.toBe(41);
    await expect(statement.first()).resolves.toBeNull();
  });

  it('omits empty params from the public REST query shape', async () => {
    const { requests, transport } = captureTransport(successResponse());
    await createD1RestDatabase({ transport }).prepare('SELECT 1').run();
    expect(JSON.parse(requests[0].body)).toEqual({ sql: 'SELECT 1' });
  });

  it('sends an ordered batch and returns only repository-compatible result fields', async () => {
    const { requests, transport } = captureTransport(successResponse([
      { success: true, results: [{ step: 1 }], meta: { changes: 1, rows_written: 1 } },
      { success: true, results: [{ step: 2 }], meta: { changes: 2, served_by_region: 'XX' } },
    ]));
    const db = createD1RestDatabase({ transport });
    const results = await db.batch([
      db.prepare('INSERT INTO synthetic VALUES (?1)').bind('first'),
      db.prepare('SELECT ?1 AS step').bind(2),
    ]);

    expect(JSON.parse(requests[0].body)).toEqual({
      batch: [
        { sql: 'INSERT INTO synthetic VALUES (?1)', params: ['first'] },
        { sql: 'SELECT ?1 AS step', params: [2] },
      ],
    });
    expect(results).toEqual([
      { success: true, results: [{ step: 1 }], meta: { changes: 1 } },
      { success: true, results: [{ step: 2 }], meta: { changes: 2 } },
    ]);
  });

  it('rejects invalid local input before invoking the transport', async () => {
    const transport = vi.fn<D1RestTransport>(async () => successResponse());
    const db = createD1RestDatabase({ transport });

    expect(() => db.prepare('   ')).toThrow(D1RestAdapterError);
    expect(() => db.prepare('SELECT ?1').bind(Number.NaN)).toThrow(D1RestAdapterError);
    await expectAdapterError(db.batch([]), 'invalid-request', 'not-sent');
    const other = createD1RestDatabase({ transport });
    await expectAdapterError(
      db.batch([other.prepare('SELECT 1')]),
      'invalid-request',
      'not-sent',
    );

    const detached = new ArrayBuffer(4);
    structuredClone(detached, { transfer: [detached] });
    expect(() => db.prepare('SELECT ?1').bind(detached)).toThrow(expect.objectContaining({
      kind: 'invalid-request',
      commitOutcome: 'not-sent',
    }));
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['http', async () => new Response('upstream secret', { status: 503 })],
    ['http', async () => new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [{ success: true, results: [], meta: { changes: 1 } }],
    }), { status: 202, headers: { 'content-type': 'application/json' } })],
    ['http', async () => new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [{ success: true, results: [], meta: { changes: 1 } }],
    }), { status: 206, headers: { 'content-type': 'application/json' } })],
    ['provider', async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: 'provider secret' }],
      messages: [],
      result: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['malformed-response', async () => new Response('{secret malformed', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })],
    ['malformed-response', async () => new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['malformed-response', async () => successResponse([
      { success: true, results: [], meta: {} },
    ])],
    ['malformed-response', async () => successResponse([
      { success: true, meta: { changes: 0 } },
    ])],
    ['provider', async () => successResponse([
      { success: false, results: [], meta: { changes: 0 }, error: 'secret' },
    ])],
    ['malformed-response', async () => successResponse([
      { success: true, error: 'contradictory failure', results: [], meta: { changes: 1 } },
    ])],
    ['malformed-response', async () => new Response(JSON.stringify({
      success: true,
      error: 'contradictory failure',
      errors: [],
      messages: [],
      result: [{ success: true, results: [], meta: { changes: 1 } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    ['malformed-response', async () => new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [{ success: true, results: [], meta: { changes: 1 } }],
    }), { status: 200, headers: { 'content-type': 'application/jsonp' } })],
  ] as const)('fails closed for %s responses', async (kind, transport) => {
    await expectAdapterError(
      createD1RestDatabase({ transport }).prepare('SELECT secret_marker').run(),
      kind,
    );
  });

  it('treats transport loss and timeout as unknown outcomes without retrying', async () => {
    const transportFailure = vi.fn<D1RestTransport>(async () => {
      throw new Error('raw credential and provider response');
    });
    await expectAdapterError(
      createD1RestDatabase({ transport: transportFailure })
        .prepare('UPDATE secret_sql').run(),
      'transport',
    );
    expect(transportFailure).toHaveBeenCalledTimes(1);

    const timeoutTransport = vi.fn<D1RestTransport>(async ({ signal }) => (
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('raw timeout detail'));
        });
      })
    ));
    await expectAdapterError(
      createD1RestDatabase({ transport: timeoutTransport, timeoutMs: 5 })
        .prepare('UPDATE maybe_committed').run(),
      'timeout',
    );
    expect(timeoutTransport).toHaveBeenCalledTimes(1);

    const bodyTimeoutTransport = vi.fn<D1RestTransport>(async () => new Response(
      new ReadableStream({ start() {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expectAdapterError(
      createD1RestDatabase({ transport: bodyTimeoutTransport, timeoutMs: 5 })
        .prepare('SELECT never_finishes').run(),
      'timeout',
    );
    expect(bodyTimeoutTransport).toHaveBeenCalledTimes(1);
  });

  it('redacts SQL, parameters, provider bodies, transport errors, and credentials', async () => {
    const secrets = [
      'sensitive_sql_marker',
      'sensitive_parameter_marker',
      'sensitive_provider_marker',
      'sensitive_bearer_marker',
    ];
    const transport: D1RestTransport = async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: `${secrets[2]} ${secrets[3]}` }],
      messages: [],
      result: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    let captured: unknown;
    try {
      await createD1RestDatabase({ transport })
        .prepare(`SELECT '${secrets[0]}' WHERE ?1`).bind(secrets[1]).run();
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(D1RestAdapterError);
    const visible = `${String(captured)}\n${(captured as Error).stack ?? ''}`;
    for (const secret of secrets) expect(visible).not.toContain(secret);
  });

  it.each(['missing', 'toString', 'constructor'])(
    'fails closed when named first column %s is absent',
    async (columnName) => {
      const { transport } = captureTransport(successResponse([
        { success: true, results: [{ other: 1 }], meta: { changes: 0 } },
      ]));
      await expectAdapterError(
        createD1RestDatabase({ transport }).prepare('SELECT other').first(columnName),
        'malformed-response',
      );
    },
  );
});
