import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import type { DomainCursor, DomainMeta } from './domain';
import { RecordCursor, scanDomain } from './sas_xml';
import { scanSas7bdat, Sas7bdatCursor, type SasColumn } from './sas7bdat';

export type DomainKind = 'xml' | 'sas7bdat';

export interface DomainEntry extends DomainMeta {
  /** zip 内文件名，作为读取键 */
  path: string;
  /** 解压后的体积：xml 是字符数，sas7bdat 是字节数 */
  rawSize: number;
  kind: DomainKind;
}

export interface ZipInfo {
  fileName: string;
  fileSize: number;
  entryCount: number;
  dataCount: number;
  xmlCount: number;
  sasCount: number;
  encrypted: boolean;
  zipCrypto: boolean;
}

export interface LoadedZip {
  fileName: string;
  domains: DomainEntry[];
  /** 单个域按需解压：整包只占几 MB 压缩数据，域内容用完即释放 */
  readDomain(path: string): Promise<DomainCursor>;
  close(): Promise<void>;
}

const DATA_ENTRY = /\.(xml|sas7bdat)$/i;
const NO_DATA = '里没有 .sas7bdat 或 .xml 数据文件，请确认选的是 SAS 导出的压缩包';

export class ZipPasswordError extends Error {
  constructor(message = '解压密码不正确，请重新输入后再解析') {
    super(message);
    this.name = 'ZipPasswordError';
  }
}

export class ZipPasswordRequiredError extends Error {
  constructor(message = '这个压缩包已加密，请先输入解压密码') {
    super(message);
    this.name = 'ZipPasswordRequiredError';
  }
}

export function isPasswordError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'ZipPasswordError' || err.name === 'ZipPasswordRequiredError');
}

function kindOf(filename: string): DomainKind {
  return /\.sas7bdat$/i.test(filename) ? 'sas7bdat' : 'xml';
}

function isDataEntry(entry: { directory: boolean; filename: string }): entry is FileEntry {
  return !entry.directory && DATA_ENTRY.test(entry.filename);
}

/** 同名数据集两种格式都在时只留 sas7bdat：它自带列类型，比按内容猜更准。 */
function dedupe(entries: FileEntry[]): FileEntry[] {
  const byBase = new Map<string, FileEntry>();
  for (const entry of entries) {
    const base = entry.filename.replace(/^.*[\\/]/, '').replace(DATA_ENTRY, '').toLowerCase();
    const kept = byBase.get(base);
    if (!kept || kindOf(kept.filename) === 'xml') byBase.set(base, entry);
  }
  return [...byBase.values()];
}

/** 只读中央目录，不解密任何内容：选包阶段就能知道是否加密、有多少数据集。 */
export async function inspectZip(file: File): Promise<ZipInfo> {
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const data = dedupe(entries.filter(isDataEntry));
    if (!data.length) throw new Error(`${file.name} ${NO_DATA}`);
    const sasCount = data.filter(entry => kindOf(entry.filename) === 'sas7bdat').length;
    return {
      fileName: file.name,
      fileSize: file.size,
      entryCount: entries.length,
      dataCount: data.length,
      xmlCount: data.length - sasCount,
      sasCount,
      encrypted: data.some(entry => entry.encrypted),
      zipCrypto: data.some(entry => entry.zipCrypto),
    };
  } catch (err) {
    throw decorate(err);
  } finally {
    await reader.close();
  }
}

export async function loadZip(
  file: File,
  password: string,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<LoadedZip> {
  const reader = new ZipReader(new BlobReader(file), password ? { password } : {});

  let data: FileEntry[];
  try {
    data = dedupe((await reader.getEntries()).filter(isDataEntry));
  } catch (err) {
    await reader.close();
    throw decorate(err);
  }

  if (!data.length) {
    await reader.close();
    throw new Error(`${file.name} ${NO_DATA}`);
  }
  if (!password && data.some(entry => entry.encrypted)) {
    await reader.close();
    throw new ZipPasswordRequiredError();
  }

  // 先只验密码：密码错时立刻报错，不必白解压几十 MB 才发现
  if (data[0].encrypted) {
    try {
      await data[0].getData(new Uint8ArrayWriter(), { checkPasswordOnly: true });
    } catch (err) {
      await reader.close();
      throw decorate(err);
    }
  }

  const domains: DomainEntry[] = [];
  const sasColumns = new Map<string, SasColumn[]>();
  try {
    for (const [index, entry] of data.entries()) {
      const kind = kindOf(entry.filename);
      const name = entry.filename.replace(/^.*[\\/]/, '');
      // 大域整份解压要几秒，先把当前域名报出去，界面不会看着像卡死
      onProgress?.(index, data.length, name);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (kind === 'sas7bdat') {
        const bytes = await entry.getData(new Uint8ArrayWriter());
        const scan = scanSas7bdat(entry.filename, bytes);
        sasColumns.set(entry.filename, scan.columns);
        domains.push({ ...scan.meta, path: entry.filename, rawSize: bytes.length, kind });
      } else {
        const xml = await entry.getData(new TextWriter());
        domains.push({ ...scanDomain(entry.filename, xml), path: entry.filename, rawSize: xml.length, kind });
      }
      onProgress?.(index + 1, data.length, name);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (err) {
    await reader.close();
    throw decorate(err);
  }

  domains.sort((a, b) => a.tableName.localeCompare(b.tableName));

  const byName = new Map<string, FileEntry>(data.map(entry => [entry.filename, entry]));
  return {
    fileName: file.name,
    domains,
    readDomain: async path => {
      const entry = byName.get(path);
      if (!entry) throw new Error(`压缩包里找不到 ${path}`);
      try {
        if (kindOf(path) === 'sas7bdat') {
          const bytes = await entry.getData(new Uint8ArrayWriter());
          const domain = domains.find(item => item.path === path)!;
          return new Sas7bdatCursor(bytes, sasColumns.get(path)!, domain.rowCount);
        }
        return new RecordCursor(await entry.getData(new TextWriter()));
      } catch (err) {
        throw decorate(err);
      }
    },
    close: () => reader.close(),
  };
}

function decorate(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid password/i.test(message)) return new ZipPasswordError();
  if (/file contains encrypted entry|password.*required/i.test(message)) return new ZipPasswordRequiredError();
  if (/encrypted central directory/i.test(message)) {
    return new Error('压缩包的目录本身被加密（AES 强加密），当前无法读取');
  }
  if (/end of central directory|not recognized|invalid signature/i.test(message)) {
    return new Error('这不是一个有效的 zip 文件，请重新选择');
  }
  return err instanceof Error ? err : new Error(message);
}
