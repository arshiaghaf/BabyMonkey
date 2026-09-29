import type {
  D1Bindable,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../../site/server/d1/types.ts';

type JsonBindable = string | number | null | number[];

interface RestQuery {
  sql: string;
  params: JsonBindable[];
}

type RestPayloadQuery = { sql: string; params?: JsonBindable[] };

export interface D1RestTransportRequest {
  method: 'POST';
  headers: Readonly<Record<'content-type', 'application/json'>>;
  body: string;
  signal: AbortSignal;
}

export type D1RestTransport = (
  request: D1RestTransportRequest,
) => Promise<Response>;

export type D1RestFailureKind =
  | 'invalid-request'
  | 'timeout'
  | 'transport'
  | 'http'
  | 'provider'
  | 'malformed-response';

export type D1RestCommitOutcome = 'not-sent' | 'unknown';

export class D1RestAdapterError extends Error {
  readonly kind: D1RestFailureKind;
  readonly commitOutcome: D1RestCommitOutcome;

  constructor(kind: D1RestFailureKind, commitOutcome: D1RestCommitOutcome) {
    super(`Cloudflare D1 REST request failed (${kind}; commit outcome ${commitOutcome}).`);
    this.name = 'D1RestAdapterError';
    this.kind = kind;
    this.commitOutcome = commitOutcome;
  }
}

export interface D1RestAdapterOptions {
  transport: D1RestTransport;
  timeoutMs?: number;
}

const invalidRequest = () => new D1RestAdapterError('invalid-request', 'not-sent');

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const serializeBinding = (value: D1Bindable): JsonBindable => {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidRequest();
    return value;
  }
  try {
    if (value instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(value));
    }
    if (ArrayBuffer.isView(value)) {
      return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {
    throw invalidRequest();
  }
  throw invalidRequest();
};

const hasContradictoryFailureMarker = (value: Record<string, unknown>) => (
  'error' in value || 'failure' in value
);

const normalizeResult = <T>(value: unknown): D1ResultLike<T> => {
  if (!isRecord(value)) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  if (value.success === false) {
    throw new D1RestAdapterError('provider', 'unknown');
  }
  if (value.success !== true) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  if (hasContradictoryFailureMarker(value) || 'errors' in value) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  if (!Array.isArray(value.results) || !isRecord(value.meta)) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  const changes = value.meta.changes;
  if (
    typeof changes !== 'number'
    || !Number.isInteger(changes)
    || changes < 0
  ) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  if (value.results.some((row) => !isRecord(row))) {
    throw new D1RestAdapterError('malformed-response', 'unknown');
  }
  return {
    success: true,
    results: value.results as T[],
    meta: { changes },
  };
};

const requestQuery = (query: RestQuery): RestPayloadQuery => (
  query.params.length === 0
    ? { sql: query.sql }
    : { sql: query.sql, params: query.params }
);

class RestPreparedStatement implements D1PreparedStatementLike {
  readonly owner: RestD1Database;
  readonly query: RestQuery;

  constructor(owner: RestD1Database, sql: string, params: JsonBindable[] = []) {
    this.owner = owner;
    this.query = { sql, params };
  }

  bind(...values: D1Bindable[]): D1PreparedStatementLike {
    return new RestPreparedStatement(
      this.owner,
      this.query.sql,
      values.map(serializeBinding),
    );
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const [result] = await this.owner.execute<T>([this.query], false);
    const row = result?.results?.[0];
    if (row === undefined) return null;
    if (columnName === undefined) return row;
    if (!isRecord(row) || !Object.hasOwn(row, columnName)) {
      throw new D1RestAdapterError('malformed-response', 'unknown');
    }
    return row[columnName] as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const [result] = await this.owner.execute<T>([this.query], false);
    if (!result) throw new D1RestAdapterError('malformed-response', 'unknown');
    return result;
  }
}

class RestD1Database implements D1DatabaseLike {
  readonly transport: D1RestTransport;
  readonly timeoutMs: number;

  constructor(options: D1RestAdapterOptions) {
    if (
      typeof options.transport !== 'function'
      || (options.timeoutMs !== undefined
        && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1))
    ) {
      throw invalidRequest();
    }
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  prepare(query: string): D1PreparedStatementLike {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw invalidRequest();
    }
    return new RestPreparedStatement(this, query);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]> {
    if (statements.length === 0) throw invalidRequest();
    const queries = statements.map((statement) => {
      if (!(statement instanceof RestPreparedStatement) || statement.owner !== this) {
        throw invalidRequest();
      }
      return statement.query;
    });
    return this.execute<T>(queries, true);
  }

  async execute<T>(queries: RestQuery[], batch: boolean): Promise<D1ResultLike<T>[]> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new D1RestAdapterError('timeout', 'unknown'));
      }, this.timeoutMs);
    });

    try {
      let response: Response;
      try {
        const payload = batch
          ? { batch: queries.map(requestQuery) }
          : requestQuery(queries[0]);
        response = await Promise.race([
          this.transport({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch {
        throw new D1RestAdapterError(
          timedOut ? 'timeout' : 'transport',
          'unknown',
        );
      }

      if (timedOut) throw new D1RestAdapterError('timeout', 'unknown');
      if (!(response instanceof Response)) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      if (response.status !== 200) {
        throw new D1RestAdapterError('http', 'unknown');
      }
      const contentType = response.headers.get('content-type');
      const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }

      let envelope: unknown;
      try {
        envelope = await Promise.race([response.json(), deadline]);
      } catch {
        throw new D1RestAdapterError(
          timedOut ? 'timeout' : 'malformed-response',
          'unknown',
        );
      }
      if (timedOut) throw new D1RestAdapterError('timeout', 'unknown');
      if (!isRecord(envelope)) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      if (hasContradictoryFailureMarker(envelope)) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      if (envelope.success === false) {
        throw new D1RestAdapterError('provider', 'unknown');
      }
      if (envelope.success !== true || !Array.isArray(envelope.errors)) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      if (envelope.errors.length !== 0) {
        throw new D1RestAdapterError('provider', 'unknown');
      }
      if (!Array.isArray(envelope.messages) || !Array.isArray(envelope.result)) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      if (envelope.result.length !== queries.length) {
        throw new D1RestAdapterError('malformed-response', 'unknown');
      }
      return envelope.result.map((result) => normalizeResult<T>(result));
    } finally {
      clearTimeout(timeout!);
    }
  }
}

export const createD1RestDatabase = (
  options: D1RestAdapterOptions,
): D1DatabaseLike => new RestD1Database(options);
