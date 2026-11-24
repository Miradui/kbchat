import { Button } from '../../components/ui/Button';
import type { DocumentItem } from '../../types/api';
import { documentChatUrl } from '../Chat/documentChatScope';

type DocumentsBatchBarProps = {
  items: DocumentItem[];
  selectedIds: string[];
  reprocessing: boolean;
  onNavigate: (to: string) => void;
  onReprocess: () => void;
  onDelete: () => void;
};

export function DocumentsBatchBar({
  items,
  selectedIds,
  reprocessing,
  onNavigate,
  onReprocess,
  onDelete,
}: DocumentsBatchBarProps) {
  if (selectedIds.length === 0) return null;

  const selectedDocuments = items.filter((item) => selectedIds.includes(item.id));
  const askDisabled = selectedIds.length > 20
    || items.filter((item) => selectedIds.includes(item.id) && item.status === 'completed').length !== selectedIds.length
    || new Set(selectedDocuments.map((item) => item.knowledgeBaseId)).size > 5;

  return (
    <div className="ui-bulkbar">
      <span className="ui-bulkbar__count">已选择 {selectedIds.length} 个文档</span>
      <Button
        variant="secondary"
        disabled={askDisabled}
        onClick={() => onNavigate(documentChatUrl(selectedDocuments))}
      >
        针对所选文档提问
      </Button>
      <Button
        disabled={reprocessing}
        variant="secondary"
        onClick={onReprocess}
      >
        重新处理
      </Button>
      <span className="ui-toolbar__spacer" />
      <Button
        variant="danger"
        onClick={onDelete}
      >
        删除
      </Button>
    </div>
  );
}
