# AIText

Front-end-only Angular text editor with:

- local document storage
- autosave to `localStorage`
- multiple documents
- full undo and redo history
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
