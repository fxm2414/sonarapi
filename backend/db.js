// Imports the PostgreSQL client for Node.js.
// The Pool class is used to manage multiple database connections efficiently.
const { Pool } = require("pg");

// Helper function to safely retrieve environment variables.
// Ensures required configuration values are present at runtime.
// If a variable is missing, the server will immediately throw an error,
// preventing silent failures later in execution.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Retrieve required database configuration from environment variables.
// These are set during deployment in Cloud Run (via cloudbuild.yaml).
const DB_NAME = requireEnv("DB_NAME");
const DB_USER = requireEnv("DB_USER");
const DB_PASS = requireEnv("DB_PASS");

// Cloud SQL instance connection name in the format:
// "<project-id>:<region>:<instance-name>"
const INSTANCE_CONNECTION_NAME = requireEnv("INSTANCE_CONNECTION_NAME");

// Create a PostgreSQL connection pool.
// A connection pool allows multiple queries to be handled efficiently
// without opening a new database connection for every request.
const pool = new Pool({
  user: DB_USER,        // Database username
  password: DB_PASS,    // Database password
  database: DB_NAME,    // Database name

  // IMPORTANT:
  // On Google Cloud Run, Cloud SQL is accessed via a Unix socket,
  // not a traditional TCP/IP host and port.
  // The socket is mounted at /cloudsql/<INSTANCE_CONNECTION_NAME>.
  host: `/cloudsql/${INSTANCE_CONNECTION_NAME}`,

  // Maximum number of concurrent connections in the pool.
  // Kept low here (5) to suit Cloud Run’s lightweight scaling model.
  max: 5,

  // Time (in ms) a connection can remain idle before being closed.
  // Helps free unused resources.
  idleTimeoutMillis: 30000
});

// Export the pool so it can be reused across the backend (e.g. in API routes).
// This avoids repeatedly creating new connections and improves performance.
module.exports = { pool };


// References:
// 1. node-postgres (pg) documentation:
//    https://node-postgres.com/apis/pool
// 2. Google Cloud SQL connection via Unix sockets:
//    https://cloud.google.com/sql/docs/postgres/connect-run
// 3. General connection pooling concepts adapted from standard database design practices.
