import { bitable, FieldType, type IFieldConfig, type IRecordValue, type ITable } from '@lark-base-open/js-sdk';
import { columnKind, RecordCursor, type DomainMeta } from './sas_xml';

/** SDK 注释：addRecords 单次上限 200 条 */
export const RECORD_BATCH = 200;

export type FieldKind = 'number' | 'datetime' | 'text';

export interface PreparedField {
  fieldId: string;
  kind: FieldKind;
}

export interface PreparedTable {
  table: ITable;
  /** 数据集列名 -> 多维表格字段 */
  fields: Map<string, PreparedField>;
  /** 本次新建的数据表 */
  created: boolean;
  /** 本次补建的字段数 */
  addedFields: number;
}

/** IFieldConfig 是按 type 判别的联合类型，必须逐字面量返回。 */
function fieldConfig(name: string, kind: FieldKind): IFieldConfig {
  if (kind === 'number') return { name, type: FieldType.Number };
  if (kind === 'datetime') return { name, type: FieldType.DateTime };
  return { name, type: FieldType.Text };
}

let tableIdByName: Map<string, string> | null = null;

/** 一次性拿全部数据表元信息，避免依赖 getTableIdByName 找不到时的异常语义。 */
async function lookupTableId(name: string): Promise<string | undefined> {
  if (!tableIdByName) {
    const metas = await bitable.base.getTableMetaList();
    tableIdByName = new Map(metas.map(m => [m.name, m.id]));
  }
  return tableIdByName.get(name);
}

export function invalidateTableCache(): void {
  tableIdByName = null;
}

function kindsOf(meta: DomainMeta, inferTypes: boolean): Map<string, FieldKind> {
  const kinds = new Map<string, FieldKind>();
  for (const col of meta.columns) kinds.set(col.name, inferTypes ? columnKind(col) : 'text');
  return kinds;
}

/** 保证数据表存在、字段齐全，返回列名到字段 id 的映射。 */
export async function prepareTable(meta: DomainMeta, inferTypes: boolean): Promise<PreparedTable> {
  const kinds = kindsOf(meta, inferTypes);

  let tableId = await lookupTableId(meta.tableName);
  const created = !tableId;
  if (!tableId) {
    const result = await bitable.base.addTable({
      name: meta.tableName,
      fields: meta.columns.map(col => fieldConfig(col.name, kinds.get(col.name)!)),
    });
    tableId = result.tableId;
    tableIdByName?.set(meta.tableName, tableId);
  }

  const table = await bitable.base.getTableById(tableId);
  const fields = await readFields(table, kinds);

  // addTable 带的字段未必真的生效，已有表也可能缺列，统一在这里补齐
  let addedFields = 0;
  for (const [name, kind] of kinds) {
    if (fields.has(name)) continue;
    fields.set(name, { fieldId: await table.addField(fieldConfig(name, kind)), kind });
    addedFields++;
  }

  const unusable = [...fields.entries()].filter(([, field]) => !field.fieldId).map(([name]) => name);
  if (unusable.length) {
    throw new Error(`${meta.tableName}：${unusable.length} 个列没拿到字段 id（例如 ${unusable.slice(0, 3).join('、')}），已中止写入`);
  }

  return { table, fields, created, addedFields };
}

async function readFields(table: ITable, kinds: Map<string, FieldKind>): Promise<Map<string, PreparedField>> {
  const fields = new Map<string, PreparedField>();
  for (const field of await table.getFieldList()) {
    const name = await field.getName();
    if (kinds.has(name)) fields.set(name, { fieldId: field.id, kind: kinds.get(name)! });
  }
  return fields;
}

function toCellValue(value: string | null, kind: FieldKind): number | string | null {
  if (value === null) return null;
  if (kind === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (kind === 'datetime') {
    const stamp = Date.parse(value.includes('T') ? value : `${value}T00:00:00`);
    return Number.isNaN(stamp) ? null : stamp;
  }
  return value;
}

export interface ImportProgress {
  rows: number;
  batches: number;
}

/**
 * 流式写库：每次只保留 200 行，lab.xml 这种 70MB / 2 万行的域不会一次性驻留内存。
 * 返回导入行数；抛错时调用方按域记录已导入行数。
 */
export async function importDomain(
  xml: string,
  prepared: PreparedTable,
  hooks: {
    onBatch?: (progress: ImportProgress) => void;
    shouldAbort?: () => boolean;
  } = {},
): Promise<ImportProgress> {
  const cursor = new RecordCursor(xml);
  const progress: ImportProgress = { rows: 0, batches: 0 };

  for (;;) {
    const { rows, done } = cursor.next(RECORD_BATCH);
    if (rows.length) {
      const records: IRecordValue[] = rows.map(row => {
        const fields: Record<string, number | string> = {};
        for (const [name, value] of row) {
          const field = prepared.fields.get(name);
          if (!field) continue;
          const cell = toCellValue(value, field.kind);
          if (cell !== null) fields[field.fieldId] = cell;
        }
        return { fields };
      });
      await prepared.table.addRecords(records);
      progress.rows += rows.length;
      progress.batches++;
      hooks.onBatch?.(progress);
    }
    if (done) return progress;
    if (hooks.shouldAbort?.()) throw new AbortError();
  }
}

export class AbortError extends Error {
  constructor() {
    super('已中止导入');
    this.name = 'AbortError';
  }
}

export function isAbortError(err: unknown): err is AbortError {
  return err instanceof Error && err.name === 'AbortError';
}
