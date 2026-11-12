export type CellValue = string | number | null;

export type FieldKind = 'number' | 'datetime' | 'text';

export interface ScanColumn {
  name: string;
  numeric: number;
  dateOnly: number;
  leadingZero: number;
  nonEmpty: number;
  /** sas7bdat 自带列类型，直接采用，不再按内容猜 */
  kind?: FieldKind;
  label?: string;
}

export interface DomainMeta {
  /** zip 内文件名，如 lab.xml / lab.sas7bdat */
  fileName: string;
  /** 数据集名，同时作为多维表格数据表名，如 LAB */
  tableName: string;
  rowCount: number;
  columns: ScanColumn[];
}

export interface DomainBatch {
  rows: Array<Array<[string, CellValue]>>;
  done: boolean;
}

/** 两种格式共用的取行接口：每次只交出一批，域内容不必整体驻留内存。 */
export interface DomainCursor {
  next(limit: number): DomainBatch;
}

/** 列类型判定：整列都有值且形态一致才升型，避免把 "01" 这类编码写成 1。 */
export function columnKind(col: ScanColumn): FieldKind {
  if (col.kind) return col.kind;
  if (col.nonEmpty === 0) return 'text';
  if (col.numeric === col.nonEmpty && col.leadingZero === 0) return 'number';
  if (col.dateOnly === col.nonEmpty) return 'datetime';
  return 'text';
}

export function emptyColumn(name: string): ScanColumn {
  return { name, numeric: 0, dateOnly: 0, leadingZero: 0, nonEmpty: 0 };
}