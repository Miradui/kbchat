import type { AnswerConfig, Citation, KnowledgeBaseRerankFallback, RetrievalConfig } from './api';

export type EvaluationCaseInput = { question: string; expectedAnswer: string; requiredKeywords: string[]; requireCitation: boolean };
export type EvaluationCase = EvaluationCaseInput & { id: string; knowledgeBaseId: string; createdAt: string; updatedAt: string };
export type EvaluationRunInput = { clientRequestId: string; name: string; caseIds: string[]; config: RetrievalConfig };
export type EvaluationResult = {
  caseId: string; answer: string; answerStatus: string | null; citations: Citation[]; rerankFallback: KnowledgeBaseRerankFallback | null;
  durationMs: number; rulePassed: boolean | null; missingKeywords: string[]; errorCode: string; errorMessage: string;
};
export type EvaluationRun = {
  id: string; knowledgeBaseId: string; clientRequestId: string; name: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  config: RetrievalConfig;
  /** The knowledge base's answer settings captured when the run was created. */
  answerConfig: AnswerConfig;
  cases?: EvaluationCase[]; results?: EvaluationResult[];
  /** `chatModel` is the model that actually answered, which may differ from `answerConfig.model` when that is empty. */
  runtime: { chatModel?: string; embeddingModel?: string; rerankModel?: string; effectiveRerank?: boolean };
  total: number; completedCount: number; errorMessage: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
};
