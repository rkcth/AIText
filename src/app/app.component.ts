import { CommonModule } from "@angular/common";
import { Component, computed, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { AppStore } from "./app.store";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  readonly store = inject(AppStore);
  readonly activeDocument = this.store.activeDocument;
  readonly generation = this.store.generation;
  readonly settings = this.store.settings;
  readonly modelCache = this.store.modelCache;
  readonly documentCount = computed(() => this.store.documents().length);

  previewText(content: string): string {
    const flattened = content.replace(/\s+/g, " ").trim();
    if (!flattened) {
      return "Empty document";
    }

    return flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
  }

  onEditorInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.store.updateActiveDocumentContent(target.value);
  }

  updateNumberSetting(
    key: "maxTokens" | "temperature" | "topP",
    value: string,
  ): void {
    this.store.updateSetting(key, Number(value));
  }

  async requestCompletion(): Promise<void> {
    await this.store.generateCompletion();
  }

  async regenerateLastAi(): Promise<void> {
    await this.store.regenerateLastAi();
  }

  async refreshModels(): Promise<void> {
    await this.store.refreshModels();
  }
}
