import { Button } from '../../components/ui/Button';
import type { DocumentDuplicateDetails } from '../../types/api';
import { formatRelativeTime } from '../../utils/format';

export type DuplicateChoiceProps = {
  busy: boolean;
  canReplace: boolean;
  details: DocumentDuplicateDetails;
  filename: string;
  onChoose: (choice: 'keep' | 'replace') => void;
};

/**
 * Inline rather than a modal: a batch can raise several conflicts, and a modal per
 * file would make the user answer them one at a time in an order they did not pick.
 *
 * Both options are spelled out in terms of the outcome. "替换" archives the old
 * document with a version trail rather than deleting it, which is worth saying --
 * otherwise the choice reads as destructive and people default to keeping two copies
 * they do not want.
 */
export function DuplicateChoice({ busy, canReplace, details, filename, onChoose }: DuplicateChoiceProps) {
  return (
    <div className="doc-import__duplicate">
      <p className="doc-import__duplicate-text">
        与已有文档
        <strong>{details.existingFilename}</strong>
        内容相同
        {details.existingUploadedAt ? `（${formatRelativeTime(details.existingUploadedAt)}上传）` : ''}
        。
      </p>
      <div className="doc-import__duplicate-actions">
        {canReplace && (
          <Button
            disabled={busy}
            onClick={() => onChoose('replace')}
            variant="primary"
          >
            替换原文档
          </Button>
        )}
        <Button disabled={busy} onClick={() => onChoose('keep')} variant="ghost">
          保留两份
        </Button>
      </div>
      <p className="doc-import__duplicate-note ui-muted">
        替换后原文档会保留为历史版本，仍可在回答的引用中追溯；
        <span aria-label={`${filename} 保留两份说明`}>保留两份会让同样的内容被检索到两次。</span>
      </p>
    </div>
  );
}
