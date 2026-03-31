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
  insertedText: string;
  error: string | null;
}

export interface PersistedAppState {
  documents: DocumentRecord[];
  activeDocumentId: string | null;
  settings: AppSettings;
  modelCache: Omit<ModelCacheState, "isLoading" | "error">;
}
