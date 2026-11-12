import { BlobReader, TextWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { scanDomain, type DomainMeta } from './sas_xml';

export interface DomainEntry extends DomainMeta {
  /** zip 内文件名，作为读取键 */
  path: string;
  /** 解压后的字符长度 */
  rawSize: number;
}

export interface LoadedZip {
  fileName: string;
  domains: DomainEntry[];
  /** 单个域按需解压：整包只占几 MB 压缩数据，域文本用完即释放 */
  readXml(path: string): Promise<string>;
  close(): Promise<void>;
}

const XML_ENTRY = /\.xml$/i;

/** SAS 下发的包是 ZipCrypto 加密的，密码错会抛 Invalid password。 */
export async function loadZip(file: File, password: string): Promise<LoadedZip> {
  const reader = new ZipReader(new BlobReader(file), password ? { password } : {});
  const entries = await reader.getEntries();
  const xmlEntries = entries.filter((entry): entry is FileEntry => !entry.directory && XML_ENTRY.test(entry.filename));

  if (!xmlEntries.length) {
    await reader.close();
    throw new Error(`${file.name} 里没有 .xml 数据文件，请确认选的是 SAS 导出的压缩包`);
  }

  const domains: DomainEntry[] = [];
  try {
    for (const entry of xmlEntries) {
      const xml = await entry.getData(new TextWriter());
      const meta = scanDomain(entry.filename, xml);
      domains.push({ ...meta, path: entry.filename, rawSize: xml.length });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (err) {
    await reader.close();
    throw decoratePasswordError(err);
  }

  domains.sort((a, b) => a.tableName.localeCompare(b.tableName));

  const byName = new Map<string, FileEntry>(xmlEntries.map(entry => [entry.filename, entry]));
  return {
    fileName: file.name,
    domains,
    readXml: async path => {
      const entry = byName.get(path);
      if (!entry) throw new Error(`压缩包里找不到 ${path}`);
      try {
        return await entry.getData(new TextWriter());
      } catch (err) {
        throw decoratePasswordError(err);
      }
    },
    close: () => reader.close(),
  };
}

function decoratePasswordError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/password/i.test(message)) return new Error('解压密码不正确');
  return err instanceof Error ? err : new Error(message);
}
