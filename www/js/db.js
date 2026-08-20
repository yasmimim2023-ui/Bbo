/**
 * Storage layer for Bbo.
 *
 * On Android the app talks to real SQLite through the
 * @capacitor-community/sqlite plugin, reached via the bridge that Capacitor
 * injects into the WebView (`window.Capacitor.Plugins.CapacitorSQLite`).
 * In a plain browser — `npm start` during development — there is no native
 * plugin, so a localStorage-backed shim with the same interface takes over.
 */

const DB_NAME = "bbo";
const DB_VERSION = 1;
const STORAGE_KEY = "bbo.notes";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes (created_at DESC);
`;

function nativePlugin() {
  const cap = globalThis.Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.CapacitorSQLite ?? null;
}

function createSqliteBackend(sqlite) {
  const db = { database: DB_NAME, readonly: false };

  return {
    name: "sqlite",

    async init() {
      await sqlite.createConnection({
        database: DB_NAME,
        encrypted: false,
        mode: "no-encryption",
        version: DB_VERSION,
        readonly: false,
      });
      await sqlite.open(db);
      await sqlite.execute({ ...db, statements: SCHEMA, transaction: true });
    },

    async all() {
      const result = await sqlite.query({
        ...db,
        statement:
          "SELECT id, text, created_at FROM notes ORDER BY created_at DESC, id DESC;",
        values: [],
      });
      return (result.values ?? []).map((row) => ({
        id: row.id,
        text: row.text,
        createdAt: row.created_at,
      }));
    },

    async add(text) {
      await sqlite.run({
        ...db,
        statement: "INSERT INTO notes (text, created_at) VALUES (?, ?);",
        values: [text, Date.now()],
      });
    },

    async remove(id) {
      await sqlite.run({
        ...db,
        statement: "DELETE FROM notes WHERE id = ?;",
        values: [id],
      });
    },

    async clear() {
      await sqlite.run({ ...db, statement: "DELETE FROM notes;", values: [] });
    },
  };
}

function createLocalBackend() {
  const read = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };
  const write = (rows) =>
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));

  return {
    name: "localStorage (dev)",
    async init() {},
    async all() {
      return read().sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    },
    async add(text) {
      const rows = read();
      const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
      rows.push({ id, text, createdAt: Date.now() });
      write(rows);
    },
    async remove(id) {
      write(read().filter((row) => row.id !== id));
    },
    async clear() {
      write([]);
    },
  };
}

let backend = null;

export async function openDatabase() {
  if (backend) return backend;

  const sqlite = nativePlugin();
  backend = sqlite ? createSqliteBackend(sqlite) : createLocalBackend();
  await backend.init();
  return backend;
}
