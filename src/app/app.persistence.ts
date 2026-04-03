import { Injectable } from "@angular/core";
import { previewTextFromContent } from "./content-utils";
import {
  AppMetaState,
  AppSettings,
  DocumentSummary,
  LegacyLocalStorageState,
  PersistedAppState,
  PersistedBootstrapState,
  StoredDocumentRecord,
} from "./app.types";
import { LEGACY_STORAGE_KEY } from "./storage.constants";

const DATABASE_NAME = "aitext";
const DATABASE_VERSION = 2;
const META_STORE = "appMeta";
const SUMMARY_STORE = "documentSummaries";
const DOCUMENT_STORE = "documents";
const LEGACY_SINGLE_STORE = "appState";
const META_KEY = "current";
const LEGACY_RECORD_KEY = "current";

// Migration contract:
// - Legacy localStorage data lives under localStorage["aitext.state.v1"] as one
//   JSON blob containing the full app state, including undo/redo history.
// - IndexedDB schema v1 also stored one record in the "appState" object store.
// - Future schema changes must continue to recognize both legacy formats so old
//   installs can still migrate forward safely.

@Injectable({ providedIn: "root" })
export class AppPersistenceService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private writeQueue = Promise.resolve();

  async load(): Promise<PersistedBootstrapState | null> {
    const database = await this.openDatabase();
    if (!database) {
      return null;
    }

    const normalized = await this.readNormalizedState(database);
    if (normalized) {
      return normalized;
    }

    const migratedIndexedDb = await this.migrateLegacyIndexedDbState(database);
    if (migratedIndexedDb) {
      return migratedIndexedDb;
    }

    const migratedLocalStorage = await this.migrateLegacyLocalStorageState(database);
    if (migratedLocalStorage) {
      return migratedLocalStorage;
    }

    return null;
  }

  async saveMeta(meta: AppMetaState): Promise<void> {
    return this.enqueueWrite(async (database) => {
      await this.putValue(database, META_STORE, meta, META_KEY);
    });
  }

  async saveDocument(document: StoredDocumentRecord): Promise<void> {
    return this.enqueueWrite(async (database) => {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
          [DOCUMENT_STORE, SUMMARY_STORE],
          "readwrite",
        );
        transaction.objectStore(DOCUMENT_STORE).put(document);
        transaction.objectStore(SUMMARY_STORE).put(this.toSummary(document));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    });
  }

  async loadDocument(documentId: string): Promise<StoredDocumentRecord | null> {
    const database = await this.openDatabase();
    if (!database) {
      return null;
    }

    try {
      return await this.getValue<StoredDocumentRecord>(database, DOCUMENT_STORE, documentId);
    } catch (error) {
      console.error("Unable to load document from IndexedDB.", error);
      return null;
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    return this.enqueueWrite(async (database) => {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
          [DOCUMENT_STORE, SUMMARY_STORE],
          "readwrite",
        );
        transaction.objectStore(DOCUMENT_STORE).delete(documentId);
        transaction.objectStore(SUMMARY_STORE).delete(documentId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    });
  }

  private async enqueueWrite(
    operation: (database: IDBDatabase) => Promise<void>,
  ): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const database = await this.openDatabase();
        if (!database) {
          throw new Error("IndexedDB is unavailable.");
        }

        await operation(database);
      });

    return this.writeQueue;
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    if (typeof indexedDB === "undefined") {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE);
        }

        if (!database.objectStoreNames.contains(SUMMARY_STORE)) {
          database.createObjectStore(SUMMARY_STORE, { keyPath: "id" });
        }

        if (!database.objectStoreNames.contains(DOCUMENT_STORE)) {
          database.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.error("Unable to open IndexedDB.", request.error);
        resolve(null);
      };
    });

    return this.dbPromise;
  }

  private async readNormalizedState(database: IDBDatabase): Promise<PersistedBootstrapState | null> {
    try {
      const [meta, allSummaries] = await Promise.all([
        this.getValue<AppMetaState>(database, META_STORE, META_KEY),
        this.getAllValues<DocumentSummary>(database, SUMMARY_STORE),
      ]);

      if (!meta) {
        return null;
      }

      const summaries = this.orderSummaries(allSummaries, meta.documentOrder);
      const activeDocument = meta.activeDocumentId
        ? await this.getValue<StoredDocumentRecord>(database, DOCUMENT_STORE, meta.activeDocumentId)
        : null;

      return {
        meta,
        summaries,
        activeDocument,
      };
    } catch (error) {
      console.error("Unable to read normalized IndexedDB state.", error);
      return null;
    }
  }

  private async migrateLegacyIndexedDbState(
    database: IDBDatabase,
  ): Promise<PersistedBootstrapState | null> {
    if (!database.objectStoreNames.contains(LEGACY_SINGLE_STORE)) {
      return null;
    }

    try {
      const legacyState = await this.getValue<PersistedAppState>(
        database,
        LEGACY_SINGLE_STORE,
        LEGACY_RECORD_KEY,
      );

      if (!legacyState) {
        return null;
      }

      const normalized = this.normalizeSingleRecordState(legacyState);
      await this.writeNormalizedState(database, normalized);
      return this.createBootstrapState(normalized);
    } catch (error) {
      console.error("Unable to migrate legacy IndexedDB state.", error);
      return null;
    }
  }

  private async migrateLegacyLocalStorageState(
    database: IDBDatabase,
  ): Promise<PersistedBootstrapState | null> {
    const legacyState = this.readLegacyLocalStorageState();
    if (!legacyState) {
      return null;
    }

    try {
      const normalized = this.normalizeLegacyLocalStorageState(legacyState);
      await this.writeNormalizedState(database, normalized);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return this.createBootstrapState(normalized);
    } catch (error) {
      console.error("Unable to migrate localStorage state into IndexedDB.", error);
      return null;
    }
  }

  private readLegacyLocalStorageState(): LegacyLocalStorageState | null {
    const rawState = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!rawState) {
      return null;
    }

    try {
      return JSON.parse(rawState) as LegacyLocalStorageState;
    } catch (error) {
      console.error("Unable to parse legacy localStorage state.", error);
      return null;
    }
  }

  private normalizeLegacyLocalStorageState(
    legacyState: LegacyLocalStorageState,
  ): NormalizedState {
    const documents = Array.isArray(legacyState.documents)
      ? legacyState.documents.map((document) => ({
        id: document.id,
        title: document.title,
        isTitleManual: document.isTitleManual,
        content: document.content,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      }))
      : [];

    return this.createNormalizedState(
      documents,
      legacyState.activeDocumentId ?? null,
      this.normalizeSettings(legacyState.settings),
      legacyState.modelCache,
    );
  }

  private normalizeSingleRecordState(legacyState: PersistedAppState): NormalizedState {
    return this.createNormalizedState(
      legacyState.documents,
      legacyState.activeDocumentId ?? null,
      this.normalizeSettings(legacyState.settings),
      legacyState.modelCache,
    );
  }

  private createNormalizedState(
    documents: StoredDocumentRecord[],
    activeDocumentId: string | null,
    settings: AppMetaState["settings"],
    modelCache: AppMetaState["modelCache"],
  ): NormalizedState {
    const normalizedDocuments = Array.isArray(documents) ? documents : [];
    const documentOrder = normalizedDocuments.map((document) => document.id);
    const safeActiveDocumentId = documentOrder.includes(activeDocumentId ?? "")
      ? activeDocumentId
      : documentOrder[0] ?? null;

    return {
      meta: {
        activeDocumentId: safeActiveDocumentId,
        documentOrder,
        settings,
        modelCache,
      },
      documentsById: new Map(normalizedDocuments.map((document) => [document.id, document])),
      summaries: normalizedDocuments.map((document) => this.toSummary(document)),
    };
  }

  private normalizeSettings(settings: Partial<AppSettings>): AppSettings {
    return {
      apiKey: settings.apiKey ?? "",
      model: settings.model ?? "",
      favoriteModelIds: Array.isArray(settings.favoriteModelIds)
        ? settings.favoriteModelIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [],
      maxTokens: settings.maxTokens ?? 256,
      temperature: settings.temperature ?? 0.9,
      topP: settings.topP ?? 1,
      systemPrompt: settings.systemPrompt ?? "",
    };
  }

  private createBootstrapState(normalized: NormalizedState): PersistedBootstrapState {
    const summaries = this.orderSummaries(normalized.summaries, normalized.meta.documentOrder);
    const activeDocument = normalized.meta.activeDocumentId
      ? normalized.documentsById.get(normalized.meta.activeDocumentId) ?? null
      : null;

    return {
      meta: normalized.meta,
      summaries,
      activeDocument,
    };
  }

  private async writeNormalizedState(
    database: IDBDatabase,
    normalized: NormalizedState,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [META_STORE, SUMMARY_STORE, DOCUMENT_STORE],
        "readwrite",
      );
      const metaStore = transaction.objectStore(META_STORE);
      const summaryStore = transaction.objectStore(SUMMARY_STORE);
      const documentStore = transaction.objectStore(DOCUMENT_STORE);

      metaStore.put(normalized.meta, META_KEY);
      summaryStore.clear();
      documentStore.clear();

      for (const summary of normalized.summaries) {
        summaryStore.put(summary);
      }

      for (const document of normalized.documentsById.values()) {
        documentStore.put(document);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private orderSummaries(
    summaries: DocumentSummary[],
    documentOrder: string[],
  ): DocumentSummary[] {
    const orderLookup = new Map(documentOrder.map((id, index) => [id, index]));

    return [...summaries].sort((left, right) => {
      const leftIndex = orderLookup.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = orderLookup.get(right.id) ?? Number.MAX_SAFE_INTEGER;

      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return right.updatedAt - left.updatedAt;
    });
  }

  private toSummary(document: StoredDocumentRecord): DocumentSummary {
    return {
      id: document.id,
      title: document.title,
      isTitleManual: document.isTitleManual,
      preview: previewTextFromContent(document.content),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private getValue<T>(
    database: IDBDatabase,
    storeName: string,
    key: IDBValidKey,
  ): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  private getAllValues<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result as T[] | undefined) ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  private putValue(
    database: IDBDatabase,
    storeName: string,
    value: unknown,
    key?: IDBValidKey,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);

      if (key === undefined) {
        store.put(value);
      } else {
        store.put(value, key);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

interface NormalizedState {
  meta: AppMetaState;
  summaries: DocumentSummary[];
  documentsById: Map<string, StoredDocumentRecord>;
}
