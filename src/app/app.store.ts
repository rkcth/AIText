import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import {
  AppSettings,
  DocumentRecord,
  GenerationState,
  HistoryEntry,
  ModelCacheState,
  PersistedAppState,
} from "./app.types";
import {
  EMPTY_DOCUMENT_MARKDOWN,
  appendPlainTextToContent,
  markdownToPlainText,
  normalizeStoredContent,
} from "./content-utils";
import { OpenRouterService } from "./openrouter.service";

type SettingKey = keyof AppSettings;

const STORAGE_KEY = "aitext.state.v1";
const USER_HISTORY_DEBOUNCE_MS = 900;
const SAVE_DEBOUNCE_MS = 500;

const defaultSettings = (): AppSettings => ({
  apiKey: "",
  model: "",
  maxTokens: 256,
  temperature: 0.9,
  topP: 1,
  systemPrompt: [
    "You are a continuation engine for a local text editor.",
    "",
    "Continue the user's existing text from exactly where it ends.",
    "Match the existing language, tone, formatting, and point of view unless the text itself suggests a clear shift.",
    "Do not explain, summarize, apologize, censor, warn, or add framing.",
    "Do not repeat large portions of the existing text.",
    "Output only the continuation text.",
  ].join("\n"),
});

const defaultGeneration = (): GenerationState => ({
  status: "idle",
  documentId: null,
  baseContent: EMPTY_DOCUMENT_MARKDOWN,
  promptBase: "",
  insertedText: "",
  error: null,
});

const createDocument = (index: number): DocumentRecord => ({
  id: crypto.randomUUID(),
  title: `Untitled ${index}`,
  isTitleManual: false,
  content: EMPTY_DOCUMENT_MARKDOWN,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  undoStack: [],
  redoStack: [],
});

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

@Injectable({ providedIn: "root" })
export class AppStore {
  private readonly openRouter = inject(OpenRouterService);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUserHistory:
    | {
        documentId: string;
        before: string;
        after: string;
      }
    | null = null;
  private pendingUserTimer: ReturnType<typeof setTimeout> | null = null;
  private activeAbortController: AbortController | null = null;

  readonly documents = signal<DocumentRecord[]>([]);
  readonly activeDocumentId = signal<string | null>(null);
  readonly settings = signal<AppSettings>(defaultSettings());
  readonly modelCache = signal<ModelCacheState>({
    items: [],
    fetchedAt: null,
    isLoading: false,
    error: null,
  });
  readonly generation = signal<GenerationState>(defaultGeneration());
  readonly saveState = signal<"saved" | "saving">("saved");

  readonly activeDocument = computed(() => {
    const activeId = this.activeDocumentId();
    return this.documents().find((doc) => doc.id === activeId) ?? null;
  });

  readonly canUndo = computed(() => {
    const document = this.activeDocument();
    return Boolean(document && document.undoStack.length > 0 && !this.isStreaming());
  });

  readonly canRedo = computed(() => {
    const document = this.activeDocument();
    return Boolean(document && document.redoStack.length > 0 && !this.isStreaming());
  });

  readonly canRegenerate = computed(() => {
    const document = this.activeDocument();
    if (!document || this.isStreaming()) {
      return false;
    }

    const lastEntry = document.undoStack.at(-1);
    return Boolean(lastEntry && lastEntry.source === "ai");
  });

  readonly selectedModelMissing = computed(() => {
    const selectedModel = this.settings().model.trim();
    if (!selectedModel) {
      return false;
    }

    return !this.modelCache().items.some((item) => item.id === selectedModel);
  });

  constructor() {
    this.loadState();

    effect(() => {
      const payload: PersistedAppState = {
        documents: this.documents(),
        activeDocumentId: this.activeDocumentId(),
        settings: this.settings(),
        modelCache: {
          items: this.modelCache().items,
          fetchedAt: this.modelCache().fetchedAt,
        },
      };

      this.schedulePersist(payload);
    });

    window.addEventListener("beforeunload", () => {
      this.flushPendingUserHistory();
      this.persistNow();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.flushPendingUserHistory();
        this.persistNow();
      }
    });
  }

  createNewDocument(): void {
    this.flushPendingUserHistory();
    const nextDocument = createDocument(this.documents().length + 1);
    this.documents.update((documents) => [nextDocument, ...documents]);
    this.activeDocumentId.set(nextDocument.id);
  }

  selectDocument(documentId: string): void {
    if (this.activeDocumentId() === documentId) {
      return;
    }

    this.flushPendingUserHistory();
    this.activeDocumentId.set(documentId);
  }

  renameDocument(documentId: string, title: string): void {
    this.updateDocument(documentId, (document) => ({
      ...document,
      title,
      isTitleManual: title.trim().length > 0,
      updatedAt: Date.now(),
    }));
  }

  finalizeDocumentTitle(documentId: string): void {
    const document = this.documents().find((entry) => entry.id === documentId);
    if (!document) {
      return;
    }

    const trimmed = document.title.trim();
    const nextTitle = trimmed || `Untitled ${this.getDocumentIndex(documentId)}`;
    this.updateDocument(documentId, (document) => ({
      ...document,
      title: nextTitle,
      isTitleManual: trimmed.length > 0,
      updatedAt: Date.now(),
    }));
  }

  deleteDocument(documentId: string): void {
    const currentDocuments = this.documents();
    if (currentDocuments.length === 1) {
      const replacement = createDocument(1);
      this.documents.set([replacement]);
      this.activeDocumentId.set(replacement.id);
      return;
    }

    const nextDocuments = currentDocuments.filter((document) => document.id !== documentId);
    this.documents.set(nextDocuments);

    if (this.activeDocumentId() === documentId) {
      this.activeDocumentId.set(nextDocuments[0]?.id ?? null);
    }
  }

  updateActiveDocumentContent(content: string): void {
    const activeDocument = this.activeDocument();
    if (!activeDocument || this.isStreaming()) {
      return;
    }

    const normalizedContent = normalizeStoredContent(content);

    this.updateDocument(activeDocument.id, (document) => ({
      ...document,
      content: normalizedContent,
      updatedAt: Date.now(),
    }));

    this.stageUserHistory(activeDocument.id, activeDocument.content, normalizedContent);
  }

  undo(): void {
    this.flushPendingUserHistory();
    const activeDocument = this.activeDocument();
    const entry = activeDocument?.undoStack.at(-1);
    if (!activeDocument || !entry) {
      return;
    }

    this.updateDocument(activeDocument.id, (document) => ({
      ...document,
      content: entry.before,
      updatedAt: Date.now(),
      undoStack: document.undoStack.slice(0, -1),
      redoStack: [...document.redoStack, entry],
    }));
  }

  redo(): void {
    this.flushPendingUserHistory();
    const activeDocument = this.activeDocument();
    const entry = activeDocument?.redoStack.at(-1);
    if (!activeDocument || !entry) {
      return;
    }

    this.updateDocument(activeDocument.id, (document) => ({
      ...document,
      content: entry.after,
      updatedAt: Date.now(),
      undoStack: [...document.undoStack, entry],
      redoStack: document.redoStack.slice(0, -1),
    }));
  }

  async regenerateLastAi(): Promise<void> {
    this.flushPendingUserHistory();
    const activeDocument = this.activeDocument();
    const lastEntry = activeDocument?.undoStack.at(-1);
    if (!activeDocument || !lastEntry || lastEntry.source !== "ai") {
      return;
    }

    this.updateDocument(activeDocument.id, (document) => ({
      ...document,
      content: lastEntry.before,
      updatedAt: Date.now(),
      undoStack: document.undoStack.slice(0, -1),
      redoStack: [],
    }));

    await this.generateCompletion(
      lastEntry.promptBase ?? markdownToPlainText(lastEntry.before),
      lastEntry.before,
    );
  }

  updateSetting<K extends SettingKey>(key: K, value: AppSettings[K]): void {
    this.settings.update((settings) => ({
      ...settings,
      [key]:
        key === "maxTokens"
          ? clampNumber(Number(value), 1, 4096)
          : key === "temperature"
            ? clampNumber(Number(value), 0, 2)
            : key === "topP"
              ? clampNumber(Number(value), 0, 1)
              : value,
    }));
  }

  async refreshModels(): Promise<void> {
    this.modelCache.update((state) => ({
      ...state,
      isLoading: true,
      error: null,
    }));

    try {
      const items = await this.openRouter.fetchModels(this.settings().apiKey);
      this.modelCache.set({
        items,
        fetchedAt: Date.now(),
        isLoading: false,
        error: null,
      });

      const selectedModel = this.settings().model.trim();
      if (!selectedModel && items[0]) {
        this.updateSetting("model", items[0].id);
      }
    } catch (error) {
      this.modelCache.update((state) => ({
        ...state,
        isLoading: false,
        error: this.toErrorMessage(error),
      }));
    }
  }

  async generateCompletion(promptBaseOverride?: string, htmlBaseOverride?: string): Promise<void> {
    this.flushPendingUserHistory();
    const activeDocument = this.activeDocument();
    const settings = this.settings();

    if (!activeDocument || this.isStreaming()) {
      return;
    }

    if (!settings.apiKey.trim()) {
      this.generation.set({
        ...defaultGeneration(),
        status: "error",
        documentId: activeDocument.id,
        error: "Add an OpenRouter API key before requesting a completion.",
      });
      return;
    }

    if (!settings.model.trim()) {
      this.generation.set({
        ...defaultGeneration(),
        status: "error",
        documentId: activeDocument.id,
        error: "Choose an OpenRouter model before requesting a completion.",
      });
      return;
    }

    const baseContent = htmlBaseOverride ?? activeDocument.content;
    const promptBase = promptBaseOverride?.trim() || markdownToPlainText(baseContent);
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.generation.set({
      status: "streaming",
      documentId: activeDocument.id,
      baseContent,
      promptBase,
      insertedText: "",
      error: null,
    });

    try {
      await this.openRouter.streamCompletion(
        settings,
        promptBase,
        controller.signal,
        {
          onText: (chunk) => this.appendGeneratedText(activeDocument.id, baseContent, chunk),
        },
      );
      this.finishGeneration("idle");
    } catch (error) {
      if (controller.signal.aborted) {
        this.finishGeneration("stopped");
        return;
      }

      this.finishGeneration("error", this.toErrorMessage(error));
    }
  }

  stopGeneration(): void {
    this.activeAbortController?.abort();
  }

  isStreaming(): boolean {
    return this.generation().status === "streaming";
  }

  private appendGeneratedText(documentId: string, baseContent: string, chunk: string): void {
    this.generation.update((state) => ({
      ...state,
      insertedText: `${state.insertedText}${chunk}`,
    }));

    const insertedText = this.generation().insertedText;
    this.updateDocument(documentId, (document) => ({
      ...document,
      content: appendPlainTextToContent(baseContent, insertedText),
      updatedAt: Date.now(),
    }));
  }

  private finishGeneration(
    status: GenerationState["status"],
    errorMessage: string | null = null,
  ): void {
    const state = this.generation();
    const activeDocument = state.documentId
      ? this.documents().find((document) => document.id === state.documentId) ?? null
      : null;

    if (
      activeDocument &&
      state.insertedText &&
      activeDocument.content === appendPlainTextToContent(state.baseContent, state.insertedText)
    ) {
      this.commitHistory(activeDocument.id, {
        before: state.baseContent,
        after: appendPlainTextToContent(state.baseContent, state.insertedText),
        source: "ai",
        timestamp: Date.now(),
        label: status === "error" ? "AI completion (partial)" : "AI completion",
        promptBase: state.promptBase,
      });
    }

    this.activeAbortController = null;
    this.generation.set({
      status,
      documentId: state.documentId,
      baseContent: state.baseContent,
      promptBase: state.promptBase,
      insertedText: state.insertedText,
      error: errorMessage,
    });
  }

  private stageUserHistory(documentId: string, previousContent: string, nextContent: string): void {
    if (previousContent === nextContent) {
      return;
    }

    if (this.pendingUserHistory?.documentId !== documentId) {
      this.flushPendingUserHistory();
      this.pendingUserHistory = {
        documentId,
        before: previousContent,
        after: nextContent,
      };
    } else {
      this.pendingUserHistory = {
        ...this.pendingUserHistory,
        after: nextContent,
      };
    }

    if (this.pendingUserTimer) {
      clearTimeout(this.pendingUserTimer);
    }

    this.pendingUserTimer = window.setTimeout(() => {
      this.flushPendingUserHistory();
    }, USER_HISTORY_DEBOUNCE_MS);
  }

  private flushPendingUserHistory(): void {
    if (this.pendingUserTimer) {
      clearTimeout(this.pendingUserTimer);
      this.pendingUserTimer = null;
    }

    if (!this.pendingUserHistory) {
      return;
    }

    const { documentId, before, after } = this.pendingUserHistory;
    this.pendingUserHistory = null;

    if (before !== after) {
      this.commitHistory(documentId, {
        before,
        after,
        source: "user",
        timestamp: Date.now(),
        label: "Edit",
      });
    }
  }

  private commitHistory(documentId: string, entry: HistoryEntry): void {
    this.updateDocument(documentId, (document) => {
      const previousEntry = document.undoStack.at(-1);
      if (
        previousEntry &&
        previousEntry.before === entry.before &&
        previousEntry.after === entry.after &&
        previousEntry.source === entry.source
      ) {
        return document;
      }

      return {
        ...document,
        undoStack: [...document.undoStack, entry],
        redoStack: [],
      };
    });
  }

  private updateDocument(
    documentId: string,
    updater: (document: DocumentRecord) => DocumentRecord,
  ): void {
    this.documents.update((documents) =>
      documents.map((document) =>
        document.id === documentId ? updater(document) : document,
      ),
    );
  }

  private getDocumentIndex(documentId: string): number {
    const index = this.documents().findIndex((document) => document.id === documentId);
    return index >= 0 ? index + 1 : 1;
  }

  private schedulePersist(payload: PersistedAppState): void {
    this.saveState.set("saving");
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      this.saveTimer = null;
      this.saveState.set("saved");
    }, SAVE_DEBOUNCE_MS);
  }

  private persistNow(): void {
    const payload: PersistedAppState = {
      documents: this.documents(),
      activeDocumentId: this.activeDocumentId(),
      settings: this.settings(),
      modelCache: {
        items: this.modelCache().items,
        fetchedAt: this.modelCache().fetchedAt,
      },
    };

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    this.saveState.set("saved");
  }

  private loadState(): void {
    const rawState = localStorage.getItem(STORAGE_KEY);

    if (!rawState) {
      const initialDocument = createDocument(1);
      this.documents.set([initialDocument]);
      this.activeDocumentId.set(initialDocument.id);
      return;
    }

    try {
      const parsed = JSON.parse(rawState) as Partial<PersistedAppState>;
      const documents = Array.isArray(parsed.documents) && parsed.documents.length > 0
        ? parsed.documents.map((document) => ({
          ...document,
          content: normalizeStoredContent(document.content),
        }))
        : [createDocument(1)];

      this.documents.set(documents);
      this.activeDocumentId.set(parsed.activeDocumentId ?? documents[0]?.id ?? null);
      this.settings.set({
        ...defaultSettings(),
        ...parsed.settings,
      });
      this.modelCache.set({
        items: parsed.modelCache?.items ?? [],
        fetchedAt: parsed.modelCache?.fetchedAt ?? null,
        isLoading: false,
        error: null,
      });
    } catch {
      const initialDocument = createDocument(1);
      this.documents.set([initialDocument]);
      this.activeDocumentId.set(initialDocument.id);
    }
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
}
