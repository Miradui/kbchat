import { useEffect, useId, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import { updateKnowledgeBase } from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/Field';
import type { AnswerConfig, KnowledgeBase } from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import { answerPromptTemplates } from './answerPromptTemplates';

export function AnswerConfigForm({ knowledgeBase, onUpdated }: { knowledgeBase: KnowledgeBase; onUpdated: (value: KnowledgeBase) => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const ids = { addition: useId(), template: useId(), language: useId(), model: useId(), temperature: useId(), trial: useId() };
  const { chatModels = [] } = useSystemCapabilities();
  const editable = canUnlessUnknown(knowledgeBase, 'kb.write');
  const [config, setConfig] = useState<AnswerConfig>(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [trialAfterSave, setTrialAfterSave] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<(typeof answerPromptTemplates)[number] | null>(null);
  useEffect(() => setConfig(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null }), [knowledgeBase.answerConfig]);
  const dirty = JSON.stringify(config) !== JSON.stringify(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null });
  const blocker = useBlocker(dirty);
  const trialUrl = `/chat?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`;
  const canTrial = canUnlessUnknown(knowledgeBase, 'chat.use');
  useUnsavedChangesWarning(dirty);
  useEffect(() => {
    if (dirty || saving) return;
    if (blocker.state === 'blocked') blocker.proceed();
    else if (trialAfterSave) void navigate(trialUrl);
  }, [blocker, dirty, navigate, saving, trialAfterSave, trialUrl]);
  function applyTemplate(template: (typeof answerPromptTemplates)[number]) {
    if (!editable || saving) return;
    setConfig((current) => ({ ...current, systemPromptAddition: template.prompt }));
    setPendingTemplate(null);
    toast.success(`已填入「${template.name}」模板，保存后生效`);
  }
  function chooseTemplate(id: string) {
    if (!editable || saving) return;
    const template = answerPromptTemplates.find((item) => item.id === id);
    if (!template) return;
    if (config.systemPromptAddition.trim()) setPendingTemplate(template);
    else applyTemplate(template);
  }
  async function saveConfig(): Promise<boolean> {
    if (!editable || !dirty || saving) return false;
    setSaving(true); setError('');
    try {
      const updated = await updateKnowledgeBase(knowledgeBase.id, { name: knowledgeBase.name, description: knowledgeBase.description, categoryId: knowledgeBase.categoryId ?? null, visibility: knowledgeBase.visibility, retrievalConfig: knowledgeBase.retrievalConfig, answerConfig: config, tagIds: knowledgeBase.tags?.map((tag) => tag.id) ?? [] });
      onUpdated(updated); toast.success('回答配置已保存');
      return true;
    } catch (caught) { setError(getErrorMessage(caught, '回答配置保存失败')); return false; }
    finally { setSaving(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trial = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('name') === 'trial';
    if (trial && !canTrial) return;
    if (await saveConfig()) setTrialAfterSave(trial);
  }
  return <section className="ui-panel"><div className="ui-panel__head"><h2>回答配置</h2><span className="ui-panel__head-note">控制回答语言、边界与风格</span></div><div className="ui-panel__body"><form className="kb-config-form" onSubmit={(event) => void submit(event)}>
    <p className="ui-field__hint">提示词、语言、模型和温度仅在手动选择本库的知识问答中生效。自动检索、多库问答和通用常识回答使用系统默认配置。</p>
    <Field hint="选择后填入下方文本框，可继续编辑；保存配置后生效。" htmlFor={ids.template} label="内置模板">
      <Select id={ids.template} disabled={!editable || saving} onChange={(event) => chooseTemplate(event.target.value)} value="">
        <option value="" disabled>选择一个模板…</option>
        {answerPromptTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
      </Select>
    </Field>
    <Field hint="可设置角色、术语和回答结构，最多 2000 个字符。系统会保留依据与引用规则；留空使用默认回答方式。" htmlFor={ids.addition} label="知识库回答提示词"><Textarea id={ids.addition} disabled={!editable || saving} maxLength={2000} onChange={(event) => setConfig({ ...config, systemPromptAddition: event.target.value })} placeholder="例如：面向普通员工解答，先给结论，再列适用条件、办理步骤和所需材料。" rows={6} value={config.systemPromptAddition} /></Field>
    <div>
      <Button aria-describedby={ids.trial} disabled={dirty || saving || !canTrial} onClick={() => navigate(trialUrl)} variant="secondary">在本库试问</Button>
      <p className="ui-field__hint" id={ids.trial}>{dirty ? '有未保存的修改，可使用下方「保存并试问」。' : '使用已保存配置打开本库的新对话。'}</p>
      {canUnlessUnknown(knowledgeBase, 'quality.read') && <p className="ui-field__hint"><Link to={`/quality?tab=evaluation&knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}>去回归评测对比效果</Link>：先保存一组基准结果，再修改提示词，用相同问题与检索配置重测，对比回答、引用、规则通过率和耗时。</p>}
    </div>
    <Field htmlFor={ids.language} label="回答语言"><Select id={ids.language} disabled={!editable || saving} onChange={(event) => setConfig({ ...config, answerLanguage: event.target.value as AnswerConfig['answerLanguage'] })} value={config.answerLanguage}><option value="auto">自动</option><option value="zh">中文</option><option value="en">English</option></Select></Field>
    <label className="ui-switch-row"><Checkbox checked={config.allowGeneralKnowledge} disabled={!editable || saving} onChange={(event) => setConfig({ ...config, allowGeneralKnowledge: event.target.checked })} /><span>允许在知识片段不足时补充常识，并明确标注。</span></label>
    <Field hint={chatModels.length > 0 ? '留空使用全局模型；只能选择服务端 CHAT_ALLOWED_MODELS 白名单中的模型。' : '服务端未配置 CHAT_ALLOWED_MODELS，当前不开放模型覆盖，回答使用全局默认模型。'} htmlFor={ids.model} label="回答模型"><Select id={ids.model} disabled={!editable || saving || chatModels.length === 0} onChange={(event) => setConfig({ ...config, model: event.target.value })} value={config.model}><option value="">使用全局默认模型</option>{chatModels.map((model) => <option key={model} value={model}>{model}</option>)}{config.model && !chatModels.includes(config.model) && <option value={config.model}>{config.model}（不在白名单）</option>}</Select></Field>
    <Field hint="0 到 1，留空使用 Provider 默认值。" htmlFor={ids.temperature} label="温度"><Input id={ids.temperature} disabled={!editable || saving} max={1} min={0} onChange={(event) => setConfig({ ...config, temperature: event.target.value === '' ? null : Number(event.target.value) })} step={0.05} type="number" value={config.temperature ?? ''} /></Field>
    {error && <p className="ui-inline-error" role="alert">{error}</p>}
    {editable ? <div className="kb-config-form__actions"><Button disabled={!dirty || saving} onClick={() => setConfig(knowledgeBase.answerConfig)} variant="secondary">重置</Button><Button disabled={!dirty} loading={saving} loadingLabel="保存中" type="submit">保存配置</Button><Button disabled={!dirty || saving || !canTrial} name="trial" type="submit" variant="secondary">保存并试问</Button></div> : <p className="ui-field__hint">当前配置为只读，需要管理员成员或所有者权限才能调整。</p>}
  </form></div>
    {blocker.state === 'blocked'
      ? <ConfirmDialog title="放弃未保存的修改？" description={saving ? '正在保存回答配置，请稍候。' : '离开后，本次未保存的回答配置将丢失。'} cancelLabel="继续编辑" confirmLabel="放弃并离开" busy={saving} onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />
      : pendingTemplate && <ConfirmDialog title="替换当前提示词？" description={`将用「${pendingTemplate.name}」模板替换文本框中的内容。确认后可继续编辑，保存配置后生效。`} confirmLabel="替换提示词" onCancel={() => setPendingTemplate(null)} onConfirm={() => applyTemplate(pendingTemplate)}><div aria-label={`${pendingTemplate.name}模板正文`} className="kb-prompt-preview" role="region" tabIndex={0}>{pendingTemplate.prompt}</div></ConfirmDialog>}
  </section>;
}
