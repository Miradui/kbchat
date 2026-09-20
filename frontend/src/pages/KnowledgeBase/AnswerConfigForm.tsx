import { useEffect, useState } from 'react';
import { updateKnowledgeBase } from '../../api/resources';
import { useToast } from '../../components/feedback/ToastProvider';
import { Button } from '../../components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/ui/Field';
import type { AnswerConfig, KnowledgeBase } from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';

export function AnswerConfigForm({ knowledgeBase, onUpdated }: { knowledgeBase: KnowledgeBase; onUpdated: (value: KnowledgeBase) => void }) {
  const toast = useToast();
  const { chatModels = [] } = useSystemCapabilities();
  const editable = canUnlessUnknown(knowledgeBase, 'kb.write');
  const [config, setConfig] = useState<AnswerConfig>(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setConfig(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null }), [knowledgeBase.answerConfig]);
  const dirty = JSON.stringify(config) !== JSON.stringify(knowledgeBase.answerConfig ?? { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null });
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!editable || !dirty || saving) return; setSaving(true); setError('');
    try { const updated = await updateKnowledgeBase(knowledgeBase.id, { name: knowledgeBase.name, description: knowledgeBase.description, categoryId: knowledgeBase.categoryId ?? null, visibility: knowledgeBase.visibility, retrievalConfig: knowledgeBase.retrievalConfig, answerConfig: config, tagIds: knowledgeBase.tags?.map((tag) => tag.id) ?? [] }); onUpdated(updated); toast.success('回答配置已保存'); }
    catch (caught) { setError(getErrorMessage(caught, '回答配置保存失败')); } finally { setSaving(false); }
  }
  return <section className="ui-panel"><div className="ui-panel__head"><h2>回答配置</h2><span className="ui-panel__head-note">控制回答语言、边界与风格</span></div><div className="ui-panel__body"><form className="kb-config-form" onSubmit={(event) => void submit(event)}>
    <Field hint="最多 2000 个字符，基础安全约束不会被覆盖。" label="系统提示补充"><Textarea disabled={!editable || saving} maxLength={2000} onChange={(event) => setConfig({ ...config, systemPromptAddition: event.target.value })} rows={5} value={config.systemPromptAddition} /></Field>
    <Field label="回答语言"><Select disabled={!editable || saving} onChange={(event) => setConfig({ ...config, answerLanguage: event.target.value as AnswerConfig['answerLanguage'] })} value={config.answerLanguage}><option value="auto">自动</option><option value="zh">中文</option><option value="en">English</option></Select></Field>
    <label className="ui-switch-row"><Checkbox checked={config.allowGeneralKnowledge} disabled={!editable || saving} onChange={(event) => setConfig({ ...config, allowGeneralKnowledge: event.target.checked })} /><span>允许在知识片段不足时补充常识，并明确标注。</span></label>
    <Field hint="留空使用全局模型；模型白名单由服务端校验。" label="回答模型">{chatModels.length > 0 ? <Select disabled={!editable || saving} onChange={(event) => setConfig({ ...config, model: event.target.value })} value={config.model}><option value="">使用全局默认模型</option>{chatModels.map((model) => <option key={model} value={model}>{model}</option>)}</Select> : <Input disabled={!editable || saving} onChange={(event) => setConfig({ ...config, model: event.target.value })} value={config.model} />}</Field>
    <Field hint="0 到 1，留空使用 Provider 默认值。" label="温度"><Input disabled={!editable || saving} max={1} min={0} onChange={(event) => setConfig({ ...config, temperature: event.target.value === '' ? null : Number(event.target.value) })} step={0.05} type="number" value={config.temperature ?? ''} /></Field>
    {error && <p className="ui-inline-error" role="alert">{error}</p>}
    {editable ? <div className="kb-config-form__actions"><Button disabled={!dirty || saving} onClick={() => setConfig(knowledgeBase.answerConfig)} variant="secondary">重置</Button><Button disabled={!dirty} loading={saving} loadingLabel="保存中" type="submit">保存配置</Button></div> : <p className="ui-field__hint">当前配置为只读，需要管理员成员或所有者权限才能调整。</p>}
  </form></div></section>;
}
