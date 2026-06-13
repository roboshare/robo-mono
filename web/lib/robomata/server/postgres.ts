import postgres, { type Sql } from "postgres";
import "server-only";

let client: Sql | undefined;

function robomataPostgresConnectionString() {
  const connectionString = process.env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("POSTGRES_URL is required for Robomata Postgres persistence.");
  }
  return connectionString;
}

export function createRobomataPostgresSql(): Sql {
  return postgres(robomataPostgresConnectionString(), {
    max: 1,
    prepare: false,
  });
}

export function getRobomataPostgresSql(): Sql {
  if (client) return client;

  client = createRobomataPostgresSql();

  return client;
}
