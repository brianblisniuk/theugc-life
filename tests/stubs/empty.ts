// Stub for `server-only` under Vitest. The real package throws when imported
// outside a React Server context; in unit tests we alias it to this no-op so
// server modules can be imported and their pure helpers exercised.
export {};
