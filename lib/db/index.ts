import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Single connection pool for the entire app
const client = postgres(connectionString, {
  max: 10,                  // max connections in pool
  idle_timeout: 20,         // close idle connections after 20s
  connect_timeout: 10,      // fail connection after 10s
});

export const db = drizzle(client, { schema });

// Re-export schema for convenience
export { schema };
