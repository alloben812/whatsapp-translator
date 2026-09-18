import { DatabaseSync } from 'node:sqlite';

const [major, minor] = process.versions.node.split('.').map(Number);
const runtimeOk = major > 22 || (major === 22 && minor >= 17);
const database = new DatabaseSync(':memory:');
const sqliteOk = database.prepare('SELECT 1 AS ok').get().ok === 1;
database.close();

console.log(JSON.stringify({
  node: process.versions.node,
  runtimeOk,
  sqliteOk,
  mode: 'offline-foundation',
  whatsappConnected: false,
  modelConnected: false,
  note: 'Checks runtime only. No credentials read, network requests, or live connections.',
}, null, 2));
if (!runtimeOk || !sqliteOk) process.exitCode = 1;
