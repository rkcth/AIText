import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  EMPTY_DOCUMENT_MARKDOWN,
  normalizeStoredContent,
} from "../content-utils";

@Component({
  selector: "app-rich-text-editor",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./rich-text-editor.component.html",
  styleUrl: "./rich-text-editor.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RichTextEditorComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input() content = EMPTY_DOCUMENT_MARKDOWN;
  @Input() disabled = false;
  @Output() contentChange = new EventEmitter<string>();

  @ViewChild("editorHost", { static: true })
  private readonly editorHost?: ElementRef<HTMLDivElement>;

  private editorInstance: Editor | null = null;
  private isApplyingExternalContent = false;

  ngAfterViewInit(): void {
    this.editorInstance = new Editor({
      element: this.editorHost?.nativeElement ?? null,
      content: normalizeStoredContent(this.content),
      contentType: "markdown",
      editable: !this.disabled,
      extensions: [
        StarterKit.configure({
          blockquote: false,
          code: false,
          codeBlock: false,
          strike: false,
          history: false,
        }),
        Markdown,
      ],
      editorProps: {
        attributes: {
          class: "editor-surface ProseMirror",
          autocapitalize: "sentences",
          autocorrect: "on",
          spellcheck: "true",
        },
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData("text/plain");
          if (!text || !this.editorInstance) {
            return false;
          }

          event.preventDefault();
          this.editorInstance
            .chain()
            .focus()
            .insertContent(text, { contentType: "markdown" })
            .run();
          return true;
        },
        handleDOMEvents: {
          copy: (_view, event) => this.handleClipboardCopy(event, false),
          cut: (_view, event) => this.handleClipboardCopy(event, true),
        },
      },
      onUpdate: ({ editor }) => {
        if (this.isApplyingExternalContent) {
          return;
        }

        this.contentChange.emit(editor.getMarkdown());
      },
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    const editor = this.editorInstance;
    if (!editor) {
      return;
    }

    if (changes["disabled"]) {
      editor.setEditable(!this.disabled, false);
    }

    if (changes["content"]) {
      const incomingContent = normalizeStoredContent(this.content);
      if (editor.getMarkdown() !== incomingContent) {
        this.isApplyingExternalContent = true;
        editor.commands.setContent(incomingContent, {
          contentType: "markdown",
          emitUpdate: false,
        });
        this.isApplyingExternalContent = false;
      }
    }
  }

  ngOnDestroy(): void {
    this.editorInstance?.destroy();
    this.editorInstance = null;
  }

  getPlainText(): string {
    return this.editorInstance?.getText({ blockSeparator: "\n\n" }).trim() ?? "";
  }

  isActive(name: string, attributes?: Record<string, unknown>): boolean {
    return this.editorInstance?.isActive(name, attributes) ?? false;
  }

  toggleBold(): void {
    this.editorInstance?.chain().focus().toggleBold().run();
  }

  toggleItalic(): void {
    this.editorInstance?.chain().focus().toggleItalic().run();
  }

  setParagraph(): void {
    this.editorInstance?.chain().focus().setParagraph().run();
  }

  toggleHeading(level: 1 | 2 | 3): void {
    this.editorInstance?.chain().focus().toggleHeading({ level }).run();
  }

  toggleBulletList(): void {
    this.editorInstance?.chain().focus().toggleBulletList().run();
  }

  toggleOrderedList(): void {
    this.editorInstance?.chain().focus().toggleOrderedList().run();
  }

  addHorizontalRule(): void {
    this.editorInstance?.chain().focus().setHorizontalRule().run();
  }

  focusEnd(): void {
    this.editorInstance?.chain().focus("end").run();
  }

  private handleClipboardCopy(event: Event, isCut: boolean): boolean {
    const clipboardEvent = event as ClipboardEvent;
    const editor = this.editorInstance;
    if (!clipboardEvent.clipboardData || !editor) {
      return false;
    }

    const { from, to, empty } = editor.state.selection;
    if (empty) {
      return false;
    }

    const slice = editor.state.doc.slice(from, to);
    const temporaryEditor = new Editor({
      extensions: [
        StarterKit.configure({
          blockquote: false,
          code: false,
          codeBlock: false,
          strike: false,
          history: false,
        }),
        Markdown,
      ],
      content: {
        type: "doc",
        content: slice.content.toJSON(),
      },
    });

    const markdown = temporaryEditor.getMarkdown();
    temporaryEditor.destroy();

    clipboardEvent.preventDefault();
    clipboardEvent.clipboardData.setData("text/plain", markdown);

    if (isCut) {
      editor.chain().focus().deleteSelection().run();
    }

    return true;
  }
}
