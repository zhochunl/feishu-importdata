/**
 * SAS XML 数据集（<TABLE><域名>…</域名></TABLE>）的浏览器端游标解析器。
 *
 * 必须按深度扫描：HEIGHT / LBCCP / LBESR / LBRF / WEIGHT 这几个域里存在与数据集
 * 同名的列，用 `<ADA>[\s\S]*?</ADA>` 这类块正则会在一列的结束标签处截断记录。
 */

import { emptyColumn, type CellValue, type DomainBatch, type DomainCursor, type DomainMeta, type ScanColumn } from './domain';

const TAG_RE = /<(\/)?([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*\s*=\s*"[^"]*")*)\s*(\/)?>/g;
const ENTITY_RE = /&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g;

const NUMERIC_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const LEADING_ZERO_RE = /^0\d/;

function decodeEntities(raw: string): string {
  return raw.replace(ENTITY_RE, (_, code: string) => {
    switch (code) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
    }
    const hex = code.startsWith('#x') || code.startsWith('#X');
    return String.fromCodePoint(parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10));
  });
}

/** 从 <TABLE> 之后开始逐条产出记录；depth 状态机保证记录与列同名时也不串位。 */
export class RecordCursor implements DomainCursor {
  private readonly xml: string;
  private pos: number;
  private depth = 1;
  private recordTag = '';
  private leaf: { name: string; missing: boolean } | null = null;
  private textStart = 0;
  private done = false;

  constructor(xml: string) {
    this.xml = xml;
    const open = /<TABLE\b[^>]*>/g.exec(xml);
    if (!open) throw new Error('不是预期的 SAS XML 结构：缺少 <TABLE> 根节点');
    this.pos = (open.index ?? 0) + open[0].length;
  }

  get dataset(): string {
    return this.recordTag;
  }

  next(limit: number): DomainBatch {
    const rows: Array<Array<[string, CellValue]>> = [];
    if (this.done) return { rows, done: true };

    const re = new RegExp(TAG_RE.source, 'g');
    re.lastIndex = this.pos;
    let match: RegExpExecArray | null;
    let current: Array<[string, CellValue]> | null = null;

    while ((match = re.exec(this.xml))) {
      const [, closing, name, attrStr, selfClose] = match;

      if (this.depth === 1) {
        if (closing) {
          if (name === 'TABLE') { this.done = true; break; }
          continue;
        }
        if (selfClose) continue;
        this.recordTag = name;
        current = [];
        this.depth = 2;
        continue;
      }

      if (this.depth === 2) {
        if (closing) {
          this.depth = 1;
          if (current) rows.push(current);
          current = null;
          if (rows.length >= limit) break;
          continue;
        }
        if (!current) current = [];
        const missing = /missing\s*=/.test(attrStr);
        if (selfClose) {
          current.push([name, null]);
          continue;
        }
        this.leaf = { name, missing };
        this.textStart = re.lastIndex;
        this.depth = 3;
        continue;
      }

      // depth === 3：列文本内部，只认这一列自己的结束标签
      if (closing && this.leaf && name === this.leaf.name) {
        const text = this.xml.slice(this.textStart, match.index);
        current?.push([this.leaf.name, this.leaf.missing ? null : normalizeText(text)]);
        this.leaf = null;
        this.depth = 2;
      }
    }

    this.pos = re.lastIndex;
    if (!match) this.done = true;
    return { rows, done: this.done };
  }
}

/** 文本值：SAS 按定宽写出，两侧填充空格；纯空白视为空值。 */
function normalizeText(raw: string): CellValue {
  const value = decodeEntities(raw).trim();
  return value === '' ? null : value;
}

export function scanDomain(fileName: string, xml: string): DomainMeta {
  const cursor = new RecordCursor(xml);
  const columns: ScanColumn[] = [];
  const byName = new Map<string, ScanColumn>();
  let rowCount = 0;

  for (;;) {
    const { rows, done } = cursor.next(5000);
    for (const row of rows) {
      rowCount++;
      for (const [name, value] of row) {
        let col = byName.get(name);
        if (!col) {
          col = emptyColumn(name);
          byName.set(name, col);
          columns.push(col);
        }
        if (value === null) continue;
        col.nonEmpty++;
        if (typeof value !== 'string') continue;
        if (NUMERIC_RE.test(value)) col.numeric++;
        if (LEADING_ZERO_RE.test(value)) col.leadingZero++;
        if (ISO_DATETIME_RE.test(value)) col.dateOnly++;
      }
    }
    if (done) break;
  }

  const tableName = cursor.dataset;
  if (!tableName) throw new Error(`${fileName} 里没有数据记录`);
  if (!rowCount) throw new Error(`${fileName} 是空数据集`);

  return { fileName, tableName, rowCount, columns };
}
