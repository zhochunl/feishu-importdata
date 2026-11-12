import fs from 'node:fs';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { BufferIoContext, ReadStatParser, parseSas7bdat } from '@irbisadm/statfmt';

const zipPath = process.argv[2];
const entryName = process.argv[3];
const password = process.argv[4];

const blob = new Blob([fs.readFileSync(zipPath)]);
const reader = new ZipReader(new BlobReader(blob), { password });
const entries = await reader.getEntries();
const entry = entries.find(e => e.filename === entryName);
console.log('entry', entry.filename, 'uncompressed', entry.uncompressedSize, 'encrypted', entry.encrypted);

const bytes = await entry.getData(new Uint8ArrayWriter(), { password });
console.log('bytes', bytes.length);

const base = new BufferIoContext(bytes);
let reads = 0, seeks = 0, back = 0, maxBack = 0, readBytes = 0, lastTell = 0;
const io = {
  read(n) { reads++; readBytes += n; const t = base.tell(); if (t < lastTell) { back++; maxBack = Math.max(maxBack, lastTell - t); } lastTell = t; return base.read(n); },
  seek(o, w) { seeks++; const r = base.seek(o, w); if (r < lastTell) { back++; maxBack = Math.max(maxBack, lastTell - r); } lastTell = r; return r; },
  tell() { return base.tell(); },
  size() { return base.size(); },
};

let vars = [];
let rows = 0, cells = 0, meta = null;
const parser = new ReadStatParser();
parser.setMetadataHandler(m => { meta = { rows: m.rowCount, vars: m.varCount, name: m.name, label: m.label, encoding: m.fileEncoding, created: m.creationTime }; });
parser.setVariableHandler((i, v) => { vars.push({ i, name: v.name, type: v.type, w: v.storageWidth, fmt: v.format, label: v.label }); });
parser.setValueHandler((obs, v, val) => { cells++; rows = Math.max(rows, obs + 1); });
parser.setErrorHandler(m => console.log('ERR', m));
const t0 = Date.now();
const err = parseSas7bdat(parser, io, null);
console.log('parse err', err, 'ms', Date.now() - t0);
console.log('meta', meta);
console.log('vars', vars.length, vars.slice(0, 8));
console.log('rows', rows, 'cells', cells);
console.log('io', { reads, seeks, back, maxBack, readBytes, fileBytes: bytes.length });
await reader.close();