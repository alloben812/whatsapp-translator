#!/usr/bin/env node
import { connect } from 'node:net';

// Fixed private socket; this process never receives subscription credentials.
const socketPath = '/run/whatsapp-translator-broker.sock';
const check = process.argv.length === 3 && process.argv[2] === '--check';
if ((!check && process.argv.length !== 2)) process.exit(1);
let input = Buffer.alloc(0);
if (!check) {
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, chunk]);
    if (input.length > 20000) process.exit(1);
  }
}
let payload;
try { payload = check ? { operation: 'check' } : { operation: 'translate', input: JSON.parse(input.toString('utf8')) }; }
catch { process.exit(1); }
const socket = connect({ path: socketPath, allowHalfOpen: true });
let output = Buffer.alloc(0);
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, check ? 9000 : 72000);
socket.on('connect', () => socket.end(JSON.stringify(payload)));
socket.on('data', chunk => {
  output = Buffer.concat([output, chunk]);
  if (output.length > 65536) { socket.destroy(); process.exitCode = 1; }
});
socket.on('end', () => {
  clearTimeout(timer);
  try {
    const value = JSON.parse(output.toString('utf8'));
    if (value && typeof value === 'object') process.stdout.write(JSON.stringify(value));
    else process.exitCode = 1;
  } catch { process.exitCode = 1; }
  socket.destroy();
});
socket.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
socket.on('close', () => clearTimeout(timer));
