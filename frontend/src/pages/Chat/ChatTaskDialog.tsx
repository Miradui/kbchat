import { useId, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input } from '../../components/ui/Field';
import { ChatDocumentPicker } from './ChatDocumentPicker';
import type { ChatDocument } from './documentChatScope';

export type ChatTaskKind = 'summary' | 'comparison' | 'policy';
export type ChatTaskResult = { question: string; documents?: ChatDocument[] };

const titles: Record<ChatTaskKind, string> = {
  summary: '总结一份资料', comparison: '对比文档差异', policy: '查找制度规定',
};
const formats = {
  overview: { label: '概览', instruction: '按资料主题、主要内容、适用范围和待确认事项组织概览。' },
  keyPoints: { label: '关键要点', instruction: '按主题列出关键要点，保留重要条件、数字、时限与例外。' },
  steps: { label: '操作步骤', instruction: '按执行顺序列出操作步骤，注明适用条件、责任人、所需材料、时限与例外。' },
};
const evidenceInstructions = '只依据本轮检索到的片段回答，每项结论标注引用来源。资料未提及的内容请明确写“资料未提及”，不要补造事实或差异。说明检索片段的覆盖限制，不把局部内容表述为全文结论。';

export function ChatTaskDialog({ kind, knowledgeBases, onClose, onApply }: {
  kind: ChatTaskKind;
  knowledgeBases: Array<{ id: string; name: string }>;
  onClose: () => void;
  onApply: (result: ChatTaskResult) => void;
}) {
  const id = useId();
  const [documents, setDocuments] = useState<ChatDocument[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [format, setFormat] = useState<keyof typeof formats>('overview');
  const [subject, setSubject] = useState('');
  const [audience, setAudience] = useState('');
  const [documentsError, setDocumentsError] = useState('');
  const [subjectError, setSubjectError] = useState('');
  const documentsButton = useRef<HTMLButtonElement>(null);
  const subjectInput = useRef<HTMLInputElement>(null);
  const requiredDocuments = kind === 'summary' ? 1 : 2;
  const baseName = (document: ChatDocument) => knowledgeBases.find((base) => base.id === document.knowledgeBaseId)?.name || document.knowledgeBaseId;
  const documentIdentity = (document: ChatDocument, index: number) => `资料${kind === 'comparison' ? (index === 0 ? ' A' : ' B') : ''}：《${document.filename}》（知识库：${baseName(document)}；文档编号：${document.id}）`;

  function apply() {
    const invalidDocuments = kind !== 'policy' && (documents.length !== requiredDocuments || new Set(documents.map((document) => document.id)).size !== requiredDocuments);
    const invalidSubject = kind !== 'summary' && !subject.trim();
    setDocumentsError(invalidDocuments ? `请选择 ${requiredDocuments} 份${kind === 'comparison' ? '不同的' : ''}文档。` : '');
    setSubjectError(invalidSubject ? (kind === 'comparison' ? '请填写需要比较的事项。' : '请填写要查询的制度主题。') : '');
    if (invalidDocuments) { documentsButton.current?.focus(); return; }
    if (invalidSubject) { subjectInput.current?.focus(); return; }

    const request = kind === 'summary'
      ? `请总结以下指定资料。\n${documents.map(documentIdentity).join('\n')}\n输出形式：${formats[format].label}。${formats[format].instruction}`
      : kind === 'comparison'
        ? `请对比以下两份指定资料。\n${documents.map(documentIdentity).join('\n')}\n比较事项：${subject.trim()}。\n按比较事项逐项列出资料 A、资料 B 的规定、共同点、差异及各自引用来源；某一份资料没有相关依据时单独说明。`
        : `请在当前资料范围中查找制度规定。\n查询主题：${subject.trim()}。${audience.trim() ? `\n适用对象：${audience.trim()}。` : ''}\n按适用范围、具体规定、执行条件与步骤、时限和例外组织回答。`;
    onApply({ question: `${request}\n${evidenceInstructions}`, ...(kind === 'policy' ? {} : { documents }) });
  }

  return <>
    <Dialog className="chat-doc-picker" open onClose={onClose} title={titles[kind]} description="先明确任务，再生成可继续编辑的问题。确认后填入输入框，由你发送。">
      <form aria-label={titles[kind]} className="ui-form" noValidate onSubmit={(event) => { event.preventDefault(); apply(); }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}>
        {kind !== 'policy' && <>
          <fieldset className="ui-field">
            <legend className="ui-field__label">目标资料（必选 {requiredDocuments} 份）</legend>
            <Button aria-describedby={`${id}-documents-hint`} aria-invalid={documentsError ? true : undefined} ref={documentsButton} onClick={() => setPickerOpen(true)} variant="secondary">{documents.length ? '重新选择资料' : '选择资料'}</Button>
            <p className={documentsError ? 'ui-field__error' : 'ui-field__hint'} id={`${id}-documents-hint`} role={documentsError ? 'alert' : undefined}>{documentsError || '只检索所选文档；重新选择和取消不会改动当前提问草稿。'}</p>
          </fieldset>
          {documents.length > 0 && <ul className="ui-cell-stack">
            {documents.map((document, index) => <li key={document.id}>{kind === 'comparison' ? `资料 ${index === 0 ? 'A' : 'B'}：` : ''}{document.filename}（{baseName(document)}）</li>)}
          </ul>}
        </>}
        {kind === 'summary' ? <fieldset className="ui-form">
          <legend className="ui-field__label">输出形式</legend>
          {Object.entries(formats).map(([value, option]) => <label className="chat-doc-picker__row" htmlFor={`${id}-${value}`} key={value}>
            <input checked={format === value} className="ui-checkbox" id={`${id}-${value}`} name="summaryFormat" onChange={() => setFormat(value as keyof typeof formats)} type="radio" value={value} />
            <span>{option.label}</span>
          </label>)}
        </fieldset> : <Field label={kind === 'comparison' ? '比较事项（必填）' : '制度主题（必填）'} htmlFor={`${id}-subject`} error={subjectError}>
          <Input id={`${id}-subject`} name="subject" ref={subjectInput} required value={subject} placeholder={kind === 'comparison' ? '例如：审批条件、费用标准、执行流程' : '例如：差旅报销、年假申请'} onChange={(event) => { setSubject(event.target.value); if (event.target.value.trim()) setSubjectError(''); }} />
        </Field>}
        {kind === 'policy' && <>
          <Field label="适用对象（可选）" htmlFor={`${id}-audience`}><Input id={`${id}-audience`} name="audience" value={audience} placeholder="例如：试用期员工、出差人员" onChange={(event) => setAudience(event.target.value)} /></Field>
          <p className="ui-muted">沿用当前提问的资料范围，可在发送前调整。</p>
        </>}
        <p className="ui-muted">回答仅依据检索到的片段，并说明资料未提及的内容和覆盖限制。</p>
        <div className="ui-dialog__actions">
          <Button onClick={onClose} variant="secondary">取消</Button>
          <Button type="submit">生成问题</Button>
        </div>
      </form>
    </Dialog>
    {pickerOpen && <ChatDocumentPicker knowledgeBases={knowledgeBases} title={`选择 ${requiredDocuments} 份${kind === 'comparison' ? '对比' : '总结'}资料`} description={`请选择 ${requiredDocuments} 份${kind === 'comparison' ? '不同的' : ''}已处理文档。仅检索所选文档。`} minSelection={requiredDocuments} maxSelection={requiredDocuments} initialSelection={documents} onClose={() => setPickerOpen(false)} onSelect={(selected) => { setDocuments(selected); setDocumentsError(''); setPickerOpen(false); }} />}
  </>;
}
