import fs from 'node:fs';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { BufferIoContext, ReadStatParser, parseSas7bdat } from '@irbisadm/statfmt';

const [zipPath, entryName, password] = process.argv.slice(2);
const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(zipPath)])), { password });
const entry = (await reader.getEntries()).find(e => e.filename === entryName);
const bytes = await entry.getData(new Uint8ArrayWriter(), { password });
console.log('file', entryName, bytes.length);

const base = new BufferIoContext(bytes);
const ranges = [];
const seekTargets = new Map();
const io = {
  read(n) { const t = base.tell(); ranges.push([t, t + n]); return base.read(n); },
  seek(o, w) { const r = base.seek(o, w); seekTargets.set(r, (seekTargets.get(r) || 0) + 1); return r; },
  tell: () => base.tell(),
  size: () => base.size(),
};
const parser = new ReadStatParser();
let meta = null, vars = 0, cells = 0, rows = 0;
parser.setMetadataHandler(m => { meta = { rows: m.rowCount, vars: m.varCount, enc: m.fileEncoding }; });
parser.setVariableHandler(() => { vars++; });
parser.setValueHandler(obs => { cells++; rows = Math.max(rows, obs + 1); });
const t0 = Date.now();
const err = parseSas7bdat(parser, io, null);
console.log('err', err, 'ms', Date.now() - t0, 'meta', meta, 'vars', vars, 'rows', rows, 'cells', cells);

ranges.sort((a, b) => a[0] - b[0]);
let touched = 0, end = -1, blocks = 0;
for (const [s, e] of ranges) {
  if (s > end) { touched += e - s; end = e; blocks++; }
  else if (e > end) { touched += e - end; end = e; }
}
console.log('read calls', ranges.length, 'touched bytes', touched, `(${(touched / bytes.length * 100).toFixed(1)}%)`, 'blocks', blocks);
const top = [...seekTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('top seek targets', top);
const far = [...seekTargets.keys()].filter(o => o > bytes.length * 0.5).length;
console.log('distinct seek targets', seekTargets.size, 'in second half', far);
await reader.close();