import type { ChatFeedbackReason } from '../types/api';

export const chatFeedbackReasons: Record<ChatFeedbackReason, string> = {
  inaccurate: '回答不准确', missing_evidence: '缺少依据', irrelevant: '答非所问', incomplete: '内容不完整', other: '其他原因',
};

export function chatFeedbackReasonLabel(reason?: string) {
  return reason ? chatFeedbackReasons[reason as ChatFeedbackReason] || '其他原因' : '未填写原因';
}
