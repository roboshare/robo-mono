#!/usr/bin/env node
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(scriptDir, "sql", "robomata-rental-persistence.sql");
const connectionString = process.env.POSTGRES_URL?.trim();

if (!connectionString) {
  console.error("POSTGRES_URL is required to bootstrap Robomata rental persistence.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
});

try {
  const schema = await readFile(schemaPath, "utf8");
  await sql.unsafe(schema);
  console.log("Robomata rental persistence schema is ready.");
} finally {
  await sql.end({ timeout: 5 });
}
