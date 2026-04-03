export type HistorySource = "user" | "ai";

export interface HistoryEntry {
  before: string;
  after: string;
  source: HistorySource;
  timestamp: number;
  label: string;
  promptBase?: string;
}

export interface DocumentRecord {
  id: string;
  title: string;
  isTitleManual: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
}

export interface StoredDocumentRecord {
  id: string;
  title: string;
  isTitleManual: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  isTitleManual: boolean;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  systemPrompt: string;
}

export interface ModelOption {
  id: string;
  name: string;
  contextLength: number | null;
  description: string;
}

export interface ModelCacheState {
  items: ModelOption[];
  fetchedAt: number | null;
  isLoading: boolean;
  error: string | null;
}

export interface GenerationState {
  status: "idle" | "streaming" | "stopped" | "error";
  documentId: string | null;
  baseContent: string;
  promptBase: string;
  insertedText: string;
  error: string | null;
}

export interface AppMetaState {
  activeDocumentId: string | null;
  documentOrder: string[];
  settings: AppSettings;
  modelCache: Omit<ModelCacheState, "isLoading" | "error">;
}

export interface PersistedAppState {
  documents: StoredDocumentRecord[];
  activeDocumentId: string | null;
  settings: AppSettings;
  modelCache: Omit<ModelCacheState, "isLoading" | "error">;
}

export interface PersistedBootstrapState {
  meta: AppMetaState;
  summaries: DocumentSummary[];
  activeDocument: StoredDocumentRecord | null;
}

// Legacy localStorage payload for the old single-blob storage format.
// Keep this type in sync with the migration code so existing users can be
// upgraded safely as the IndexedDB schema evolves.
export interface LegacyLocalStorageState {
  documents: DocumentRecord[];
  activeDocumentId: string | null;
  settings: AppSettings;
  modelCache: Omit<ModelCacheState, "isLoading" | "error">;
}
