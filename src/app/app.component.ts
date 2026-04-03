import { CommonModule } from "@angular/common";
import { Component, ViewChild, computed, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { AppStore } from "./app.store";
import { IconComponent } from "./icon/icon.component";
import { RichTextEditorComponent } from "./rich-text-editor/rich-text-editor.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IconComponent,
    RichTextEditorComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  @ViewChild("richEditor")
  private readonly richEditor?: RichTextEditorComponent;

  readonly store = inject(AppStore);
  readonly activeDocument = this.store.activeDocument;
  readonly generation = this.store.generation;
  readonly settings = this.store.settings;
  readonly modelCache = this.store.modelCache;
  readonly documentCount = computed(() => this.store.documents().length);

  onEditorChange(content: string): void {
    this.store.updateActiveDocumentContent(content);
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
}
