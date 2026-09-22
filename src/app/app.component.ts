import { CommonModule } from "@angular/common";
import {
  afterNextRender,
  Component,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Combobox, ComboboxInput, ComboboxPopupContainer } from "@angular/aria/combobox";
import { Listbox, Option } from "@angular/aria/listbox";
import { AppStore } from "./app.store";
import { appendPlainTextToContent, markdownToPlainText } from "./content-utils";
import { AppSettings, ModelOption } from "./app.types";
import { IconComponent } from "./icon/icon.component";
import { RichTextEditorComponent } from "./rich-text-editor/rich-text-editor.component";
import { readOpenAiStreamEvent, splitSseEvents } from "./coauthor-stream";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

type CoauthorAction = "continue" | "rewrite" | "discuss";

interface CoauthorProposal {
  id: string;
  action: CoauthorAction;
  documentId: string;
  revision: number;
  status: "streaming" | "complete" | "error" | "cancelled";
  from: number | null;
  to: number | null;
  original: string;
  content: string;
  sourceContent: string;
  instruction: string;
}

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    Combobox,
    ComboboxInput,
    ComboboxPopupContainer,
    Listbox,
    Option,
    IconComponent,
    RichTextEditorComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  @ViewChild("richEditor")
  private readonly richEditor?: RichTextEditorComponent;

  private readonly modelCombobox = viewChild<Combobox<string>>(Combobox);
  private readonly modelInput = viewChild<ComboboxInput>(ComboboxInput);
  private lastModelPickerExpanded = false;

  readonly store = inject(AppStore);
  readonly activeDocument = this.store.activeDocument;
  readonly generation = this.store.generation;
  readonly settings = this.store.settings;
  readonly modelCache = this.store.modelCache;
  readonly documentCount = computed(() => this.store.visibleDocuments().length);
  readonly folders = this.store.folders;
  readonly activeFolder = this.store.activeFolder;
  readonly modelQuery = signal("");
  readonly modelPickerFocused = signal(false);
  readonly selectedModelValues = signal<string[]>([]);
  readonly modelSnapshotIds = signal<string[] | null>(null);
  readonly selectedSystemPromptName = signal("");
  readonly chatOpen = signal(false);
  readonly chatMessages = signal<ChatMessage[]>([]);
  readonly chatStreaming = signal(false);
  readonly chatError = signal("");
  readonly coauthorProposal = signal<CoauthorProposal | null>(null);
  readonly chatPosition = signal({ x: 24, y: 24 });
  readonly favoriteModelIds = computed(() => this.settings().favoriteModelIds);
  chatInput = "";
  private chatAbortController: AbortController | null = null;
  private chatDragOffset: { x: number; y: number } | null = null;
  private documentRevision = 0;
  private lastDocumentRevisionKey = "";
  readonly selectedModel = computed(() =>
    this.modelCache().items.find((model) => model.id === this.settings().model) ?? null,
  );
  readonly selectedModelLabel = computed(() => {
    const selectedModel = this.selectedModel();
    const selectedId = this.settings().model.trim();

    if (selectedModel) {
      return this.modelLabel(selectedModel);
    }

    return selectedId ? selectedId : "";
  });
  readonly modelInputValue = computed(() => {
    const expanded = this.modelCombobox()?.expanded() ?? false;
    return this.modelPickerFocused() || expanded
      ? this.modelQuery()
      : this.selectedModelLabel();
  });
  readonly popupFavoriteModels = computed(() => {
    const itemById = new Map(this.modelCache().items.map((model) => [model.id, model]));
    return this.favoriteModelIds()
      .map((id) => itemById.get(id) ?? null)
      .filter((model): model is ModelOption => model !== null);
  });
  readonly popupAllModels = computed(() =>
    this.resolveModelsFromSnapshot(this.modelSnapshotIds()),
  );
  readonly filteredFavoriteModels = computed(() =>
    this.popupFavoriteModels().filter((model) => this.matchesModelQuery(model, this.modelQuery())),
  );
  readonly filteredAllModels = computed(() =>
    this.popupAllModels().filter((model) => this.matchesModelQuery(model, this.modelQuery())),
  );
  readonly firstMatchingModelId = computed(() =>
    this.filteredFavoriteModels()[0]?.id ?? this.filteredAllModels()[0]?.id,
  );
  readonly hasModelMatches = computed(() =>
    this.filteredFavoriteModels().length + this.filteredAllModels().length > 0,
  );

  constructor() {
    effect(() => {
      const selectedId = this.settings().model.trim();
      this.selectedModelValues.set(selectedId ? [selectedId] : []);

      if (!this.modelPickerFocused()) {
        this.modelQuery.set(this.selectedModelLabel());
      }
    });

    effect(() => {
      const expanded = this.modelCombobox()?.expanded() ?? false;

      if (expanded && !this.lastModelPickerExpanded) {
        this.captureModelSnapshots();
      } else if (!expanded && this.lastModelPickerExpanded) {
        this.clearModelSnapshots();
      }

      this.lastModelPickerExpanded = expanded;
    });

    effect(() => {
      const expanded = this.modelCombobox()?.expanded() ?? false;

      if (!expanded) {
        return;
      }

      this.modelCache().items;
      this.captureModelSnapshots();
    });

    effect(() => {
      const document = this.activeDocument();
      const key = document ? `${document.id}:${document.content}` : "";
      if (key !== this.lastDocumentRevisionKey) {
        this.lastDocumentRevisionKey = key;
        this.documentRevision += 1;
        if (this.chatStreaming()) this.stopChat();
        this.coauthorProposal.update((proposal) => proposal && proposal.documentId !== document?.id ? null : proposal);
      }
    });

    afterNextRender(() => {
      window.setTimeout(() => {
        void this.store.refreshModels();
      }, 0);
    });
  }

  onEditorChange(content: string): void {
    this.store.updateActiveDocumentContent(content);
  }

  createFolder(): void {
    const folder = window.prompt("Folder name")?.trim();
    if (folder) {
      this.store.createFolder(folder);
      this.store.createNewDocument();
    }
  }

  onModelQueryFocus(): void {
    this.modelPickerFocused.set(true);
  }

  onModelQueryBlur(): void {
    this.modelPickerFocused.set(false);
  }

  onModelSelectionChange(modelIds: string[]): void {
    const selectedId = modelIds.at(-1)?.trim() ?? "";
    if (!selectedId) {
      this.selectedModelValues.set([]);
      return;
    }

    this.store.updateSetting("model", selectedId);
    this.selectedModelValues.set([selectedId]);
    this.modelPickerFocused.set(false);
    this.modelQuery.set("");
    this.modelCombobox()?.close();
  }

  openModelPicker(event: Event): void {
    this.preventModelOptionDefault(event);
    this.modelPickerFocused.set(true);
    this.modelQuery.set("");
    this.modelCombobox()?.open();
    queueMicrotask(() => {
      this.modelInput()?.element.focus();
    });
  }

  toggleFavoriteModel(modelId: string, event: Event): void {
    this.preventModelOptionDefault(event);
    this.store.toggleFavoriteModel(modelId);
  }

  preventModelOptionDefault(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
  }

  isFavoriteModel(modelId: string): boolean {
    return this.favoriteModelIds().includes(modelId);
  }

  modelLabel(model: ModelOption): string {
    return `${model.name} (${model.id})`;
  }

  labelForModelId(modelId: string): string {
    const model = this.modelCache().items.find((entry) => entry.id === modelId);
    return model ? this.modelLabel(model) : modelId;
  }

  updateNumberSetting(
    key: "maxTokens" | "temperature" | "topP",
    value: string,
  ): void {
    this.store.updateSetting(key, Number(value));
  }

  applySystemPrompt(name: string): void {
    this.selectedSystemPromptName.set(name);
    this.store.applySystemPrompt(name);
  }

  saveSystemPrompt(): void {
    const defaultName = this.selectedSystemPromptName() || `Prompt ${this.settings().savedSystemPrompts.length + 1}`;
    const name = window.prompt("Save system prompt as", defaultName)?.trim();
    if (name) {
      this.store.saveSystemPrompt(name);
      this.selectedSystemPromptName.set(name);
    }
  }

  deleteSelectedSystemPrompt(): void {
    const name = this.selectedSystemPromptName();
    if (name && window.confirm(`Delete system prompt \"${name}\"?`)) {
      this.store.deleteSystemPrompt(name);
      this.selectedSystemPromptName.set("");
    }
  }

  async requestCompletion(): Promise<void> {
    await this.store.generateCompletion(this.richEditor?.getPlainText() ?? "");
  }

  async regenerateLastAi(): Promise<void> {
    await this.store.regenerateLastAi();
  }

  async refreshModels(): Promise<void> {
    await this.store.refreshModels();
  }

  openChat(): void {
    this.chatOpen.set(true);
  }

  minimizeChat(): void {
    this.chatOpen.set(false);
  }

  stopChat(): void {
    this.chatAbortController?.abort();
    this.store.cancelModelRefresh();
    this.chatAbortController = null;
    this.chatStreaming.set(false);
    this.coauthorProposal.update((proposal) => proposal?.status === "streaming" ? { ...proposal, status: "cancelled" } : proposal);
  }

  async askCoauthor(action: CoauthorAction): Promise<void> {
    const document = this.activeDocument();
    let settings = this.settings();
    if (!document || this.chatStreaming()) return;

    const selection = action === "continue" ? null : this.richEditor?.getSelectedMarkdown();
    if ((action === "rewrite" || action === "discuss") && !selection?.text) {
      this.chatError.set("Select a passage first.");
      return;
    }

    if (settings.provider === "openrouter" && !settings.apiKey.trim()) {
      this.chatError.set("Add an OpenRouter API key first.");
      return;
    }

    const id = crypto.randomUUID?.() ?? String(Date.now());
    const controller = new AbortController();
    const revision = this.documentRevision;
    const instruction = this.chatInput.trim();
    this.chatAbortController = controller;
    this.chatStreaming.set(true);
    this.chatError.set("");

    try {
      if (settings.provider === "aiServer") {
        await this.store.refreshModels(controller.signal);
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        settings = this.settings();
      }

      if (!settings.model.trim()) throw new Error("Choose a model first.");
      if (this.chatAbortController !== controller || this.activeDocument()?.id !== document.id || this.activeDocument()?.content !== document.content) {
        throw new DOMException("Cancelled", "AbortError");
      }

      this.chatInput = "";
      this.coauthorProposal.set({
        id,
        action,
        documentId: document.id,
        revision,
        status: "streaming",
        from: selection?.from ?? null,
        to: selection?.to ?? null,
        original: selection?.text ?? "",
        content: "",
        sourceContent: document.content,
        instruction,
      });

      await this.streamCoauthor(settings, markdownToPlainText(document.content), action, selection?.text ?? "", instruction, "", id, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      this.coauthorProposal.update((proposal) => proposal?.id === id ? { ...proposal, status: "complete" } : proposal);
    } catch (error) {
      if (this.isAbortError(error, controller)) {
        this.coauthorProposal.update((proposal) => proposal?.id === id ? { ...proposal, status: "cancelled" } : proposal);
      } else if (this.chatAbortController === controller) {
        this.chatError.set(error instanceof Error ? error.message : String(error));
        this.coauthorProposal.update((proposal) => proposal?.id === id ? { ...proposal, status: "error" } : proposal);
      }
    } finally {
      if (this.chatAbortController === controller) {
        this.chatStreaming.set(false);
        this.chatAbortController = null;
      }
    }
  }

  applyCoauthorProposal(): void {
    const proposal = this.coauthorProposal();
    const document = this.activeDocument();
    if (!proposal || !document || document.id !== proposal.documentId || this.store.isStreaming() || this.chatStreaming() || proposal.status !== "complete") return;
    if (proposal.revision !== this.documentRevision || proposal.sourceContent !== document.content) {
      this.chatError.set("The manuscript changed since this draft was made. Start a new coauthor request.");
      return;
    }

    const applied = proposal.action === "rewrite" && proposal.from !== null && proposal.to !== null
      ? this.richEditor?.replaceRangeWithMarkdown(proposal.from, proposal.to, proposal.content)
      : proposal.action === "continue"
        ? this.richEditor?.insertMarkdownAtEnd(proposal.content)
        : false;

    if (applied) this.coauthorProposal.set(null);
  }

  async reviseCoauthorProposal(): Promise<void> {
    const proposal = this.coauthorProposal();
    const document = this.activeDocument();
    let settings = this.settings();
    if (!proposal || !document || document.id !== proposal.documentId || this.chatStreaming()) return;
    if (proposal.revision !== this.documentRevision || proposal.sourceContent !== document.content) {
      this.chatError.set("The manuscript changed since this draft was made. Start a new coauthor request.");
      return;
    }

    const note = this.chatInput.trim();
    const instruction = [proposal.instruction, note].filter(Boolean).join("\n\nRevision note: ");
    const previousDraft = proposal.content;
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const controller = new AbortController();
    this.chatAbortController = controller;
    this.chatInput = "";
    this.chatError.set("");
    this.chatStreaming.set(true);

    try {
      if (settings.provider === "aiServer") {
        await this.store.refreshModels(controller.signal);
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        settings = this.settings();
      }

      if (!settings.model.trim()) throw new Error("Choose a model first.");
      const current = this.coauthorProposal();
      const activeDocument = this.activeDocument();
      if (this.chatAbortController !== controller || current?.id !== proposal.id || activeDocument?.id !== document.id || activeDocument.content !== document.content) {
        throw new DOMException("Cancelled", "AbortError");
      }

      this.coauthorProposal.set({ ...proposal, id, status: "streaming", content: "", instruction });
      await this.streamCoauthor(settings, markdownToPlainText(document.content), proposal.action, proposal.original, instruction, previousDraft, id, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      this.coauthorProposal.update((current) => current?.id === id ? { ...current, status: "complete" } : current);
    } catch (error) {
      if (this.isAbortError(error, controller)) {
        this.coauthorProposal.update((current) => current?.id === id ? { ...current, status: "cancelled" } : current);
      } else if (this.chatAbortController === controller) {
        this.chatError.set(error instanceof Error ? error.message : String(error));
        this.coauthorProposal.update((current) => current?.id === id ? { ...current, status: "error" } : current);
      }
    } finally {
      if (this.chatAbortController === controller) {
        this.chatStreaming.set(false);
        this.chatAbortController = null;
      }
    }
  }

  discardCoauthorProposal(): void {
    this.coauthorProposal.set(null);
  }

  insertChatMessage(content: string): void {
    const document = this.activeDocument();
    if (!document || !content.trim()) return;
    this.store.updateActiveDocumentContent(appendPlainTextToContent(`${document.content}\n\n`, content.trim()));
  }

  handleChatKey(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.shiftKey || keyboardEvent.isComposing) return;
    event.preventDefault();
    const proposal = this.coauthorProposal();
    void (proposal ? this.reviseCoauthorProposal() : this.askCoauthor("continue"));
  }

  async sendChat(): Promise<void> {
    const question = this.chatInput.trim();
    const document = this.activeDocument();
    let settings = this.settings();
    if (!question || !document || this.chatStreaming()) return;

    this.chatStreaming.set(true);

    if (settings.provider === "openrouter" && !settings.apiKey.trim()) {
      this.chatError.set("Add an OpenRouter API key before chatting.");
      this.chatStreaming.set(false);
      return;
    }

    if (settings.provider === "aiServer") {
      await this.store.refreshModels();
      settings = this.settings();
    }

    if (!settings.model.trim()) {
      this.chatError.set("Choose a model before chatting.");
      this.chatStreaming.set(false);
      return;
    }

    const prior = this.chatMessages();
    const assistantId = crypto.randomUUID?.() ?? String(Date.now());
    this.chatInput = "";
    this.chatError.set("");
    this.chatMessages.set([
      ...prior,
      { id: crypto.randomUUID?.() ?? `${assistantId}-user`, role: "user", content: question },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    const controller = new AbortController();
    this.chatAbortController = controller;

    try {
      await this.streamChat(settings, markdownToPlainText(document.content), question, prior, assistantId, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.chatError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.chatStreaming.set(false);
      this.chatAbortController = null;
    }
  }

  startChatDrag(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    const pos = this.chatPosition();
    this.chatDragOffset = { x: event.clientX - pos.x, y: event.clientY - pos.y };
    window.addEventListener("pointermove", this.moveChat);
    window.addEventListener("pointerup", this.endChatDrag, { once: true });
    window.addEventListener("pointercancel", this.endChatDrag, { once: true });
  }

  private readonly moveChat = (event: PointerEvent): void => {
    if (!this.chatDragOffset) return;
    this.chatPosition.set({
      x: Math.max(8, Math.min(window.innerWidth - 380, event.clientX - this.chatDragOffset.x)),
      y: Math.max(8, Math.min(window.innerHeight - 520, event.clientY - this.chatDragOffset.y)),
    });
  };

  private readonly endChatDrag = (): void => {
    this.chatDragOffset = null;
    window.removeEventListener("pointermove", this.moveChat);
    window.removeEventListener("pointercancel", this.endChatDrag);
  };

  private async streamCoauthor(
    settings: AppSettings,
    documentText: string,
    action: CoauthorAction,
    selectedText: string,
    instruction: string,
    previousDraft: string,
    proposalId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const baseUrl = (settings.provider === "aiServer" ? settings.aiServerUrl : "https://openrouter.ai/api/v1").trim().replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.provider === "openrouter" && settings.apiKey.trim()) headers["Authorization"] = `Bearer ${settings.apiKey.trim()}`;
    if (settings.provider === "openrouter") {
      headers["HTTP-Referer"] = window.location.origin;
      headers["X-Title"] = "AIText";
    }

    const task = action === "continue"
      ? "Write the next passage of the story. Return only manuscript prose."
      : action === "rewrite"
        ? "Rewrite only the selected passage. Return only the replacement prose, no notes."
        : "Discuss the selected passage like a coauthor. Give concrete options, but do not write replacement prose unless asked.";

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        top_p: settings.topP,
        stream: true,
        messages: [
          { role: "system", content: "You are a coauthor inside AIText. Collaborate like a writing partner: preserve the author's intent, match the manuscript style, and keep outputs directly usable." },
          { role: "user", content: `Current manuscript:\n${this.chatDocumentContext(documentText, settings, instruction, [])}` },
          ...(selectedText ? [{ role: "user", content: `Selected passage:\n${selectedText}` }] : []),
          ...(previousDraft ? [{ role: "user", content: `Previous draft to revise:\n${previousDraft}` }] : []),
          { role: "user", content: [task, previousDraft ? "Revise the previous draft using the author note." : "", instruction ? `Author note: ${instruction}` : ""].filter(Boolean).join("\n") },
        ],
        ...(settings.provider === "aiServer" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });

    if (!response.ok) throw new Error(await response.text() || `Coauthor failed (${response.status}).`);
    if (!response.body) throw new Error("Coauthor response was empty.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseEvents(buffer);
      buffer = split.rest;
      for (const part of split.events) complete = this.readCoauthorEvent(part, proposalId) || complete;
    }
    buffer += decoder.decode();
    if (buffer.trim()) complete = this.readCoauthorEvent(buffer, proposalId) || complete;
    if (!complete) throw new Error("Coauthor stream ended before completion.");
  }

  private async streamChat(
    settings: AppSettings,
    documentText: string,
    question: string,
    prior: ChatMessage[],
    assistantId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const baseUrl = (settings.provider === "aiServer" ? settings.aiServerUrl : "https://openrouter.ai/api/v1").trim().replace(/\/$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.provider === "openrouter" && settings.apiKey.trim()) headers["Authorization"] = `Bearer ${settings.apiKey.trim()}`;
    if (settings.provider === "openrouter") {
      headers["HTTP-Referer"] = window.location.origin;
      headers["X-Title"] = "AIText";
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: settings.model,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        top_p: settings.topP,
        stream: true,
        messages: [
          { role: "system", content: "You are a concise writing assistant inside AIText. Answer the user's question using the current document when relevant. Do not continue the story unless asked." },
          { role: "user", content: `Current document:\n${this.chatDocumentContext(documentText, settings, question, prior)}` },
          ...prior.slice(-8).map((message) => ({ role: message.role, content: message.content })),
          { role: "user", content: question },
        ],
        ...(settings.provider === "aiServer" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });

    if (!response.ok) throw new Error(await response.text() || `Chat failed (${response.status}).`);
    if (!response.body) throw new Error("Chat response was empty.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseEvents(buffer);
      buffer = split.rest;
      for (const part of split.events) complete = this.readChatEvent(part, assistantId) || complete;
    }
    buffer += decoder.decode();
    if (buffer.trim()) complete = this.readChatEvent(buffer, assistantId) || complete;
    if (!complete) throw new Error("Chat stream ended before completion.");
  }

  private chatDocumentContext(documentText: string, settings: AppSettings, question: string, prior: ChatMessage[]): string {
    const contextLength = this.modelCache().items.find((model) => model.id === settings.model)?.contextLength ?? 100000;
    const historyText = prior.slice(-8).map((message) => message.content).join("\n");
    const overheadTokens = Math.ceil((question.length + historyText.length) / 4) + settings.maxTokens + 2048;
    const maxChars = Math.max(0, (contextLength - overheadTokens) * 4);
    return documentText.length > maxChars ? documentText.slice(-maxChars) : documentText;
  }

  private isAbortError(error: unknown, controller: AbortController): boolean {
    return controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
  }

  private readCoauthorEvent(part: string, proposalId: string): boolean {
    const event = readOpenAiStreamEvent(part);
    if (event.content) this.coauthorProposal.update((proposal) => proposal?.id === proposalId && proposal.status === "streaming" ? { ...proposal, content: proposal.content + event.content } : proposal);
    return event.complete;
  }

  private readChatEvent(part: string, assistantId: string): boolean {
    const event = readOpenAiStreamEvent(part);
    if (event.content) this.chatMessages.update((messages) => messages.map((message) => message.id === assistantId ? { ...message, content: message.content + event.content } : message));
    return event.complete;
  }

  private captureModelSnapshots(): void {
    this.modelSnapshotIds.set(this.modelCache().items.map((model) => model.id));
  }

  private clearModelSnapshots(): void {
    this.modelSnapshotIds.set(null);
  }

  private matchesModelQuery(model: ModelOption, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return true;
    }

    return model.name.toLowerCase().includes(normalizedQuery)
      || model.id.toLowerCase().includes(normalizedQuery);
  }

  private resolveModelsFromSnapshot(snapshotIds: string[] | null): ModelOption[] {
    const items = this.modelCache().items;

    if (!snapshotIds) {
      return items;
    }

    const itemById = new Map(items.map((model) => [model.id, model]));
    return snapshotIds
      .map((id) => itemById.get(id) ?? null)
      .filter((model): model is ModelOption => model !== null);
  }
}
