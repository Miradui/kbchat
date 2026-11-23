import { createContext, useContext } from 'react';
import type { DocumentItem } from '../../types/api';

export type ImportStatus = 'pending' | 'uploading' | 'succeeded' | 'failed' | 'unconfirmed' | 'duplicate' | 'unavailable';
export type ImportSnapshot = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  uploading: boolean;
  items: Array<{ key: string; name: string; size: number; status: ImportStatus; progress: number; error: string }>;
};
export type ImportOptions = {
  fixedKnowledgeBaseId?: string;
  fixedKnowledgeBaseName?: string;
  initialKnowledgeBaseId?: string;
  knowledgeBases: Array<{ id: string; name: string }>;
};

export type ImportBatch = {
  id?: number;
  documents: DocumentItem[];
  tasks?: Array<{ document: DocumentItem; paused?: boolean; error?: string }>;
  pendingItems?: ImportSnapshot['items'];
};

type DocumentImportContextValue = {
  openImport: (options: ImportOptions) => void;
  openTasks: () => void;
  hasTasks: boolean;
  busyCount: number;
  attentionCount: number;
  taskCount: number;
  changeVersion: number;
  lastBatch: ImportBatch | null;
};

export const DocumentImportContext = createContext<DocumentImportContextValue | null>(null);
export const useDocumentImports = () => useContext(DocumentImportContext);
