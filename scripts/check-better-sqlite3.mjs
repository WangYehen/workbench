import Database from "better-sqlite3";

const database = new Database(":memory:");
database.close();
