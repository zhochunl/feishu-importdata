import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bitable } from '@lark-base-open/js-sdk';
import { columnKind } from './lib/sas_xml';
import { loadZip, type DomainEntry, type LoadedZip } from './lib/zip_domains';
import {
  importDomain,
  invalidateTableCache,
  prepareTable,
  isAbortError,
  RECORD_BATCH,
} from './lib/bitable_writer';
import './index.css';

type Status = '待导入' | '读取中' | '建表中' | '写入中' | '完成' | '失败' | '已中止';

const STATUS_CLASS: Record<Status, string> = {
  待导入: 'is-idle',
  读取中: 'is-busy',
  建表中: 'is-busy',
  写入中: 'is-busy',
  完成: 'is-done',
  失败: 'is-fail',
  已中止: 'is-abort',
};

interface RowState {
  entry: DomainEntry;
  selected: boolean;
  status: Status;
  written: number;
  message: string;
}

export default function App() {
  const [baseName, setBaseName] = useState('');
  const [hostError, setHostError] = useState('');
  const [loaded, setLoaded] = useState<LoadedZip | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [reading, setReading] = useState(false);
  const [running, setRunning] = useState(false);
  const [inferTypes, setInferTypes] = useState(true);
  const [password, setPassword] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);

  const log = useCallback((text: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs(prev => [...prev.slice(-199), `${time} ${text}`]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setBaseName(await bitable.base.getBaseName());
        invalidateTableCache();
      } catch {
        setHostError('当前不在多维表格环境中（独立打开页面只能预览界面，无法写入数据）');
      }
    })();
  }, []);

  const patch = useCallback((path: string, next: Partial<RowState>) => {
    setRows(prev => prev.map(r => (r.entry.path === path ? { ...r, ...next } : r)));
  }, []);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setRows([]);
    setLogs([]);
    invalidateTableCache();
    await loaded?.close();
    try {
      const zip = await loadZip(file, password);
      const totalRows = zip.domains.reduce((sum, d) => sum + d.rowCount, 0);
      setLoaded(zip);
      setRows(zip.domains.map(entry => ({ entry, selected: true, status: '待导入', written: 0, message: '' })));
      log(`已解析 ${file.name}：${zip.domains.length} 个域，共 ${totalRows.toLocaleString()} 行`);
    } catch (err) {
      setLoaded(null);
      log(`解析失败：${messageOf(err)}`);
    } finally {
      setReading(false);
    }
  };

  const selectedRows = useMemo(() => rows.filter(r => r.selected), [rows]);
  const plannedRows = useMemo(() => selectedRows.reduce((sum, r) => sum + r.entry.rowCount, 0), [selectedRows]);
  const writtenRows = useMemo(
    () => rows.filter(r => r.selected).reduce((sum, r) => sum + r.written, 0),
    [rows],
  );

  const runImport = async () => {
    if (!loaded || !selectedRows.length) return;
    setRunning(true);
    abortRef.current = false;
    invalidateTableCache();
    log(`开始导入 ${selectedRows.length} 个域，共 ${plannedRows.toLocaleString()} 行（每批 ${RECORD_BATCH} 条）`);

    for (const row of selectedRows) {
      if (abortRef.current) {
        patch(row.entry.path, { status: '已中止' });
        log(`已中止，跳过 ${row.entry.tableName} 及后续域`);
        break;
      }
      try {
        patch(row.entry.path, { status: '读取中', message: '' });
        const xml = await loaded.readXml(row.entry.path);
        patch(row.entry.path, { status: '建表中' });
        const prepared = await prepareTable(row.entry, inferTypes);
        const schema = prepared.created
          ? `新建数据表，${prepared.fields.size} 个字段`
          : `已有数据表，补建 ${prepared.addedFields} 个字段`;
        patch(row.entry.path, { status: '写入中', message: schema });
        log(`${row.entry.tableName}：${schema}`);

        const done = await importDomain(xml, prepared, {
          onBatch: progress => patch(row.entry.path, { written: progress.rows }),
          shouldAbort: () => abortRef.current,
        });
        patch(row.entry.path, { status: '完成', written: done.rows, message: `${schema}；已写入 ${done.rows.toLocaleString()} 行` });
        log(`${row.entry.tableName}：写入 ${done.rows.toLocaleString()} 行（${done.batches} 批）`);
      } catch (err) {
        const aborted = isAbortError(err);
        patch(row.entry.path, {
          status: aborted ? '已中止' : '失败',
          message: messageOf(err),
        });
        log(`${row.entry.tableName}：${aborted ? '已中止' : '失败'} —— ${messageOf(err)}`);
        if (aborted) break;
      }
      await nextFrame();
    }

    setRunning(false);
    log('本次导入结束');
  };

  const selectAll = (value: boolean) => setRows(prev => prev.map(r => ({ ...r, selected: value })));

  return (
    <div className="import-sidebar">
      <h1>SAS 数据包导入</h1>
      <div className="target">
        目标多维表格：{baseName || '未连接'}
        {hostError && <div className="host-error">{hostError}</div>}
      </div>

      <label className="field">
        <span>解压密码</span>
        <input
          type="password"
          value={password}
          placeholder="SAS 包的解压密码，无密码留空"
          onChange={e => setPassword(e.target.value)}
          disabled={running || reading}
        />
      </label>

      <div className="picker">
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={e => handleFile(e.target.files?.[0])}
        />
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={running || reading}>
          {reading ? '解析中…' : '选择 zip 数据包'}
        </button>
        <span className="picked">{loaded ? loaded.fileName : '未选择文件'}</span>
      </div>

      {loaded && (
        <label className="option">
          <input
            type="checkbox"
            checked={inferTypes}
            onChange={e => setInferTypes(e.target.checked)}
            disabled={running}
          />
          自动识别数值 / 日期列（关闭后全部按文本写入）
        </label>
      )}

      <div className="list-head">
        <span>{rows.length} 个域 · 待写入 {plannedRows.toLocaleString()} 行</span>
        <span className="mini-actions">
          <button onClick={() => selectAll(true)} disabled={running || !rows.length}>全选</button>
          <button onClick={() => selectAll(false)} disabled={running || !rows.length}>清空</button>
        </span>
      </div>

      <div className="file-list">
        {rows.map(row => (
          <div key={row.entry.path} className={`domain ${row.status === '失败' ? 'is-error' : ''}`}>
            <label className="domain-check">
              <input
                type="checkbox"
                checked={row.selected}
                disabled={running}
                onChange={e => patch(row.entry.path, { selected: e.target.checked })}
              />
            </label>
            <div className="domain-body">
              <div className="domain-title">
                <strong>{row.entry.tableName}</strong>
                <span className="domain-meta">
                  {row.entry.rowCount.toLocaleString()} 行 · {row.entry.rowCount ? row.entry.columns.length : 0} 列 · {formatSize(row.entry.rawSize)}
                </span>
              </div>
              {inferTypes && row.selected && row.status !== '待导入' && (
                <div className="domain-kinds">{kindSummary(row.entry)}</div>
              )}
              {(row.written > 0 || row.message) && (
                <div className="domain-progress">
                  <div className="bar" style={{ width: `${Math.min(100, (row.written / row.entry.rowCount) * 100)}%` }} />
                </div>
              )}
              <div className="domain-status">
                <span className={`badge ${STATUS_CLASS[row.status]}`}>{row.status}</span>
                {row.written > 0 && <span className="counts">{row.written.toLocaleString()} / {row.entry.rowCount.toLocaleString()}</span>}
                {row.message && <span className="msg">{row.message}</span>}
              </div>
            </div>
          </div>
        ))}
        {!rows.length && !reading && <div className="empty">选择一个 SAS 导出的 zip，包内每个 xml 对应一个数据集。</div>}
      </div>

      {running && (
        <div className="overall">
          <div className="overall-bar"><div style={{ width: `${plannedRows ? (writtenRows / plannedRows) * 100 : 0}%` }} /></div>
          <span>{writtenRows.toLocaleString()} / {plannedRows.toLocaleString()}</span>
        </div>
      )}

      <div className="actions">
        <button className="primary" onClick={runImport} disabled={running || reading || !selectedRows.length}>
          开始导入
        </button>
        <button className="danger" onClick={() => { abortRef.current = true; log('正在中止…（当前批次写完后停止）'); }} disabled={!running}>
          中止
        </button>
      </div>

      {!!logs.length && (
        <div className="console">
          <div className="console-head">运行日志</div>
          <div className="console-body">{logs.map((line, i) => <div key={i}>{line}</div>)}</div>
        </div>
      )}
    </div>
  );
}

function kindSummary(entry: DomainEntry): string {
  const counts = { number: 0, datetime: 0, text: 0 };
  for (const col of entry.columns) counts[columnKind(col)]++;
  return `数值 ${counts.number} · 日期 ${counts.datetime} · 文本 ${counts.text}`;
}

function formatSize(chars: number): string {
  return chars > 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)}M` : `${Math.round(chars / 1024)}K`;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
