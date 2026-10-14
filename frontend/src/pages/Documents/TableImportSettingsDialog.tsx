import { useEffect, useState } from 'react';
import { inspectTableImport } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import type { TableImportOptions, TableImportPreview } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

type SheetOptions = TableImportOptions['sheets'][number];

export function TableImportSettingsDialog({ file, knowledgeBaseId, initial, onClose, onApply, inspect = (...args) => inspectTableImport(...args) }: {
  file: File;
  knowledgeBaseId: string;
  initial?: TableImportOptions;
  onClose: () => void;
  onApply: (options?: TableImportOptions) => void;
  inspect?: typeof inspectTableImport;
}) {
  const [preview, setPreview] = useState<TableImportPreview | null>(null);
  const [sheets, setSheets] = useState<SheetOptions[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(''); setPreview(null);
    void inspect(knowledgeBaseId, file, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPreview(result);
      setSheets(initial?.sheets ?? result.sheets.filter((sheet) => sheet.columnCount > 0).map((sheet) => ({ name: sheet.name, headerRow: 0 })));
      setActiveSheet(result.sheets[0]?.name ?? '');
    }).catch((caught) => { if (!controller.signal.aborted) setError(getErrorMessage(caught, '表格预览失败，请重试。')); });
    return () => controller.abort();
    // An inspection belongs to this exact file and target; parent remounts on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, knowledgeBaseId, attempt]);

  const current = preview?.sheets.find((sheet) => sheet.name === activeSheet);
  const options = sheets.find((sheet) => sheet.name === activeSheet);
  const header = current?.rows.find((row) => row.rowStart === (options?.headerRow || current.suggestedHeaderRow));
  const columns = Array.from({ length: current?.columnCount ?? 0 }, (_, i) => i + 1);
  const invalid = !sheets.length || sheets.some((sheet) => !Number.isInteger(sheet.headerRow) || sheet.headerRow < 0 || sheet.headerRow > (preview?.sheets.find((s) => s.name === sheet.name)?.lastRow ?? 0) || sheet.columns?.length === 0);
  function update(patch: Partial<SheetOptions>) { setSheets((value) => value.map((sheet) => sheet.name === activeSheet ? { ...sheet, ...patch } : sheet)); }

  return <Dialog className="table-import-settings" title="表格导入设置" description={`${file.name} · 选择参与问答的工作表和列，行号保留原文件位置。`} open onClose={onClose}>
    {error ? <div role="alert"><p className="ui-inline-error">{error}</p><Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试预览</Button></div> : !preview ? <p role="status">正在读取工作表预览…</p> : <div className="table-import">
      <fieldset className="table-import__sheets"><legend>导入工作表</legend>{preview.sheets.map((sheet) => <label key={sheet.name}>
        <input type="checkbox" aria-label={`导入工作表 ${sheet.name || 'CSV'}`} disabled={!sheet.columnCount} checked={sheets.some((s) => s.name === sheet.name)} onChange={(event) => setSheets((value) => event.target.checked ? [...value, { name: sheet.name, headerRow: 0 }] : value.filter((s) => s.name !== sheet.name))} />
        {sheet.name || 'CSV'}{!sheet.columnCount && '（空表）'}
      </label>)}</fieldset>
      {preview.sheets.length > 1 && <label>查看工作表<select className="ui-select" aria-label="查看工作表" value={activeSheet} onChange={(event) => setActiveSheet(event.target.value)}>{preview.sheets.map((sheet) => <option value={sheet.name} key={sheet.name}>{sheet.name}</option>)}</select></label>}
      {current && <>
        <label className="table-import__header">表头所在行<input className="ui-input" type="number" min={0} max={current.lastRow} step={1} aria-label="表头所在行" disabled={!options} value={options?.headerRow ?? 0} onChange={(event) => update({ headerRow: Number(event.target.value) })} /></label>
        <p className="ui-muted">0 表示自动使用首个非空记录（第 {current.suggestedHeaderRow || '—'} 行）；手动填写原文件行号，表头之前的内容不入库。</p>
        <fieldset disabled={!options} className="table-import__columns"><legend>导入列</legend>
          <Button variant="link" onClick={() => update({ columns: undefined })}>全选列</Button>
          {columns.map((column) => {
            const label = `${columnName(column)} · ${header?.values[column - 1] || `列 ${column}`}`;
            return <label key={column}><input type="checkbox" aria-label={`导入列 ${columnName(column)}`} checked={Boolean(options && (!options.columns || options.columns.includes(column)))} onChange={(event) => update({ columns: event.target.checked ? [...(options?.columns ?? columns), column].sort((a, b) => a - b) : (options?.columns ?? columns).filter((value) => value !== column) })} /><span title={label}>{label}</span></label>;
          })}
        </fieldset>
        <div className="table-import__preview" role="region" aria-label="表格原始预览" tabIndex={0}>
          <table><thead><tr><th scope="col">原行号</th>{columns.map((column) => <th key={column} scope="col">{columnName(column)}</th>)}</tr></thead>
            <tbody>{current.rows.map((row) => <tr className={row.rowStart === (options?.headerRow || current.suggestedHeaderRow) ? 'is-header' : ''} key={row.rowStart}><th scope="row">{row.rowStart === row.rowEnd ? row.rowStart : `${row.rowStart}–${row.rowEnd}`}</th>{columns.map((column) => <td className={options?.columns && !options.columns.includes(column) ? 'is-excluded' : ''} key={column}>{row.values[column - 1] || '—'}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="ui-muted">最多预览前 20 个非空记录，较长单元格截断显示。实际导入按完整文件和所选设置处理；公式仅读取已保存的值。</p>
      </>}
      {invalid && <p className="ui-inline-error" role="alert">至少选择一张非空工作表及一列，并填写有效表头行号。</p>}
    </div>}
    <div className="ui-dialog__actions"><Button variant="ghost" onClick={() => onApply(undefined)}>恢复自动设置</Button><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!preview || invalid} onClick={() => onApply({ sheets })}>应用设置</Button></div>
  </Dialog>;
}

function columnName(index: number): string {
  let result = '';
  while (index > 0) { index -= 1; result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26); }
  return result;
}
