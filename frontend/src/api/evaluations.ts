import { apiRequest } from './client';
import type { EvaluationCase, EvaluationCaseInput, EvaluationRun, EvaluationRunInput } from '../types/evaluation';

const path = (kb: string) => `/knowledge-bases/${encodeURIComponent(kb)}`;
export function listEvaluationCases(kb: string, signal?: AbortSignal) { return apiRequest<{ items: EvaluationCase[] }>(`${path(kb)}/evaluation-cases`, { signal }); }
export function saveEvaluationCase(kb: string, input: EvaluationCaseInput, id?: string) { return apiRequest<EvaluationCase>(`${path(kb)}/evaluation-cases${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: input }); }
export function deleteEvaluationCase(kb: string, id: string) { return apiRequest<void>(`${path(kb)}/evaluation-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
export function listEvaluationRuns(kb: string, signal?: AbortSignal) { return apiRequest<{ items: EvaluationRun[] }>(`${path(kb)}/evaluation-runs`, { signal }); }
export function createEvaluationRun(kb: string, input: EvaluationRunInput) { return apiRequest<EvaluationRun>(`${path(kb)}/evaluation-runs`, { method: 'POST', body: input }); }
export function getEvaluationRun(kb: string, id: string, signal?: AbortSignal) { return apiRequest<EvaluationRun>(`${path(kb)}/evaluation-runs/${encodeURIComponent(id)}`, { signal }); }
export function cancelEvaluationRun(kb: string, id: string) { return apiRequest<EvaluationRun>(`${path(kb)}/evaluation-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
