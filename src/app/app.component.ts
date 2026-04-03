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
import { ModelOption } from "./app.types";
import { IconComponent } from "./icon/icon.component";
import { RichTextEditorComponent } from "./rich-text-editor/rich-text-editor.component";

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
  readonly documentCount = computed(() => this.store.documents().length);
  readonly modelQuery = signal("");
  readonly modelPickerFocused = signal(false);
  readonly selectedModelValues = signal<string[]>([]);
  readonly modelFavoriteSnapshotIds = signal<string[] | null>(null);
  readonly modelOtherSnapshotIds = signal<string[] | null>(null);
  readonly favoriteModelIds = computed(() => this.settings().favoriteModelIds);
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
  readonly popupFavoriteModels = computed(() =>
    this.resolveModelsFromSnapshot(
      this.modelFavoriteSnapshotIds(),
      (model) => this.favoriteModelIds().includes(model.id),
    ),
  );
  readonly popupOtherModels = computed(() =>
    this.resolveModelsFromSnapshot(
      this.modelOtherSnapshotIds(),
      (model) => !this.favoriteModelIds().includes(model.id),
    ),
  );
  readonly filteredFavoriteModels = computed(() =>
    this.popupFavoriteModels().filter((model) => this.matchesModelQuery(model, this.modelQuery())),
  );
  readonly filteredOtherModels = computed(() =>
    this.popupOtherModels().filter((model) => this.matchesModelQuery(model, this.modelQuery())),
  );
  readonly firstMatchingModelId = computed(() =>
    this.filteredFavoriteModels()[0]?.id ?? this.filteredOtherModels()[0]?.id,
  );
  readonly hasModelMatches = computed(() =>
    this.filteredFavoriteModels().length + this.filteredOtherModels().length > 0,
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

    afterNextRender(() => {
      window.setTimeout(() => {
        void this.store.refreshModels();
      }, 0);
    });
  }

  onEditorChange(content: string): void {
    this.store.updateActiveDocumentContent(content);
  }

  onModelQueryFocus(): void {
    this.modelPickerFocused.set(true);
  }

  onModelQueryBlur(): void {
    this.modelPickerFocused.set(false);

    if (!(this.modelCombobox()?.expanded() ?? false)) {
      this.modelQuery.set(this.selectedModelLabel());
    }
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
    this.modelQuery.set(this.labelForModelId(selectedId));
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

  async requestCompletion(): Promise<void> {
    await this.store.generateCompletion(this.richEditor?.getPlainText() ?? "");
  }

  async regenerateLastAi(): Promise<void> {
    await this.store.regenerateLastAi();
  }

  async refreshModels(): Promise<void> {
    await this.store.refreshModels();
  }

  private captureModelSnapshots(): void {
    const favorites = new Set(this.favoriteModelIds());
    const favoriteIds: string[] = [];
    const otherIds: string[] = [];

    for (const model of this.modelCache().items) {
      if (favorites.has(model.id)) {
        favoriteIds.push(model.id);
      } else {
        otherIds.push(model.id);
      }
    }

    this.modelFavoriteSnapshotIds.set(favoriteIds);
    this.modelOtherSnapshotIds.set(otherIds);
  }

  private clearModelSnapshots(): void {
    this.modelFavoriteSnapshotIds.set(null);
    this.modelOtherSnapshotIds.set(null);
  }

  private matchesModelQuery(model: ModelOption, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return true;
    }

    return model.name.toLowerCase().includes(normalizedQuery)
      || model.id.toLowerCase().includes(normalizedQuery);
  }

  private resolveModelsFromSnapshot(
    snapshotIds: string[] | null,
    fallbackFilter: (model: ModelOption) => boolean,
  ): ModelOption[] {
    const items = this.modelCache().items;

    if (!snapshotIds) {
      return items.filter(fallbackFilter);
    }

    const itemById = new Map(items.map((model) => [model.id, model]));
    return snapshotIds
      .map((id) => itemById.get(id) ?? null)
      .filter((model): model is ModelOption => model !== null);
  }
}
