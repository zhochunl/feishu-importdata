import { bitable, FieldType, type IFieldConfig, type IRecordValue, type ITable } from '@lark-base-open/js-sdk';
import { type CellValue, type DomainCursor, type DomainMeta, type FieldKind } from './domain';

/**
 * JS SDK 单次上限 5000 行；老宿主可能只收 200 / 1000，被拒时沿这个阶梯往下降。
 * 10000 / 20000 超出手册上限，仅用于压测：宿主拒绝后会按阶梯降回 5000。
 */
export const BATCH_OPTIONS = [200, 500, 1000, 2000, 5000, 10000, 20000] as const;
export const SDK_BATCH_LIMIT = 5000;
export const DEFAULT_BATCH = 5000;
/** getRecordIdListByPage 文档上限 200，与写入批量无关。 */
const LIST_PAGE = 200;

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
    tableIdByName = new Map((await bitable.base.getTableMetaList()).map(meta => [meta.name, meta.id]));
  }
  return tableIdByName.get(name);
}

export function invalidateTableCache(): void {
  tableIdByName = null;
}

function kindsOf(meta: DomainMeta): Map<string, FieldKind> {
  const kinds = new Map<string, FieldKind>();
  for (const col of meta.columns) kinds.set(col.name, col.kind);
  return kinds;
}

/** 保证数据表存在、字段齐全，返回列名到字段 id 的映射。 */
export async function prepareTable(meta: DomainMeta): Promise<PreparedTable> {
  const kinds = kindsOf(meta);

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

function toCellValue(value: CellValue, kind: FieldKind): number | string | null {
  if (value === null) return null;
  if (kind === 'number') {
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (kind === 'datetime') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const stamp = Date.parse(value.includes('T') ? value : `${value}T00:00:00`);
    return Number.isNaN(stamp) ? null : stamp;
  }
  return typeof value === 'number' ? String(value) : value;
}

export interface ImportProgress {
  rows: number;
  batches: number;
  /** 覆盖模式下先删掉的旧记录数 */
  deleted: number;
}

export interface ImportHooks {
  onBatch?: (progress: ImportProgress) => void;
  onClear?: (deleted: number, total: number) => void;
  onNotice?: (text: string) => void;
  shouldAbort?: () => boolean;
}

export interface ImportOptions {
  batchSize?: number;
  /** true = 同名表先整体清空再整体写入；新建的表没有旧记录，跳过清空 */
  replace?: boolean;
}

/** 一次导入内共享的批量大小：被宿主拒绝后降级并保持，不再每批重试大值。 */
interface BatchState {
  size: number;
}

/**
 * 流式写库：每次只保留一批行，lab 这种 2 万行的域不会一次性驻留内存。
 * 返回导入行数；抛错时调用方按域记录已导入行数。
 */
export async function importDomain(
  cursor: DomainCursor,
  prepared: PreparedTable,
  hooks: ImportHooks = {},
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const state: BatchState = { size: options.batchSize ?? DEFAULT_BATCH };
  const progress: ImportProgress = { rows: 0, batches: 0, deleted: 0 };

  if (options.replace && !prepared.created) {
    progress.deleted = await clearTable(prepared.table, state, hooks);
  }

  for (;;) {
    const { rows, done } = cursor.next(state.size);
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
      await runBatched(records, state, chunk => prepared.table.addRecords(chunk), hooks.onNotice, '写入');
      progress.rows += rows.length;
      progress.batches++;
      hooks.onBatch?.(progress);
    }
    if (done) return progress;
    if (hooks.shouldAbort?.()) throw new AbortError();
  }
}

/** 先整体删：取全量 recordId 再分批删除，保留字段、视图和仪表盘引用。 */
async function clearTable(table: ITable, state: BatchState, hooks: ImportHooks): Promise<number> {
  const ids = await collectRecordIds(table, hooks.shouldAbort);
  if (!ids.length) return 0;

  hooks.onClear?.(0, ids.length);
  let index = 0;
  while (index < ids.length) {
    if (hooks.shouldAbort?.()) throw new AbortError();
    const chunk = ids.slice(index, index + state.size);
    await runBatched(chunk, state, part => table.deleteRecords(part), hooks.onNotice, '删除');
    index += chunk.length;
    hooks.onClear?.(index, ids.length);
  }
  return ids.length;
}

/** 分页只读、期间不删，避免边删边翻页导致 pageToken 失效。 */
async function collectRecordIds(table: ITable, shouldAbort?: () => boolean): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: number | undefined;
  for (;;) {
    if (shouldAbort?.()) throw new AbortError();
    const page = await table.getRecordIdListByPage({ pageSize: LIST_PAGE, pageToken });
    ids.push(...page.recordIds);
    if (!page.hasMore || page.pageToken === undefined || !page.recordIds.length) break;
    pageToken = page.pageToken;
  }
  return ids;
}

/** 只有批量条数被拒时才降级重切；其它错误原样抛出，避免把已写入的记录再写一遍。 */
async function runBatched<T>(
  items: T[],
  state: BatchState,
  run: (chunk: T[]) => Promise<unknown>,
  onNotice: ((text: string) => void) | undefined,
  label: string,
): Promise<void> {
  let index = 0;
  while (index < items.length) {
    const chunk = items.slice(index, index + state.size);
    try {
      await runThrottled(chunk, run);
      index += chunk.length;
    } catch (err) {
      const next = nextRung(state.size);
      if (next === null || !isBatchSizeError(err)) throw err;
      onNotice?.(`${label}每批 ${chunk.length} 条被拒绝（${messageOf(err)}），降到 ${next} 条重试`);
      // 不推进 index：同一批数据按更小的批量重来，批量操作是原子的，不会写重
      state.size = next;
    }
  }
}

const THROTTLED = /1254290|1254291|too many request|请求过快|write conflict|并发/i;

/** 大批量容易撞上宿主的写频率/并发限制，这类错误退避重试，不影响数据。 */
async function runThrottled<T>(items: T[], run: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await run(items);
      return;
    } catch (err) {
      if (attempt >= 3 || !THROTTLED.test(messageOf(err))) throw err;
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}

function nextRung(size: number): number | null {
  const lower = BATCH_OPTIONS.filter(option => option < size);
  return lower.length ? lower[lower.length - 1] : null;
}

function isBatchSizeError(err: unknown): boolean {
  const message = messageOf(err);
  // 单元格过大、字段超限靠降级救不了，别白重试
  if (/cell|格子|字段|column|field/i.test(message)) return false;
  return /10214001|1254104|exceed|limit|too many|上限|超出|条数/i.test(message);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
