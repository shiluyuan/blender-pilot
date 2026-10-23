// Separate schema per test worker. All assertions still use pg's TCP driver.
if (!process.env.DATABASE_URL)
  throw new Error(
    "Run tests through npm test, or provide a disposable DATABASE_URL.",
  );
process.env.PILOT_DB_SCHEMA = "pilot_test_worker_" + process.pid;
