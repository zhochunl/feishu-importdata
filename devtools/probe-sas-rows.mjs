import fs from 'node:fs';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { BufferIoContext, ReadStatParser, ReadStatType, parseSas7bdat, valueIsMissing } from '@irbisadm/statfmt';

const [zipPath, entryName, password, limit = '2'] = process.argv.slice(2);

const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(zipPath)])), { password });
const entry = (await reader.getEntries()).find(e => e.filename === entryName);
const bytes = await entry.getData(new Uint8ArrayWriter(), { password });

const vars = [];
const rows = [];
const parser = new ReadStatParser();
parser.setRowLimit(Number(limit));
parser.setVariableHandler((_i, v) => {
  vars.push({ name: v.name, type: v.type, fmt: v.format });
});
parser.setValueHandler((obs, v, val) => {
  if (!rows[obs]) rows[obs] = {};
  const info = vars[v.index];
  if (val.isSystemMissing || val.isTaggedMissing || valueIsMissing(val, v)) {
    rows[obs][info.name] = null;
  } else if (info.type === ReadStatType.STRING || info.type === ReadStatType.STRING_REF) {
    rows[obs][info.name] = val.stringValue();
  } else {
    rows[obs][info.name] = val.doubleValue();
  }
});
parser.setErrorHandler(m => console.log('ERR', m));
console.log('parse err', parseSas7bdat(parser, new BufferIoContext(bytes), null));

const SAS_EPOCH = Date.UTC(1960, 0, 1);
const dateVars = vars.filter(v => /^(DATE|DATETIME|DDMMYY|YYMMDD|MMDDYY|MONYY|YYMON)/i.test(v.fmt));
console.log('date columns', dateVars.map(v => `${v.name}[${v.fmt}]`).join(', '));
for (const [i, row] of rows.entries()) {
  console.log(`--- row ${i} ---`);
  for (const v of dateVars) {
    const raw = row[v.name];
    const isDate = !/^DATETIME/i.test(v.fmt);
    const iso = raw === null ? null : new Date(raw * (isDate ? 86400000 : 1000) + SAS_EPOCH).toISOString();
    console.log(` ${v.name} raw=${raw} iso=${iso}`);
  }
  console.log(' first cells', JSON.stringify(Object.fromEntries(Object.entries(row).slice(0, 6))));
}
await reader.close();