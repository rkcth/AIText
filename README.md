# AIText

Front-end-only Angular text editor with:

- local document storage
- autosave to `IndexedDB`
- multiple documents
- single-step undo and redo during the current session
- OpenRouter settings stored locally
- cached model list with refresh support
- streamed AI continuations with stop and regenerate controls

## Getting started

```bash
npm install
npm run start
```

Build for production with:

```bash
npm run build
```

Build a static bundle that is ready to upload to GitHub Pages with:

```bash
npm run build:pages
```

## GitHub Pages

This repo includes a GitHub Actions workflow that deploys the app to GitHub Pages on pushes to `main`.

In GitHub:

1. Open `Settings` > `Pages`.
2. Set `Source` to `GitHub Actions`.
3. Push to `main`.

The workflow builds the Angular app with the correct Pages base path automatically.

## Storage Migration Notes

Legacy clients stored all app data in `localStorage` under the key `aitext.state.v1`.

That legacy payload was one JSON object with this shape:

```ts
{
  documents: Array<{
    id: string;
    title: string;
    isTitleManual: boolean;
    content: string;
    createdAt: number;
    updatedAt: number;
    undoStack: Array<{
      before: string;
      after: string;
      source: "user" | "ai";
      timestamp: number;
      label: string;
      promptBase?: string;
    }>;
    redoStack: Array<{
      before: string;
      after: string;
      source: "user" | "ai";
      timestamp: number;
      label: string;
      promptBase?: string;
    }>;
  }>;
  activeDocumentId: string | null;
  settings: {
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature: number;
    topP: number;
    systemPrompt: string;
  };
  modelCache: {
    items: ModelOption[];
    fetchedAt: number | null;
  };
}
```

The current app migrates that legacy blob into IndexedDB and intentionally drops persisted undo/redo history. When adding new IndexedDB features or schema versions, keep the legacy upgrade path working for `aitext.state.v1`.

The current IndexedDB layout is normalized:

- `appMeta` stores app-level settings, the active document id, and sidebar order
- `documentSummaries` stores one lightweight row per document for the sidebar
- `documents` stores one full document row per document

Older IndexedDB builds used a single-record `appState` store. The migration layer still upgrades that format too.
