declare namespace Cloudflare {
  interface Env {
    TEST_DB: D1Database;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
