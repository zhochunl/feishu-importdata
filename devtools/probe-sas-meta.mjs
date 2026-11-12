import fs from 'node:fs';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { BufferIoContext, ReadStatParser, parseSas7bdat } from '@irbisadm/statfmt';

const [zipPath, entryName, password] = process.argv.slice(2);
const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(zipPath)])), { password });
const entry = (await reader.getEntries()).find(e => e.filename === entryName);

let t = Date.now();
const bytes = await entry.getData(new Uint8ArrayWriter(), { password });
console.log('inflate ms', Date.now() - t, 'bytes', bytes.length);

const io = new BufferIoContext(bytes);
const parser = new ReadStatParser();
let meta = null; const vars = [];
parser.setMetadataHandler(m => { meta = { rows: m.rowCount, vars: m.varCount, enc: m.fileEncoding, table: m.tableName }; });
parser.setVariableHandler((i, v) => { vars.push({ name: v.name, type: v.type, w: v.storageWidth, fmt: v.format }); });
t = Date.now();
const err = parseSas7bdat(parser, io, null);
console.log('meta-only parse err', err, 'ms', Date.now() - t, meta);
console.log('sample vars', vars.slice(0, 6), vars.filter(v => /DATE|DT|YYMM|MMDD/i.test(v.fmt || '')).slice(0, 6));
await reader.close();