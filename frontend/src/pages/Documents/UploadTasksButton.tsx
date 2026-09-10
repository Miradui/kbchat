import { CloudUpload } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useDocumentImports } from './DocumentImportContext';

export function UploadTasksButton() {
  const imports = useDocumentImports();
  if (!imports?.hasTasks) return null;
  return (
    <Button aria-label="上传任务" className="upload-tasks-button" leadingIcon={<CloudUpload aria-hidden="true" />} onClick={imports.openTasks} variant="ghost">
      <span>上传任务</span>
      <span className="upload-tasks-button__count">{imports.busyCount ? `${imports.busyCount} 进行中` : imports.attentionCount ? `${imports.attentionCount} 待处理` : imports.taskCount ? `${imports.taskCount} 已结束` : '待选择文件'}</span>
    </Button>
  );
}
