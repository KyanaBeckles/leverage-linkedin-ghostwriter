// Minimal D1Database stand-in: routes each prepared statement to a canned
// result by matching its SQL, and records every call so tests can assert on
// what the Worker actually wrote. Not a SQL engine — the jobs only ever run a
// handful of fixed statements, so matching them is enough and keeps the tests
// free of a real D1 instance.

export interface FakeRoute {
  /** Matched against the SQL text of the prepared statement. */
  match: RegExp;
  /** Rows for `.all()` / `.first()`. */
  rows?: Record<string, unknown>[];
  /** `meta` for `.run()`, e.g. `{ last_row_id: 7 }`. */
  meta?: Record<string, unknown>;
  /** Throw instead of returning, to simulate a D1 failure. */
  error?: string;
}

export interface FakeCall {
  sql: string;
  params: unknown[];
}

export interface FakeD1 {
  db: D1Database;
  calls: FakeCall[];
  /** Calls whose SQL matches, for compact assertions. */
  matching(pattern: RegExp): FakeCall[];
}

export function createFakeD1(routes: FakeRoute[]): FakeD1 {
  const calls: FakeCall[] = [];

  const resolve = (sql: string): FakeRoute => {
    const route = routes.find((r) => r.match.test(sql));
    if (!route) throw new Error(`No fake D1 route matches SQL: ${sql}`);
    if (route.error) throw new Error(route.error);
    return route;
  };

  const db = {
    prepare(sql: string) {
      let bound = false;
      const record = () => {
        if (!bound) calls.push({ sql, params: [] });
      };
      const statement = {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          bound = true;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          record();
          return (resolve(sql).rows?.[0] ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          record();
          return { results: (resolve(sql).rows ?? []) as T[] };
        },
        async run() {
          record();
          return { meta: resolve(sql).meta ?? { last_row_id: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return { db, calls, matching: (pattern) => calls.filter((c) => pattern.test(c.sql)) };
}
