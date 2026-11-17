import {
  bitable,
  FieldType,
  NumberFormatter,
  type IFieldConfig,
  type IRecordValue,
  type ITable,
} from '@lark-base-open/js-sdk';
import { type CellValue, type DomainCursor, type DomainMeta, type FieldKind } from './domain';

/** JS SDK 单次最多 5000 行；老宿主可能只收 200 / 1000，被拒时沿这个阶梯往下降。 */
export const BATCH_OPTIONS = [200, 500, 1000, 2000, 5000] as const;
export const DEFAULT_BATCH = 5000;
/** getRecordIdListByPage 文档上限 200，与写入批量无关。 */
const LIST_PAGE = 200;

export interface PreparedField {
  fieldId: string;
  kind: FieldKind;
  /** 数字字段当前的显示格式；只有默认 0.0 的列才会被改成整数 */
  formatter?: string;
}

export interface PreparedTable {
  table: ITable;
  /** 数据集列名 -> 多维表格字段 */
  fields: Map<string, PreparedField>;
  /** 本次新建的数据表 */
  created: boolean;
  /** 本次补建的字段数 */
  addedFields: number;
  /** 本次按 SAS 类型改掉字段类型的个数 */
  convertedFields: number;
}

const KIND_FIELD_TYPE: Record<FieldKind, FieldType> = {
  number: FieldType.Number,
  datetime: FieldType.DateTime,
  text: FieldType.Text,
};

/** IFieldConfig 是按 type 判别的联合类型，必须逐字面量返回。 */
function fieldConfig(name: string, kind: FieldKind): IFieldConfig {
  if (kind === 'number') return { name, type: FieldType.Number };
  if (kind === 'datetime') return { name, type: FieldType.DateTime };
  return { name, type: FieldType.Text };
}

function kindLabel(kind: FieldKind): string {
  return kind === 'number' ? '数值' : kind === 'datetime' ? '日期' : '文本';
}

function typeLabel(type: FieldType): string {
  if (type === FieldType.Text) return '文本';
  if (type === FieldType.Number) return '数字';
  if (type === FieldType.DateTime) return '日期时间';
  return `类型 ${type}`;
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
  const { fields, converted } = await readFields(table, meta.tableName, kinds);

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

  return { table, fields, created, addedFields, convertedFields: converted };
}

/**
 * 字段类型一律以 SAS 元信息为准：宿主里同名字段若类型不符，就地改回 SAS 对应的类型，
 * 不再继承旧表（例如早期按内容推断出来的数字字段）的类型。
 */
async function readFields(
  table: ITable,
  tableName: string,
  kinds: Map<string, FieldKind>,
): Promise<{ fields: Map<string, PreparedField>; converted: number }> {
  const fields = new Map<string, PreparedField>();
  let converted = 0;
  // 一次拿全表字段元信息（类型 + 数字格式），避免逐字段 getName/getType/getMeta 的多次往返
  for (const meta of await table.getFieldMetaList()) {
    const name = meta.name;
    const kind = kinds.get(name);
    if (!kind) continue;
    if (meta.type !== KIND_FIELD_TYPE[kind]) {
      try {
        await table.setField(meta.id, fieldConfig(name, kind));
      } catch (err) {
        throw new Error(
          `${tableName} 的「${name}」字段在表里是${typeLabel(meta.type)}、SAS 里是${kindLabel(kind)}，` +
            `自动改字段类型失败（${messageOf(err)}）；请先在多维表格里手动改成${kindLabel(kind)}再导入`,
        );
      }
      converted++;
    }
    const formatter =
      kind === 'number'
        ? (meta.property as { formatter?: string } | undefined)?.formatter
        : undefined;
    fields.set(name, { fieldId: meta.id, kind, formatter });
  }
  return { fields, converted };
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
 * 流式写库：每次只保留一批行，lab 这种 2 万行的数据集不会一次性驻留内存。
 * 返回导入行数；抛错时调用方按数据集记录已导入行数。
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

  // 数字字段先按默认格式建/改，整列都写完后才知道该不该用整数格式
  const numberStates = new Map<string, NumberColumnState>();
  for (const [name, field] of prepared.fields) {
    if (field.kind === 'number') numberStates.set(field.fieldId, { name, integral: true, formatter: field.formatter });
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
          if (cell === null) continue;
          if (typeof cell === 'number') {
            const number = numberStates.get(field.fieldId);
            if (number && !Number.isInteger(cell)) number.integral = false;
          }
          fields[field.fieldId] = cell;
        }
        return { fields };
      });
      await runBatched(records, state, chunk => prepared.table.addRecords(chunk), hooks.onNotice, '写入');
      progress.rows += rows.length;
      progress.batches++;
      hooks.onBatch?.(progress);
    }
    if (done) {
      await applyIntegerFormatter(prepared.table, numberStates, hooks.onNotice);
      return progress;
    }
    if (hooks.shouldAbort?.()) throw new AbortError();
  }
}

interface NumberColumnState {
  name: string;
  /** 整列写下来没有出现过小数（空列也算整数） */
  integral: boolean;
  /** 字段原有的显示格式；用户手工设过（非默认 0.0）就不动 */
  formatter?: string;
}

/** 数学上是整数的列用「0」格式，否则飞书数字字段默认的 0.0 会把 1001 显示成 1001.0。 */
async function applyIntegerFormatter(
  table: ITable,
  states: Map<string, NumberColumnState>,
  onNotice: ((text: string) => void) | undefined,
): Promise<void> {
  for (const [fieldId, state] of states) {
    if (!state.integral) continue;
    if (state.formatter === NumberFormatter.INTEGER) continue;
    if (state.formatter && state.formatter !== NumberFormatter.DIGITAL_ROUNDED_1) continue;
    try {
      await table.setField(fieldId, {
        name: state.name,
        type: FieldType.Number,
        property: { formatter: NumberFormatter.INTEGER },
      });
    } catch (err) {
      // 只是显示格式，改不动不影响数据，提示一句继续
      onNotice?.(`${state.name}：整数格式设置失败（${messageOf(err)}），单元格会按默认小数位显示`);
    }
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
