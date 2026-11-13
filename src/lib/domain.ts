export type CellValue = string | number | null;

export type FieldKind = 'number' | 'datetime' | 'text';

export interface ScanColumn {
  name: string;
  /** sas7bdat 自带列类型，直接采用，不必按内容猜 */
  kind: FieldKind;
  label?: string;
}

export interface DomainMeta {
  /** zip 内文件名，如 lab.sas7bdat */
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

export interface DomainCursor {
  next(limit: number): DomainBatch;
}
