#!/usr/bin/env node
import { readdirSync } from "node:fs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const files = readdirSync("db/migrations")
  .filter((name) => name.endsWith(".js"))
  .sort();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  const applied = await pool.query(`SELECT name, run_on FROM pgmigrations ORDER BY id`);
  const names = new Set(applied.rows.map((row) => row.name));
  process.stdout.write("Applied:\n");
  for (const row of applied.rows) {
    const when = row.run_on instanceof Date ? row.run_on.toISOString() : String(row.run_on);
    process.stdout.write(`  ${row.name}  ${when}\n`);
  }
  const pending = files.filter((file) => {
    const base = file.replace(/\.js$/, "");
    return !names.has(base) && !names.has(file);
  });
  process.stdout.write(`\nMigration files: ${files.length}\nApplied rows: ${applied.rows.length}\n`);
  if (pending.length) {
    process.stdout.write(`Pending:\n${pending.map((f) => `  ${f}`).join("\n")}\n`);
    process.exit(2);
  }
  process.stdout.write("db:status ok (all migration files applied)\n");
} finally {
  await pool.end();
}
