const { Pool } = require("pg");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const DB_NAME = requireEnv("DB_NAME");
const DB_USER = requireEnv("DB_USER");
const DB_PASS = requireEnv("DB_PASS");
// Example: "final-year-project:europe-west2:sonar"
const INSTANCE_CONNECTION_NAME = requireEnv("https://sonar-api-75840676273.europe-west2.run.app");

// Cloud SQL Postgres uses a unix socket on Cloud Run:
const pool = new Pool({
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  host: `/cloudsql/${INSTANCE_CONNECTION_NAME}`,
  // optional:
  max: 5,
  idleTimeoutMillis: 30000
});

module.exports = { pool };