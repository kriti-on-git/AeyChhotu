## Verification Scope Rule

For each module refactoring phase:

1. Run the module's focused tests.
2. Run TypeScript type-checking.
3. Run only the directly relevant integration tests.
4. Run `git diff --check`.
5. Report the exact files changed and test results.

**Do not independently run the entire backend test suite, production build, boot smoke tests, authentication smoke tests, shutdown tests, Docker lifecycle checks, or the full CI pipeline.**

Only run broader regression checks when:
- The current change directly affects shared infrastructure or application bootstrap; or
- I explicitly authorize broader verification.

Do not expand the task just because additional checks are available.

Stop after the requested module is implemented and its scoped verification passes. Do not commit, push, or begin another module without authorization.