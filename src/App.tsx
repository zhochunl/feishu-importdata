import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  inspectZip,
  isPasswordError,
  loadZip,
  type DomainEntry,
  type LoadedZip,
  type ZipInfo,
} from './lib/zip_domains';
import {
  BATCH_OPTIONS,
  DEFAULT_BATCH,
  importDomain,
  invalidateTableCache,
  isAbortError,
  prepareTable,
} from './lib/bitable_writer';
import './index.css';

type Stage = 'pick' | 'unlock' | 'import';
type Status = '待导入' | '读取中' | '建表中' | '清空中' | '写入中' | '完成' | '失败' | '已中止';
type Tone = 'info' | 'ok' | 'warn' | 'err';
type SortKey = 'name' | 'rows' | 'size';
type WriteMode = 'append' | 'replace';

const STATUS_CLASS: Record<Status, string> = {
  待导入: 'is-idle',
  读取中: 'is-busy',
  建表中: 'is-busy',
  清空中: 'is-clear',
  写入中: 'is-busy',
  完成: 'is-done',
  失败: 'is-fail',
  已中止: 'is-abort',
};

const MODE_COPY: Record<WriteMode, { label: string; hint: string }> = {
  append: {
    label: '追加导入',
    hint: '保留同名数据表里的现有记录，新数据追加在后面。重复导入同一个包会产生重复行。',
  },
  replace: {
    label: '覆盖更新',
    hint: '同名数据表先整体删除全部旧记录，再整体写入新数据；字段、视图和仪表盘引用保持不变。',
  },
};

const STEPS: Array<{ key: Stage; label: string }> = [
  { key: 'pick', label: '选择数据包' },
  { key: 'unlock', label: '解压校验' },
  { key: 'import', label: '写入表格' },
];

interface RowState {
  entry: DomainEntry;
  selected: boolean;
  status: Status;
  written: number;
  deleted: number;
  clearTotal: number;
  message: string;
}

interface LogLine {
  time: string;
  text: string;
  tone: Tone;
}

export default function App() {
  const [stage, setStage] = useState<Stage>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [zipInfo, setZipInfo] = useState<ZipInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [pickError, setPickError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [parseProgress, setParseProgress] = useState<{ done: number; total: number; current: string } | null>(null);

  const [loaded, setLoaded] = useState<LoadedZip | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [runPaths, setRunPaths] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [batchSize, setBatchSize] = useState<number>(DEFAULT_BATCH);
  const [mode, setMode] = useState<WriteMode>('append');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAck, setConfirmAck] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');

  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const logBodyRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<LoadedZip | null>(null);
  const abortRef = useRef(false);

  const log = useCallback((text: string, tone: Tone = 'info') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs(prev => [...prev.slice(-299), { time, text, tone }]);
  }, []);

  useEffect(() => {
    const body = logBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [logs, logOpen]);

  const patch = useCallback((path: string, next: Partial<RowState>) => {
    setRows(prev => prev.map(row => (row.entry.path === path ? { ...row, ...next } : row)));
  }, []);

  const dropLoaded = useCallback(async () => {
    const previous = loadedRef.current;
    loadedRef.current = null;
    setLoaded(null);
    if (previous) await previous.close();
  }, []);

  const pickFile = async (next: File | undefined) => {
    if (!next || inspecting || parsing || running) return;
    setDragOver(false);
    setPickError('');
    setParseError('');
    setPasswordWrong(false);
    setParseProgress(null);
    setRows([]);
    setRunPaths([]);
    setZipInfo(null);
    setFile(next);
    setInspecting(true);
    await dropLoaded();
    invalidateTableCache();
    try {
      const info = await inspectZip(next);
      setZipInfo(info);
      setStage('unlock');
      log(
        `已选择 ${info.fileName}：${info.dataCount} 个 sas7bdat · ${
          info.encrypted ? (info.zipCrypto ? 'ZipCrypto 加密' : 'AES 加密') : '未加密'
        }`,
      );
      if (!info.encrypted) setPassword('');
    } catch (err) {
      setFile(null);
      setPickError(messageOf(err));
      log(`选择失败：${messageOf(err)}`, 'err');
    } finally {
      setInspecting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const parse = async () => {
    if (!file || parsing) return;
    setParsing(true);
    setParseError('');
    setPasswordWrong(false);
    setParseProgress({ done: 0, total: zipInfo?.dataCount ?? 0, current: '' });
    await dropLoaded();
    invalidateTableCache();
    try {
      const zip = await loadZip(file, password, (done, total, current) => setParseProgress({ done, total, current }));
      const totalRows = zip.domains.reduce((sum, domain) => sum + domain.rowCount, 0);
      loadedRef.current = zip;
      setLoaded(zip);
      setRunPaths([]);
      setRows(
        zip.domains.map(entry => ({
          entry,
          // 空数据集默认不勾：覆盖更新时勾上它会把同名表的旧记录删光却不补新数据
          selected: entry.rowCount > 0,
          status: '待导入',
          written: 0,
          deleted: 0,
          clearTotal: 0,
          message: '',
        })),
      );
      setStage('import');
      setFinished(false);
      const empty = zip.domains.filter(entry => !entry.rowCount).length;
      log(
        `解析完成：${zip.domains.length} 个数据集，共 ${totalRows.toLocaleString()} 行${empty ? `；${empty} 个空数据集已默认取消勾选` : ''}`,
        'ok',
      );
    } catch (err) {
      const message = messageOf(err);
      setParseError(message);
      setPasswordWrong(isPasswordError(err));
      log(`解析失败：${message}`, 'err');
      if (isPasswordError(err)) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
    } finally {
      setParsing(false);
      setParseProgress(null);
    }
  };

  const reset = async () => {
    if (running) return;
    abortRef.current = false;
    await dropLoaded();
    setFile(null);
    setFinished(false);
    setZipInfo(null);
    setRows([]);
    setRunPaths([]);
    setPassword('');
    setParseError('');
    setPasswordWrong(false);
    setPickError('');
    setQuery('');
    setConfirmOpen(false);
    setConfirmAck(false);
    setStage('pick');
    invalidateTableCache();
  };

  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? rows.filter(row => row.entry.tableName.toLowerCase().includes(keyword))
      : rows.slice();
    const sorters: Record<SortKey, (a: RowState, b: RowState) => number> = {
      name: (a, b) => a.entry.tableName.localeCompare(b.entry.tableName),
      rows: (a, b) => b.entry.rowCount - a.entry.rowCount,
      size: (a, b) => b.entry.rawSize - a.entry.rawSize,
    };
    return filtered.sort(sorters[sortKey]);
  }, [rows, query, sortKey]);

  const selectedRows = useMemo(() => rows.filter(row => row.selected), [rows]);
  const plannedRows = useMemo(() => selectedRows.reduce((sum, row) => sum + row.entry.rowCount, 0), [selectedRows]);
  const totalRows = useMemo(() => rows.reduce((sum, row) => sum + row.entry.rowCount, 0), [rows]);
  const doneCount = useMemo(() => rows.filter(row => row.status === '完成').length, [rows]);
  const failCount = useMemo(() => rows.filter(row => row.status === '失败').length, [rows]);

  // 进度条只反映最近一次实际跑过的数据集，改勾选或重跑部分数据集都不会把上一次的数字混进来
  const runRows = useMemo(() => {
    if (!runPaths.length) return [];
    const paths = new Set(runPaths);
    return rows.filter(row => paths.has(row.entry.path));
  }, [rows, runPaths]);
  const targetRows = runRows.length ? runRows.reduce((sum, row) => sum + row.entry.rowCount, 0) : plannedRows;
  const writtenRows = runRows.reduce((sum, row) => sum + row.written, 0);
  const deletedRows = runRows.reduce((sum, row) => sum + row.deleted, 0);

  const startImport = () => {
    if (!loaded || !selectedRows.length || running) return;
    if (mode === 'replace') {
      setConfirmAck(false);
      setConfirmOpen(true);
      return;
    }
    void runImport();
  };

  const runImport = async () => {
    if (!loaded || !selectedRows.length || running) return;
    setConfirmOpen(false);
    setRunning(true);
    abortRef.current = false;
    invalidateTableCache();
    const paths = new Set(selectedRows.map(row => row.entry.path));
    setRunPaths([...paths]);
    setRows(prev => prev.map(row => (paths.has(row.entry.path) ? { ...row, written: 0, deleted: 0, clearTotal: 0, message: '' } : row)));
    const replace = mode === 'replace';
    const startedAt = Date.now();
    log(
      `开始${replace ? '覆盖更新' : '追加导入'} ${selectedRows.length} 个数据集，共 ${plannedRows.toLocaleString()} 行（每批 ${batchSize} 条）`,
      replace ? 'warn' : 'info',
    );

    for (const row of selectedRows) {
      if (abortRef.current) {
        patch(row.entry.path, { status: '已中止' });
        log(`已中止，跳过 ${row.entry.tableName} 及后续数据集`, 'warn');
        break;
      }
      try {
        patch(row.entry.path, { status: '读取中', message: '', written: 0, deleted: 0, clearTotal: 0 });
        const cursor = await loaded.readDomain(row.entry.path);
        patch(row.entry.path, { status: '建表中' });
        const prepared = await prepareTable(row.entry);
        const schema = prepared.created
          ? `新建数据表，${prepared.fields.size} 个字段`
          : `已有数据表，补建 ${prepared.addedFields} 个字段`;
        const clearing = replace && !prepared.created;
        patch(row.entry.path, { status: clearing ? '清空中' : '写入中', message: schema });
        log(`${row.entry.tableName}：${schema}`);

        const done = await importDomain(
          cursor,
          prepared,
          {
            onBatch: progress => patch(row.entry.path, { status: '写入中', written: progress.rows }),
            onClear: (deleted, total) =>
              patch(row.entry.path, { status: '清空中', deleted, clearTotal: total, message: `正在删除旧记录 ${deleted}/${total}` }),
            onNotice: text => log(`${row.entry.tableName}：${text}`, 'warn'),
            shouldAbort: () => abortRef.current,
          },
          { batchSize, replace },
        );
        const summary = done.deleted
          ? `${schema}；清空 ${done.deleted.toLocaleString()} 行后写入 ${done.rows.toLocaleString()} 行`
          : `${schema}；已写入 ${done.rows.toLocaleString()} 行`;
        patch(row.entry.path, { status: '完成', written: done.rows, deleted: done.deleted, message: summary });
        log(
          `${row.entry.tableName}：${done.deleted ? `删除 ${done.deleted.toLocaleString()} 行，` : ''}写入 ${done.rows.toLocaleString()} 行（${done.batches} 批）`,
          'ok',
        );
      } catch (err) {
        const aborted = isAbortError(err);
        patch(row.entry.path, { status: aborted ? '已中止' : '失败', message: messageOf(err) });
        log(`${row.entry.tableName}：${aborted ? '已中止' : '失败'} —— ${messageOf(err)}`, aborted ? 'warn' : 'err');
        if (aborted) break;
      }
      await nextFrame();
    }

    setRunning(false);
    setFinished(true);
    log(`本次导入结束，用时 ${formatDuration(Date.now() - startedAt)}`, 'ok');
  };

  const selectVisible = (value: boolean) => {
    const paths = new Set(visibleRows.map(row => row.entry.path));
    setRows(prev => prev.map(row => (paths.has(row.entry.path) ? { ...row, selected: value } : row)));
  };

  const stepIndex = STEPS.findIndex(step => step.key === stage);
  const busy = inspecting || parsing || running;

  return (
    <div className="app">
      <div className="ambient" aria-hidden="true" />

      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path d="M3 6.5 12 3l9 3.5-9 3.5-9-3.5Z" fill="currentColor" opacity=".95" />
              <path d="M3 12l9 3.5L21 12" fill="none" stroke="currentColor" strokeWidth="1.7" opacity=".6" />
              <path d="M3 17.5 12 21l9-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" opacity=".35" />
            </svg>
          </span>
          <div className="brand-text">
            <span className="eyebrow">SAS → BITABLE</span>
            <h1>数据包导入</h1>
          </div>
        </div>
        <div className="formats" title="支持 SAS 二进制数据集">
          <span className="format is-sas">sas7bdat</span>
        </div>
      </header>

      <ol className="steps">
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            className={`step ${index === stepIndex ? 'is-active' : ''} ${index < stepIndex ? 'is-done' : ''}`}
            aria-current={index === stepIndex ? 'step' : undefined}
          >
            <span className="step-node">{index < stepIndex ? '✓' : index + 1}</span>
            <span className="step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      <main className="stage">
        {stage === 'pick' && (
          <section className="panel">
            <div
              className={`dropzone ${dragOver ? 'is-over' : ''} ${inspecting ? 'is-busy' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => !busy && fileRef.current?.click()}
              onKeyDown={event => {
                if ((event.key === 'Enter' || event.key === ' ') && !busy) {
                  event.preventDefault();
                  fileRef.current?.click();
                }
              }}
              onDragOver={event => {
                event.preventDefault();
                if (!busy) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={event => {
                event.preventDefault();
                void pickFile(event.dataTransfer.files?.[0]);
              }}
            >
              <span className="dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="34" height="34">
                  <path
                    d="M6 4h13l7 7v17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path d="M19 4v7h7" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M11 15h10M11 19h10M11 23h6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    opacity=".65"
                  />
                </svg>
              </span>
              <strong>{inspecting ? '读取压缩包目录…' : '拖入或点击选择 zip 数据包'}</strong>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={event => void pickFile(event.target.files?.[0])}
            />
            {pickError && <div className="notice is-err">{pickError}</div>}
          </section>
        )}

        {stage === 'unlock' && zipInfo && (
          <section className="panel">
            <div className="filecard">
              <div className="filecard-name" title={zipInfo.fileName}>{zipInfo.fileName}</div>
              <div className="filecard-meta">
                <span>{formatBytes(zipInfo.fileSize)}</span>
                <span className="sep" />
                <span>{zipInfo.dataCount} 个 sas7bdat</span>
                <span className="sep" />
                <span>{zipInfo.entryCount} 个条目</span>
              </div>
              <div className={`lockchip ${zipInfo.encrypted ? 'is-locked' : 'is-open'}`}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <rect x="3" y="7" width="10" height="7" rx="1.4" fill="currentColor" />
                  {zipInfo.encrypted ? (
                    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  ) : (
                    <path d="M5.5 7V5a2.5 2.5 0 0 1 5-.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  )}
                </svg>
                {zipInfo.encrypted ? (zipInfo.zipCrypto ? 'ZipCrypto 加密' : 'AES 加密') : '未加密'}
              </div>
            </div>

            <label className={`field ${passwordWrong ? 'is-invalid' : ''}`}>
              <span className="field-label">解压密码</span>
              <span className="field-box">
                <input
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  placeholder={zipInfo.encrypted ? '输入密码后点下方按钮解析' : '此包未加密，留空即可'}
                  disabled={parsing || !zipInfo.encrypted}
                  autoComplete="off"
                  onChange={event => {
                    setPassword(event.target.value);
                    if (parseError) {
                      setParseError('');
                      setPasswordWrong(false);
                    }
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void parse();
                  }}
                />
                <button
                  type="button"
                  className="eye"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(value => !value)}
                  disabled={!zipInfo.encrypted}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </span>
            </label>

            {parseError && (
              <div className={`notice is-err ${passwordWrong ? 'shake' : ''}`}>
                {parseError}
                {passwordWrong && <span className="notice-extra">文件已保留，改完密码直接重试，不用重新选择。</span>}
              </div>
            )}

            {parsing && parseProgress && (
              <div className="parse-progress">
                <div className="bar-track">
                  <div
                    className="bar-fill is-animated"
                    style={{
                      width: `${parseProgress.total ? (parseProgress.done / parseProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="parse-count">
                  解析中 <b>{parseProgress.done}</b> / {parseProgress.total} 个数据集
                  {parseProgress.current && <em className="parse-current">{parseProgress.current}</em>}
                </span>
              </div>
            )}

            <p className="panel-note">
              先校验密码再逐个数据集解析：密码错误会立刻提示，压缩包不会丢，改完密码重试即可。sas7bdat
              需要整份解压后才能读元信息，大数据集会慢几秒。
            </p>
          </section>
        )}

        {stage === 'import' && (
          <section className="panel is-import">
            <div className={`modebar is-${mode}`}>
              <div className="segmented" role="radiogroup" aria-label="写入方式">
                {(['append', 'replace'] as WriteMode[]).map(option => (
                  <button
                    key={option}
                    role="radio"
                    aria-checked={mode === option}
                    className={`segment ${mode === option ? 'is-on' : ''}`}
                    disabled={running}
                    onClick={() => setMode(option)}
                  >
                    {option === 'replace' && (
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path
                          d="M2.6 6.4A5.6 5.6 0 0 1 12.4 4.6M13.4 9.6A5.6 5.6 0 0 1 3.6 11.4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                        <path
                          d="M12.6 1.9v2.9H9.7M3.4 14.1v-2.9h2.9"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    {MODE_COPY[option].label}
                  </button>
                ))}
              </div>
              <p className="mode-hint">{MODE_COPY[mode].hint}</p>
            </div>

            <div className="controls">
              <div className="summary">
                <div className="summary-cell">
                  <b>{rows.length}</b>
                  <span>个数据集</span>
                </div>
                <div className="summary-cell">
                  <b>{totalRows.toLocaleString()}</b>
                  <span>总行数</span>
                </div>
                <div className="summary-cell is-accent">
                  <b>{plannedRows.toLocaleString()}</b>
                  <span>待写入</span>
                </div>
                <div className="summary-cell">
                  <b>{doneCount}</b>
                  <span>已完成</span>
                </div>
              </div>

              <label className="select">
                <select value={batchSize} disabled={running} onChange={event => setBatchSize(Number(event.target.value))}>
                  {BATCH_OPTIONS.map(size => (
                    <option key={size} value={size}>
                      {size} 行
                    </option>
                  ))}
                </select>
                <span className="select-caption">每批写入</span>
              </label>
            </div>

            <div className="toolbar">
              <input
                className="search"
                type="search"
                value={query}
                placeholder="过滤数据集名，如 LAB"
                disabled={running}
                onChange={event => setQuery(event.target.value)}
              />
              <select
                className="sort"
                value={sortKey}
                disabled={running}
                onChange={event => setSortKey(event.target.value as SortKey)}
                aria-label="排序方式"
              >
                <option value="name">按名称</option>
                <option value="rows">按行数</option>
                <option value="size">按体积</option>
              </select>
              <button className="mini" onClick={() => selectVisible(true)} disabled={running || !visibleRows.length}>
                全选
              </button>
              <button className="mini" onClick={() => selectVisible(false)} disabled={running || !visibleRows.length}>
                清空
              </button>
            </div>

            <div className="domain-list">
              {visibleRows.map(row => (
                <DomainRow
                  key={row.entry.path}
                  row={row}
                  disabled={running}
                  onToggle={selected => patch(row.entry.path, { selected })}
                />
              ))}
              {!visibleRows.length && <div className="empty">没有匹配「{query}」的数据集。</div>}
            </div>

            {failCount > 0 && (
              <div className="notice is-err">
                {failCount} 个数据集写入失败，详情见下方日志；处理后可只勾选这些数据集重跑。
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="dock">
        {stage === 'import' && (
          <div className={`overall ${running ? 'is-live' : ''}`}>
            <div className="bar-track">
              <div
                className={`bar-fill ${running ? 'is-animated' : ''}`}
                style={{ width: `${targetRows ? Math.min(100, (writtenRows / targetRows) * 100) : 0}%` }}
              />
            </div>
            <span className="overall-count">
              {deletedRows > 0 && <em className="overall-deleted">已清空 {deletedRows.toLocaleString()} · </em>}
              {writtenRows.toLocaleString()} / {targetRows.toLocaleString()} 行
            </span>
          </div>
        )}
        <div className="dock-actions">
          {stage === 'pick' && (
            <button className="btn is-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
              {inspecting ? '读取中…' : '选择 zip 数据包'}
            </button>
          )}
          {stage === 'unlock' && (
            <>
              <button className="btn is-primary" onClick={() => void parse()} disabled={parsing || !file}>
                {parsing ? '解析中…' : zipInfo?.encrypted ? '校验密码并解析' : '解析数据包'}
              </button>
              <button className="btn is-ghost" onClick={() => void reset()} disabled={parsing}>
                重新选择
              </button>
            </>
          )}
          {stage === 'import' && (
            <>
              <button
                className={`btn ${mode === 'replace' ? 'is-danger-solid' : 'is-primary'}`}
                onClick={startImport}
                disabled={running || !selectedRows.length}
              >
                {running
                  ? '导入中…'
                  : finished
                    ? `重新导入（${selectedRows.length} 个数据集）`
                    : `${mode === 'replace' ? '覆盖更新' : '开始导入'}（${selectedRows.length} 个数据集）`}
              </button>
              <button
                className="btn is-danger"
                onClick={() => {
                  abortRef.current = true;
                  log('正在中止…（当前批次写完后停止）', 'warn');
                }}
                disabled={!running}
              >
                中止
              </button>
              <button className="btn is-ghost" onClick={() => void reset()} disabled={running}>
                重新选择
              </button>
            </>
          )}
        </div>
      </footer>

      <section className={`console ${logOpen ? 'is-open' : ''} ${logs.some(line => line.tone === 'err') ? 'has-err' : ''}`}>
        <button className="console-head" onClick={() => setLogOpen(value => !value)} aria-expanded={logOpen}>
          <span className="console-title">运行日志</span>
          <span className="console-count">{logs.length}</span>
          <span className="chevron" aria-hidden="true">▾</span>
        </button>
        {logOpen && (
          <div className="console-body" ref={logBodyRef}>
            {logs.length === 0 && <div className="console-empty">暂无日志</div>}
            {logs.map((line, index) => (
              <div key={index} className={`log-line is-${line.tone}`}>
                <span className="log-time">{line.time}</span>
                <span className="log-text">{line.text}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {confirmOpen && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="dialog">
            <div className="dialog-head">
              <span className="dialog-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path d="M12 3.5 22 20H2L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M12 9.5v4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="12" cy="17" r="1.05" fill="currentColor" />
                </svg>
              </span>
              <h2 id="confirm-title">覆盖更新会先删除旧数据</h2>
            </div>
            <p className="dialog-lead">
              下列 <b>{selectedRows.length}</b> 个数据集中，凡是多维表格里已存在同名数据表的，都会
              <b>先删除该表的全部现有记录</b>，再写入本次的 {plannedRows.toLocaleString()} 行。
            </p>
            <ul className="dialog-list">
              {selectedRows.slice(0, 8).map(row => (
                <li key={row.entry.path}>
                  <span className="dialog-name">{row.entry.tableName}</span>
                  <span className="dialog-rows">{row.entry.rowCount.toLocaleString()} 行</span>
                </li>
              ))}
              {selectedRows.length > 8 && <li className="dialog-more">还有 {selectedRows.length - 8} 个数据集…</li>}
            </ul>
            <ul className="dialog-notes">
              <li>字段、视图、仪表盘引用都会保留，只删记录。</li>
              <li>包里新建的数据表没有旧记录，不受影响。</li>
              <li>删除不可撤销；中途中止的话，已删掉的记录不会自动恢复。</li>
            </ul>
            <label className="dialog-ack">
              <input type="checkbox" checked={confirmAck} onChange={event => setConfirmAck(event.target.checked)} />
              <span className="check-box" aria-hidden="true" />
              我已确认这些表的旧数据可以被清除
            </label>
            <div className="dialog-actions">
              <button className="btn is-ghost" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button className="btn is-danger-solid" disabled={!confirmAck} onClick={() => void runImport()}>
                确认覆盖更新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DomainRow({
  row,
  disabled,
  onToggle,
}: {
  row: RowState;
  disabled: boolean;
  onToggle: (selected: boolean) => void;
}) {
  const { entry } = row;
  const clearing = row.status === '清空中';
  const percent = clearing
    ? row.clearTotal
      ? Math.min(100, (row.deleted / row.clearTotal) * 100)
      : 0
    : entry.rowCount
      ? Math.min(100, (row.written / entry.rowCount) * 100)
      : 0;
  const kinds = kindCounts(entry);
  return (
    <div className={`domain ${row.status === '失败' ? 'is-error' : ''} ${row.selected ? '' : 'is-muted'}`}>
      <label className="check">
        <input
          type="checkbox"
          checked={row.selected}
          disabled={disabled}
          onChange={event => onToggle(event.target.checked)}
          aria-label={`选择 ${entry.tableName}`}
        />
        <span className="check-box" aria-hidden="true" />
      </label>
      <div className="domain-body">
        <div className="domain-title">
          <strong>{entry.tableName}</strong>
          <span className="domain-meta">
            {entry.rowCount ? `${entry.rowCount.toLocaleString()} 行` : '空数据集'} · {entry.columns.length} 列 ·{' '}
            {formatBytes(entry.rawSize)}
          </span>
        </div>
        <div className="kinds">
          <span className="kind is-number">数值 {kinds.number}</span>
          <span className="kind is-date">日期 {kinds.datetime}</span>
          <span className="kind is-text">文本 {kinds.text}</span>
        </div>
        {(row.written > 0 || row.deleted > 0 || row.status === '写入中' || clearing) && (
          <div className="bar-track is-thin">
            <div
              className={`bar-fill ${clearing ? 'is-clearing' : ''} ${
                row.status === '写入中' || clearing ? 'is-animated' : ''
              } ${row.status === '完成' ? 'is-done' : ''}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        <div className="domain-status">
          <span className={`badge ${STATUS_CLASS[row.status]}`}>{row.status}</span>
          {clearing ? (
            <span className="counts is-clear">
              删 {row.deleted.toLocaleString()} / {row.clearTotal.toLocaleString()}
            </span>
          ) : (
            row.written > 0 && (
              <span className="counts">
                {row.written.toLocaleString()} / {entry.rowCount.toLocaleString()}
              </span>
            )
          )}
          {row.message && (
            <span className="msg" title={row.message}>
              {row.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function kindCounts(entry: DomainEntry) {
  const counts = { number: 0, datetime: 0, text: 0 };
  for (const col of entry.columns) counts[col.kind]++;
  return counts;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatBytes(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
