/* Shared env fixture for foundation tests.

   Not a *.test.ts file, so `node --test dist-test/test/*.test.js` never runs
   it. It exists so every test builds an explicit environment instead of
   depending on the developer's backend/.env (which the legacy adapter loads). */

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PORT: "4000",
    CLIENT_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/aeychhotu",
    STAFF_PIN: "1234",
    ADMIN_PIN: "998877",
    KDS_TOKEN_SECRET: "unit-test-secret-value",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}
