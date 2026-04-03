import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import {
  AppMetaState,
  AppSettings,
  DocumentRecord,
  DocumentSummary,
  GenerationState,
  HistoryEntry,
  ModelCacheState,
  StoredDocumentRecord,
} from "./app.types";
import {
  EMPTY_DOCUMENT_MARKDOWN,
  appendPlainTextToContent,
  markdownToPlainText,
  normalizeStoredContent,
  previewTextFromContent,
} from "./content-utils";
import { AppPersistenceService } from "./app.persistence";
import { OpenRouterService } from "./openrouter.service";

type SettingKey = keyof AppSettings;

const USER_HISTORY_DEBOUNCE_MS = 900;
const SAVE_DEBOUNCE_MS = 500;

const defaultSettings = (): AppSettings => ({
  apiKey: "",
  model: "",
  favoriteModelIds: [],
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
  private readonly persistence = inject(AppPersistenceService);
  private metaSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private documentSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPersistOperations = 0;
  private pendingUserHistory:
    | {
        documentId: string;
        before: string;
        after: string;
      }
    | null = null;
  private pendingUserTimer: ReturnType<typeof setTimeout> | null = null;
  private activeAbortController: AbortController | null = null;
  private readonly isHydrated = signal(false);
  private readonly activeDocumentState = signal<DocumentRecord | null>(null);

  readonly documents = signal<DocumentSummary[]>([]);
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

  readonly activeDocument = computed(() => this.activeDocumentState());

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
    effect(() => {
      if (!this.isHydrated()) {
        return;
      }

      this.scheduleMetaPersist(this.createMetaState());
    });

    window.addEventListener("beforeunload", () => {
      this.flushPendingUserHistory();
      void this.persistNow();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.flushPendingUserHistory();
        void this.persistNow();
      }
    });

    void this.initialize();
  }

  createNewDocument(): void {
    this.flushPendingUserHistory();
    const nextDocument = createDocument(this.documents().length + 1);

    this.documents.update((documents) => [this.toSummary(nextDocument), ...documents]);
    this.activeDocumentState.set(nextDocument);
    this.activeDocumentId.set(nextDocument.id);
    this.generation.set(defaultGeneration());
    this.scheduleActiveDocumentPersist();
  }

  async selectDocument(documentId: string): Promise<void> {
    if (this.activeDocumentId() === documentId || this.isStreaming()) {
      return;
    }

    this.flushPendingUserHistory();
    await this.persistNow();

    this.activeDocumentId.set(documentId);
    this.activeDocumentState.set(null);
    this.generation.set(defaultGeneration());

    const documentRecord = await this.persistence.loadDocument(documentId);
    if (!documentRecord) {
      return;
    }

    this.activeDocumentState.set(this.hydrateStoredDocument(documentRecord));
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
    const document = this.activeDocument();
    if (!document || document.id !== documentId) {
      return;
    }

    const trimmed = document.title.trim();
    const nextTitle = trimmed || `Untitled ${this.getDocumentIndex(documentId)}`;
    this.updateDocument(documentId, (currentDocument) => ({
      ...currentDocument,
      title: nextTitle,
      isTitleManual: trimmed.length > 0,
      updatedAt: Date.now(),
    }));
  }

  async deleteDocument(documentId: string): Promise<void> {
    if (this.isStreaming()) {
      return;
    }

    this.flushPendingUserHistory();
    await this.persistNow();

    const currentDocuments = this.documents();
    if (currentDocuments.length === 1) {
      const replacement = createDocument(1);
      this.documents.set([this.toSummary(replacement)]);
      this.activeDocumentState.set(replacement);
      this.activeDocumentId.set(replacement.id);
      this.generation.set(defaultGeneration());

      await this.persistence.deleteDocument(documentId);
      this.scheduleActiveDocumentPersist();
      return;
    }

    const nextDocuments = currentDocuments.filter((document) => document.id !== documentId);
    this.documents.set(nextDocuments);
    await this.persistence.deleteDocument(documentId);

    if (this.activeDocumentId() === documentId) {
      const nextActiveId = nextDocuments[0]?.id ?? null;
      this.activeDocumentId.set(nextActiveId);
      this.generation.set(defaultGeneration());

      if (!nextActiveId) {
        this.activeDocumentState.set(null);
        return;
      }

      const nextActiveDocument = await this.persistence.loadDocument(nextActiveId);
      this.activeDocumentState.set(
        nextActiveDocument ? this.hydrateStoredDocument(nextActiveDocument) : null,
      );
      return;
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
      undoStack: [],
      redoStack: [entry],
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
      undoStack: [entry],
      redoStack: [],
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
      undoStack: [],
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

  toggleFavoriteModel(modelId: string): void {
    const trimmedModelId = modelId.trim();
    if (!trimmedModelId) {
      return;
    }

    this.settings.update((settings) => {
      const favorites = settings.favoriteModelIds.filter((id) => id.trim().length > 0);
      const alreadyFavorite = favorites.includes(trimmedModelId);

      return {
        ...settings,
        favoriteModelIds: alreadyFavorite
          ? favorites.filter((id) => id !== trimmedModelId)
          : [trimmedModelId, ...favorites],
      };
    });
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
    const activeDocument = this.activeDocument();

    if (
      activeDocument &&
      activeDocument.id === state.documentId &&
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
        undoStack: [entry],
        redoStack: [],
      };
    });
  }

  private updateDocument(
    documentId: string,
    updater: (document: DocumentRecord) => DocumentRecord,
  ): void {
    const activeDocument = this.activeDocument();
    if (!activeDocument || activeDocument.id !== documentId) {
      return;
    }

    const nextDocument = updater(activeDocument);
    this.activeDocumentState.set(nextDocument);
    this.updateSummaryFromDocument(nextDocument);
    this.scheduleActiveDocumentPersist();
  }

  private updateSummaryFromDocument(document: DocumentRecord): void {
    const summary = this.toSummary(document);
    this.documents.update((documents) =>
      documents.map((entry) => (entry.id === document.id ? summary : entry)),
    );
  }

  private getDocumentIndex(documentId: string): number {
    const index = this.documents().findIndex((document) => document.id === documentId);
    return index >= 0 ? index + 1 : 1;
  }

  private scheduleMetaPersist(meta: AppMetaState): void {
    this.saveState.set("saving");
    if (this.metaSaveTimer) {
      clearTimeout(this.metaSaveTimer);
    }

    this.metaSaveTimer = window.setTimeout(() => {
      this.runPersistOperation(
        () => this.persistence.saveMeta(meta),
        () => {
          this.metaSaveTimer = null;
        },
      );
    }, SAVE_DEBOUNCE_MS);
  }

  private scheduleActiveDocumentPersist(): void {
    if (!this.isHydrated()) {
      return;
    }

    const activeDocument = this.activeDocument();
    if (!activeDocument) {
      return;
    }

    const storedDocument = this.toStoredDocument(activeDocument);
    this.saveState.set("saving");

    if (this.documentSaveTimer) {
      clearTimeout(this.documentSaveTimer);
    }

    this.documentSaveTimer = window.setTimeout(() => {
      this.runPersistOperation(
        () => this.persistence.saveDocument(storedDocument),
        () => {
          this.documentSaveTimer = null;
        },
      );
    }, SAVE_DEBOUNCE_MS);
  }

  private runPersistOperation(
    operation: () => Promise<void>,
    finalize: () => void,
  ): void {
    this.pendingPersistOperations += 1;

    void operation()
      .catch((error) => {
        console.error("Unable to persist app state.", error);
      })
      .finally(() => {
        this.pendingPersistOperations -= 1;
        finalize();
        this.updateSaveState();
      });
  }

  private updateSaveState(): void {
    if (this.metaSaveTimer || this.documentSaveTimer || this.pendingPersistOperations > 0) {
      this.saveState.set("saving");
      return;
    }

    this.saveState.set("saved");
  }

  private async persistNow(): Promise<void> {
    if (!this.isHydrated()) {
      return;
    }

    if (this.metaSaveTimer) {
      clearTimeout(this.metaSaveTimer);
      this.metaSaveTimer = null;
    }

    if (this.documentSaveTimer) {
      clearTimeout(this.documentSaveTimer);
      this.documentSaveTimer = null;
    }

    this.saveState.set("saving");

    try {
      const activeDocument = this.activeDocument();
      if (activeDocument) {
        await this.persistence.saveDocument(this.toStoredDocument(activeDocument));
      }

      await this.persistence.saveMeta(this.createMetaState());
    } catch (error) {
      console.error("Unable to persist app state.", error);
    } finally {
      this.updateSaveState();
    }
  }

  private async initialize(): Promise<void> {
    const persisted = await this.persistence.load();

    if (!persisted) {
      const initialDocument = createDocument(1);
      this.documents.set([this.toSummary(initialDocument)]);
      this.activeDocumentId.set(initialDocument.id);
      this.activeDocumentState.set(initialDocument);
      this.isHydrated.set(true);
      this.scheduleActiveDocumentPersist();
      return;
    }

    this.documents.set(persisted.summaries);
    this.activeDocumentId.set(persisted.meta.activeDocumentId);
    this.settings.set({
      ...defaultSettings(),
      ...persisted.meta.settings,
    });
    this.modelCache.set({
      items: persisted.meta.modelCache?.items ?? [],
      fetchedAt: persisted.meta.modelCache?.fetchedAt ?? null,
      isLoading: false,
      error: null,
    });

    const activeDocument = persisted.activeDocument
      ?? (persisted.meta.activeDocumentId
        ? await this.persistence.loadDocument(persisted.meta.activeDocumentId)
        : null);

    if (activeDocument) {
      this.activeDocumentState.set(this.hydrateStoredDocument(activeDocument));
    } else if (persisted.summaries[0]) {
      const fallbackDocument = await this.persistence.loadDocument(persisted.summaries[0].id);
      this.activeDocumentId.set(fallbackDocument?.id ?? null);
      this.activeDocumentState.set(
        fallbackDocument ? this.hydrateStoredDocument(fallbackDocument) : null,
      );
    } else {
      const initialDocument = createDocument(1);
      this.documents.set([this.toSummary(initialDocument)]);
      this.activeDocumentId.set(initialDocument.id);
      this.activeDocumentState.set(initialDocument);
      this.isHydrated.set(true);
      this.scheduleActiveDocumentPersist();
      return;
    }

    this.isHydrated.set(true);
  }

  private createMetaState(): AppMetaState {
    return {
      activeDocumentId: this.activeDocumentId(),
      documentOrder: this.documents().map((document) => document.id),
      settings: this.settings(),
      modelCache: {
        items: this.modelCache().items,
        fetchedAt: this.modelCache().fetchedAt,
      },
    };
  }

  private hydrateStoredDocument(document: StoredDocumentRecord): DocumentRecord {
    return {
      id: document.id,
      title: document.title,
      isTitleManual: document.isTitleManual,
      content: normalizeStoredContent(document.content),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      undoStack: [],
      redoStack: [],
    };
  }

  private toStoredDocument(document: DocumentRecord): StoredDocumentRecord {
    return {
      id: document.id,
      title: document.title,
      isTitleManual: document.isTitleManual,
      content: normalizeStoredContent(document.content),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private toSummary(document: Pick<DocumentRecord, "id" | "title" | "isTitleManual" | "content" | "createdAt" | "updatedAt">): DocumentSummary {
    return {
      id: document.id,
      title: document.title,
      isTitleManual: document.isTitleManual,
      preview: previewTextFromContent(document.content),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
}
