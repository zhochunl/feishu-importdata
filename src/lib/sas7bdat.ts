import {
  BufferIoContext,
  ReadStatError,
  ReadStatParser,
  ReadStatType,
  parseSas7bdat,
  valueIsMissing,
  type ReadStatValue,
  type Variable,
} from '@irbisadm/statfmt';
import { type CellValue, type DomainBatch, type DomainCursor, type DomainMeta, type FieldKind } from './domain';

export interface SasColumn {
  name: string;
  kind: FieldKind;
  /** SAS 的 DATE 系格式存的是天数，DATETIME 存的是秒数 */
  dateOnly: boolean;
  label: string;
}

export interface SasScan {
  meta: DomainMeta;
  columns: SasColumn[];
}

/** SAS 纪元是 1960-01-01，早于 Unix 纪元 315619200 秒。 */
const SAS_EPOCH_MS = Date.UTC(1960, 0, 1);
const MAX_MS = 8.64e15;

const DATE_FORMATS = new Set([
  'DATE', 'DDMMYY', 'YYMMDD', 'MMDDYY', 'YMMDD', 'JULIAN', 'MONYY', 'YYMON', 'YYQ',
  'WEEKDATE', 'WORDDATE', 'WORDDATX', 'DOWNAME', 'QTR', 'NENGO', 'MINGUO', 'DAY', 'MONTH', 'YEAR',
]);

/** 格式名带宽度与小数位（DATETIME22.3 / DATE9），去掉尾缀才是格式本体。 */
function formatKind(format: string): { kind: FieldKind; dateOnly: boolean } {
  const base = format.toUpperCase().replace(/[\d.]+$/, '');
  if (base === 'DATETIME') return { kind: 'datetime', dateOnly: false };
  if (DATE_FORMATS.has(base)) return { kind: 'datetime', dateOnly: true };
  return { kind: 'number', dateOnly: false };
}

function sasTimeToIso(value: number, dateOnly: boolean): string | null {
  const ms = Math.round(dateOnly ? value * 86400000 + SAS_EPOCH_MS : value * 1000 + SAS_EPOCH_MS);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return null;
  // 不带 Z：SAS 存的是墙上时间，按本地时区解析才能原样显示
  const iso = new Date(ms).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.slice(0, 23);
}

function cellValue(value: ReadStatValue, variable: Variable, column: SasColumn): CellValue {
  if (value.isSystemMissing || value.isTaggedMissing || valueIsMissing(value, variable)) return null;
  if (column.kind === 'text') {
    const text = value.stringValue()?.trim();
    return text ? text : null;
  }
  const num = value.doubleValue();
  if (!Number.isFinite(num)) return null;
  return column.kind === 'datetime' ? sasTimeToIso(num, column.dateOnly) : num;
}

function describeError(code: ReadStatError, fileName: string): Error {
  if (code === ReadStatError.ERROR_UNSUPPORTED_CHARSET) {
    return new Error(`${fileName} 的字符编码不受支持，无法解析`);
  }
  if (code === ReadStatError.ERROR_UNSUPPORTED_COMPRESSION) {
    return new Error(`${fileName} 使用了不支持的 SAS 压缩方式`);
  }
  return new Error(`${fileName} 解析失败（ReadStat 错误码 ${code}）`);
}

/**
 * 只读元信息与列定义：不挂 value handler，整表单元格不会被解码。
 * 注意 handler 不能返回数字——ReadStat 把 1 当成 ABORT。
 */
export function scanSas7bdat(fileName: string, bytes: Uint8Array): SasScan {
  const parser = new ReadStatParser();
  let rowCount = 0;
  let tableName = '';
  const columns: SasColumn[] = [];

  parser.setMetadataHandler(metadata => {
    rowCount = metadata.rowCount;
    tableName = metadata.tableName ?? '';
  });
  parser.setVariableHandler((_index, variable) => {
    const text = variable.type === ReadStatType.STRING || variable.type === ReadStatType.STRING_REF;
    const { kind, dateOnly } = text ? { kind: 'text' as FieldKind, dateOnly: false } : formatKind(variable.format);
    columns.push({ name: variable.name, kind, dateOnly, label: variable.label ?? '' });
  });
  parser.setErrorHandler(() => {});

  const code = parseSas7bdat(parser, new BufferIoContext(bytes), null);
  if (code !== ReadStatError.OK) throw describeError(code, fileName);
  if (!columns.length) throw new Error(`${fileName} 里没有列定义`);

  const fallback = fileName.replace(/^.*[\\/]/, '').replace(/\.sas7bdat$/i, '').toUpperCase();
  return {
    meta: {
      fileName,
      tableName: tableName || fallback,
      rowCount,
      columns: columns.map(column => ({ name: column.name, kind: column.kind, label: column.label })),
    },
    columns,
  };
}

/**
 * 分批取行。sas7bdat 的页需要从文件尾部回读，无法只解压前缀，
 * 所以整域字节必须常驻；但行是推模式产出的，用 rowOffset 逐批重放，
 * 跳过已消费的行时不解码单元格，内存里只留当前这一批。
 */
export class Sas7bdatCursor implements DomainCursor {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly columns: SasColumn[],
    private readonly rowCount: number,
  ) {}

  next(limit: number): DomainBatch {
    if (this.offset >= this.rowCount) return { rows: [], done: true };

    const rows: Array<Array<[string, CellValue]>> = [];
    let current: Array<[string, CellValue]> | null = null;
    let lastObs = -1;

    const parser = new ReadStatParser();
    parser.setRowOffset(this.offset);
    parser.setRowLimit(limit);
    parser.setValueHandler((obs, variable, value) => {
      if (obs !== lastObs) {
        current = [];
        rows.push(current);
        lastObs = obs;
      }
      const column = this.columns[variable.index];
      if (column) current!.push([variable.name, cellValue(value, variable, column)]);
    });

    const code = parseSas7bdat(parser, new BufferIoContext(this.bytes), null);
    if (code !== ReadStatError.OK) throw describeError(code, 'sas7bdat');

    this.offset += rows.length;
    return { rows, done: this.offset >= this.rowCount };
  }
}