import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { resetDb } from "@dustinedwards/devkit/d1";

/** The parts of D1's binding resetDb uses, over node's SQLite: prepare, bind, all, run, and batch as one transaction. */
function d1(sqlite = new DatabaseSync(":memory:")) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...next) => statement(sql, next),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => (sqlite.prepare(sql).run(...args), { success: true }),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) sqlite.prepare(s.sql).run(...s.args);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const count = (db, table) => db.sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;

test("every table is emptied, including one no list names, and the schema stays", async () => {
  const db = d1();
  db.sqlite.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE "added later" (x TEXT);
    INSERT INTO people (email) VALUES ('a@test'), ('b@test');
    INSERT INTO "added later" VALUES ('y');
  `);
  const cleared = await resetDb(db);
  assert.deepEqual(cleared.sort(), ["added later", "people"]);
  assert.equal(count(db, "people"), 0);
  assert.equal(count(db, "added later"), 0);
  db.sqlite.exec("INSERT INTO people (email) VALUES ('c@test')");
  assert.equal(count(db, "people"), 1);
});

test("a full-text table is emptied through itself, its shadow tables left to it, and it still searches", async () => {
  const db = d1();
  db.sqlite.exec(`
    CREATE VIRTUAL TABLE items_fts USING fts5 (title, body);
    INSERT INTO items_fts VALUES ('one', 'phage capsid');
  `);
  const cleared = await resetDb(db);
  assert.deepEqual(cleared, ["items_fts"]);
  assert.equal(count(db, "items_fts"), 0);
  db.sqlite.exec("INSERT INTO items_fts VALUES ('two', 'capsomer')");
  assert.deepEqual(db.sqlite.prepare("SELECT title FROM items_fts WHERE items_fts MATCH 'capsomer'").all().map((r) => r.title), ["two"]);
});

test("foreign keys hold at the end, not between deletes, so the order tables are listed in does not matter", async () => {
  const db = d1();
  db.sqlite.exec(`
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id));
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    INSERT INTO parent VALUES (1);
    INSERT INTO child VALUES (1, 1);
  `);
  await assert.rejects(db.batch([db.prepare("DELETE FROM parent")]), /FOREIGN KEY/);
  await resetDb(db);
  assert.equal(count(db, "parent"), 0);
  assert.equal(count(db, "child"), 0);
});

test("the migrations record, SQLite's own tables and the keep list are left alone", async () => {
  const db = d1();
  db.sqlite.exec(`
    CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE settings (k TEXT);
    CREATE TABLE notes (n TEXT);
    CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO d1_migrations (name) VALUES ('0001_init.sql');
    INSERT INTO settings VALUES ('kept');
    INSERT INTO notes VALUES ('gone');
    INSERT INTO seq DEFAULT VALUES;
  `);
  const cleared = await resetDb(db, { keep: ["settings"] });
  assert.deepEqual(cleared.sort(), ["notes", "seq"]);
  assert.equal(count(db, "d1_migrations"), 1);
  assert.equal(count(db, "settings"), 1);
  assert.equal(count(db, "notes"), 0);
});

test("an empty database is a no-op", async () => {
  assert.deepEqual(await resetDb(d1()), []);
});
