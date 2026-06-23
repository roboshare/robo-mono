import postgres, { type Sql } from "postgres";
import "server-only";

let client: Sql | undefined;

export function getRobomataPostgresSql(): Sql {
  if (client) return client;

  const connectionString = process.env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("POSTGRES_URL is required for Robomata Postgres persistence.");
  }

  client = postgres(connectionString, {
    max: 1,
    prepare: false,
  });

  return client;
}
