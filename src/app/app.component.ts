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

  readonly store = inject(AppStore);
  readonly activeDocument = this.store.activeDocument;
  readonly generation = this.store.generation;
  readonly settings = this.store.settings;
  readonly modelCache = this.store.modelCache;
  readonly documentCount = computed(() => this.store.documents().length);
  readonly modelQuery = signal("");
  readonly modelPickerFocused = signal(false);
  readonly selectedModelValues = signal<string[]>([]);
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
  readonly filteredFavoriteModels = computed(() => {
    const favorites = new Set(this.favoriteModelIds());
    return this.modelCache().items.filter((model) =>
      favorites.has(model.id) && this.matchesModelQuery(model, this.modelQuery()));
  });
  readonly filteredOtherModels = computed(() => {
    const favorites = new Set(this.favoriteModelIds());
    return this.modelCache().items.filter((model) =>
      !favorites.has(model.id) && this.matchesModelQuery(model, this.modelQuery()));
  });
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
    this.modelQuery.set(this.selectedModelLabel());
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

  private matchesModelQuery(model: ModelOption, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return true;
    }

    return model.name.toLowerCase().includes(normalizedQuery)
      || model.id.toLowerCase().includes(normalizedQuery);
  }
}
