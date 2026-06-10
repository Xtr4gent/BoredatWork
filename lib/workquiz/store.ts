import fs from "node:fs";
import path from "node:path";

import { Pool, PoolClient } from "pg";
import { StoreShape } from "@/lib/workquiz/types";
import { nanoid } from "nanoid";

const dataDirectory = path.join(process.cwd(), "data");
const dataFile = path.join(dataDirectory, "workquiz.json");
const STORE_ROW_ID = "default";

declare global {
  var __workquizPgPool: Pool | undefined;
  var __workquizPgEnsured: boolean | undefined;
}

function initialStore(): StoreShape {
  return {
    brackets: [],
  };
}

function hasPostgresStore() {
  return Boolean(process.env.DATABASE_URL);
}

function ensureStorageConfigured() {
  const allowFileStore = process.env.WORKQUIZ_ALLOW_FILE_STORE === "true";
  if (process.env.NODE_ENV === "production" && !hasPostgresStore() && !allowFileStore) {
    throw new Error(
      "DATABASE_URL is required in production. Refusing to use ephemeral file storage for WorkQuiz data.",
    );
  }
}

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Postgres storage.");
  }

  globalThis.__workquizPgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  return globalThis.__workquizPgPool;
}

function repairStore(store: StoreShape) {
  let changed = false;

  for (const bracket of store.brackets as Array<
    StoreShape["brackets"][number] & { rosterMembers?: Array<{ id: string; name: string }> }
  >) {
    if (!bracket.rosterMembers?.length) {
      bracket.rosterMembers = Array.from({ length: bracket.totalPlayers ?? 0 }, (_, index) => ({
        id: `legacy-roster-${index + 1}-${nanoid(6)}`,
        name: `Player ${index + 1}`,
      }));
      changed = true;
    }
  }

  return { store, changed };
}

// The schema is created once per process. Re-running CREATE TABLE + INSERT
// on every read/write tripled the Postgres round-trips for each request.
async function ensurePostgresStore(client: Pool | PoolClient) {
  if (globalThis.__workquizPgEnsured) {
    return;
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS workquiz_store (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(
    `
      INSERT INTO workquiz_store (id, data)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [STORE_ROW_ID, JSON.stringify(initialStore())],
  );

  globalThis.__workquizPgEnsured = true;
}

function ensureFileStore() {
  ensureStorageConfigured();

  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(initialStore(), null, 2), "utf8");
  }
}

export async function ensureStore() {
  ensureStorageConfigured();

  if (hasPostgresStore()) {
    await ensurePostgresStore(getPool());
    return;
  }

  ensureFileStore();
}

export async function readStore(): Promise<StoreShape> {
  ensureStorageConfigured();

  if (hasPostgresStore()) {
    const pool = getPool();
    await ensurePostgresStore(pool);
    const result = await pool.query<{ data: StoreShape }>(
      "SELECT data FROM workquiz_store WHERE id = $1",
      [STORE_ROW_ID],
    );
    const current = result.rows[0]?.data ?? initialStore();
    const { store, changed } = repairStore(current);

    if (changed) {
      await writeStore(store);
    }

    return store;
  }

  ensureFileStore();
  const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8")) as StoreShape;
  const { store, changed } = repairStore(parsed);

  if (changed) {
    await writeStore(store);
  }

  return store;
}

export async function writeStore(store: StoreShape) {
  ensureStorageConfigured();

  if (hasPostgresStore()) {
    const pool = getPool();
    await ensurePostgresStore(pool);
    await pool.query(
      `
        INSERT INTO workquiz_store (id, data, updated_at)
        VALUES ($1, $2::jsonb, now())
        ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `,
      [STORE_ROW_ID, JSON.stringify(store)],
    );
    return;
  }

  ensureFileStore();
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf8");
}

export async function updateStore(mutator: (store: StoreShape) => StoreShape | Promise<StoreShape>) {
  ensureStorageConfigured();

  if (hasPostgresStore()) {
    const pool = getPool();
    await ensurePostgresStore(pool);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<{ data: StoreShape }>(
        "SELECT data FROM workquiz_store WHERE id = $1 FOR UPDATE",
        [STORE_ROW_ID],
      );
      const current = repairStore(result.rows[0]?.data ?? initialStore()).store;
      const next = await mutator(current);
      await client.query(
        "UPDATE workquiz_store SET data = $2::jsonb, updated_at = now() WHERE id = $1",
        [STORE_ROW_ID, JSON.stringify(next)],
      );
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const current = await readStore();
  const next = mutator(current);
  const resolvedNext = await next;
  await writeStore(resolvedNext);
  return resolvedNext;
}
