import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { updateKnowledgeBase } from '../../api/resources';
import { useToast } from '../../components/feedback/ToastProvider';
import { Button } from '../../components/ui/Button';
import { Checkbox, Field, Input } from '../../components/ui/Field';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import type { KnowledgeBase, RetrievalConfig } from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';

type RetrievalConfigFormProps = {
  knowledgeBase: KnowledgeBase;
  onUpdated: (knowledgeBase: KnowledgeBase) => void;
};

/**
 * Retrieval config is editable here. `PUT /knowledge-bases/:id` has always
 * accepted `retrievalConfig`, but the previous detail page only rendered it as
 * four read-only tiles, so the values could not be tuned from the product at all.
 */
export function RetrievalConfigForm({ knowledgeBase, onUpdated }: RetrievalConfigFormProps) {
  const toast = useToast();
  const { retrieval, rerankEnabled } = useSystemCapabilities();
  const vectorId = useId();
  const rerankId = useId();
  const thresholdId = useId();
  const [config, setConfig] = useState<RetrievalConfig>(knowledgeBase.retrievalConfig);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Read-only rather than hidden for a caller without kb.write. These four numbers
  // explain why an answer cited what it cited, which is worth as much to someone
  // debugging a bad answer as to whoever tunes them.
  const editable = canUnlessUnknown(knowledgeBase, 'kb.write');

  useEffect(() => setConfig(knowledgeBase.retrievalConfig), [knowledgeBase.retrievalConfig]);

  const dirty = (['vectorTopN', 'rerankTopK', 'scoreThreshold', 'enableRerank'] as const)
    .some((key) => config[key] !== knowledgeBase.retrievalConfig[key]);

  // Bounds published by GET /system/capabilities, applied here so the user sees
  // the clamp before submitting. See docs/14-frontend-api-gaps.md G6.
  const vectorTopN = clamp(config.vectorTopN, 1, retrieval.maxVectorTopN);
  const rerankTopK = clamp(config.rerankTopK, 1, Math.min(retrieval.maxRerankTopK, vectorTopN));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || !editable || !dirty) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const updated = await updateKnowledgeBase(knowledgeBase.id, {
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        categoryId: knowledgeBase.categoryId ?? null,
        visibility: knowledgeBase.visibility,
        retrievalConfig: {
          vectorTopN,
          rerankTopK,
          scoreThreshold: clamp(config.scoreThreshold, 0, 1),
          enableRerank: config.enableRerank,
        },
        tagIds: knowledgeBase.tags?.map((tag) => tag.id) ?? [],
      });
      if (!mountedRef.current) return;
      onUpdated(updated);
      toast.success('检索配置已保存');
    } catch (caught) {
      if (mountedRef.current) setError(getErrorMessage(caught, '检索配置保存失败'));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="ui-panel">
      <div className="ui-panel__head">
        <h2>检索配置</h2>
        <span className="ui-panel__head-note">控制召回范围与结果排序</span>
      </div>
      <div className="ui-panel__body">
        <form className="kb-config-form" onSubmit={(event) => void submit(event)}>
          <div className="kb-config-form__row">
            <Field
              hint={`向量检索返回的候选数量，最大 ${retrieval.maxVectorTopN}`}
              htmlFor={vectorId}
              label="向量召回数量"
            >
              <Input
                disabled={!editable || saving}
                id={vectorId}
                max={retrieval.maxVectorTopN}
                min={1}
                onChange={(event) => setConfig({ ...config, vectorTopN: Number(event.target.value) })}
                type="number"
                value={config.vectorTopN}
              />
            </Field>

            <Field
              hint={`进入回答的片段数量，最大 ${retrieval.maxRerankTopK} 且不超过召回数量`}
              htmlFor={rerankId}
              label="精排保留数量"
            >
              <Input
                disabled={!editable || saving}
                id={rerankId}
                max={Math.min(retrieval.maxRerankTopK, vectorTopN)}
                min={1}
                onChange={(event) => setConfig({ ...config, rerankTopK: Number(event.target.value) })}
                type="number"
                value={config.rerankTopK}
              />
            </Field>
          </div>

          <Field
            hint="低于该相关度的片段不会进入回答和引用。0 到 1 之间。"
            htmlFor={thresholdId}
            label="最低相关度"
          >
            <Input
              disabled={!editable || saving}
              id={thresholdId}
              max={1}
              min={0}
              onChange={(event) => setConfig({ ...config, scoreThreshold: Number(event.target.value) })}
              step={0.05}
              type="number"
              value={config.scoreThreshold}
            />
          </Field>

          <label className="ui-switch-row">
            <Checkbox
              checked={config.enableRerank}
              disabled={!editable || saving}
              onChange={(event) => setConfig({ ...config, enableRerank: event.target.checked })}
            />
            <span>启用精排。关闭后直接使用向量召回的前 N 条。</span>
          </label>

          {/*
            Says up front that the server has no rerank provider wired, instead of
            waiting for a `rerankFallback` to come back from a query the user
            already ran. See docs/14-frontend-api-gaps.md G6.
          */}
          {!rerankEnabled && config.enableRerank && (
            <p className="ui-inline-notice" role="status">
              <TriangleAlert aria-hidden="true" size={14} />
              <span>服务端当前未启用精排（RERANK_ENABLED=false），该开关会保存但暂不生效，检索将按向量相关度排序。</span>
            </p>
          )}

          {error && <p className="ui-inline-error" role="alert">{error}</p>}

          {editable ? (
            <div className="kb-config-form__actions">
              <Button
                disabled={!dirty || saving}
                variant="secondary"
                title="恢复已保存的配置"
                onClick={() => { setConfig(knowledgeBase.retrievalConfig); setError(''); }}
              >
                重置
              </Button>
              <Button disabled={!dirty} loading={saving} loadingLabel="保存中" type="submit">保存配置</Button>
            </div>
          ) : (
            <p className="ui-field__hint">当前配置为只读，需要管理员权限才能调整。</p>
          )}
        </form>
      </div>
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
