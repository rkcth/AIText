import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = '/Volumes/RobsExternalDrive/Programming/AIText/dist/aitext/browser';
const appPort = 4173;
const apiPort = 4174;
let chatRequests = 0;
let modelRequestsStarted = 0;
let modelRequestsCompleted = 0;
let holdModels = false;
let holdChats = false;
let pendingModelResponses = [];
let pendingChatResponses = [];

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const initialState = {
  documents: [{ id: 'doc-1', title: 'Doc 1', isTitleManual: true, content: 'Hello **bold** world.', folder: '', createdAt: Date.now(), updatedAt: Date.now(), undoStack: [], redoStack: [] }],
  activeDocumentId: 'doc-1',
  settings: { provider: 'aiServer', apiKey: '', aiServerUrl: `http://127.0.0.1:${apiPort}/v1`, model: 'test-model', favoriteModelIds: [], maxTokens: 64, temperature: 0.7, topP: 1, systemPrompt: '' },
  modelCache: { items: [{ id: 'test-model', name: 'Test Model', contextLength: 100000, description: '' }], fetchedAt: Date.now() },
};

const app = createServer(async (req, res) => {
  if (req.url === '/prep') {
    res.setHeader('content-type', 'text/html');
    const document = initialState.documents[0];
    const summary = { id: document.id, title: document.title, isTitleManual: document.isTitleManual, preview: 'Hello bold world.', folder: '', createdAt: document.createdAt, updatedAt: document.updatedAt };
    const meta = { activeDocumentId: document.id, documentOrder: [document.id], settings: initialState.settings, modelCache: initialState.modelCache };
    res.end(`<script>
      const doc = ${JSON.stringify(document)};
      const summary = ${JSON.stringify(summary)};
      const meta = ${JSON.stringify(meta)};
      const deleteRequest = indexedDB.deleteDatabase('aitext');
      deleteRequest.onsuccess = deleteRequest.onerror = deleteRequest.onblocked = () => {
        const request = indexedDB.open('aitext', 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('appMeta')) db.createObjectStore('appMeta');
          if (!db.objectStoreNames.contains('documentSummaries')) db.createObjectStore('documentSummaries', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('appState')) db.createObjectStore('appState');
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['appMeta', 'documentSummaries', 'documents'], 'readwrite');
          tx.objectStore('appMeta').put(meta, 'current');
          tx.objectStore('documentSummaries').put(summary);
          tx.objectStore('documents').put(doc);
          tx.oncomplete = () => { location.href = '/'; };
          tx.onerror = () => { throw tx.error; };
        };
      };
    </script>`);
    return;
  }
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const path = existsSync(join(root, file)) ? join(root, file) : join(root, 'index.html');
  res.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
  res.end(await readFile(path));
});

const api = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  const sendModels = () => {
    modelRequestsCompleted += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'test-model', name: 'Test Model', context_length: 100000 }] }));
  };
  if (req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ chatRequests, modelRequestsStarted, modelRequestsCompleted, pendingModels: pendingModelResponses.length, pendingChats: pendingChatResponses.length }));
    return;
  }
  if (req.url?.startsWith('/hold-models')) {
    holdModels = req.url.includes('value=1');
    res.end('ok');
    return;
  }
  if (req.url?.startsWith('/release-model')) {
    const next = req.url.includes('which=last') ? pendingModelResponses.pop() : pendingModelResponses.shift();
    next?.();
    res.end('ok');
    return;
  }
  if (req.url?.startsWith('/hold-chats')) {
    holdChats = req.url.includes('value=1');
    res.end('ok');
    return;
  }
  if (req.url?.startsWith('/release-chat')) {
    const next = req.url.includes('which=last') ? pendingChatResponses.pop() : pendingChatResponses.shift();
    next?.();
    res.end('ok');
    return;
  }
  if (req.url === '/v1/models') {
    modelRequestsStarted += 1;
    if (holdModels) await new Promise(resolve => pendingModelResponses.push(resolve));
    else await new Promise(r => setTimeout(r, 50));
    sendModels();
    return;
  }
  if (req.url === '/v1/chat/completions') {
    chatRequests += 1;
    if (holdChats) await new Promise(resolve => pendingChatResponses.push(resolve));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*' });
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      const text = Buffer.concat(body).toString();
      const isRewrite = text.includes('Rewrite only the selected passage');
      const content = isRewrite ? 'Goodbye **bold** world.' : `Continuation ${chatRequests}.`;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`);
      setTimeout(() => { res.write('data: [DONE]\r\n\r\n'); res.end(); }, 100);
    });
    return;
  }
  res.writeHead(404).end('not found');
});

await new Promise(r => app.listen(appPort, r));
await new Promise(r => api.listen(apiPort, r));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9223', `--user-data-dir=/tmp/aitext-chrome-check-${Date.now()}`, '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let ws;
const cleanup = () => { try { ws?.close(); } catch {} chrome.kill(); app.close(); api.close(); };
process.once('uncaughtException', (error) => { cleanup(); throw error; });
process.once('unhandledRejection', (error) => { cleanup(); throw error; });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:9223/json/version'); break; } catch { await sleep(100); } }
let pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
let page = pages.find(p => p.type === 'page');
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise(r => pending.set(id, r)); }
async function evalInPage(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text); return r.result.result.value; }
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/prep` });
await sleep(2000);

const rewriteResult = await evalInPage(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (sel, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const el = document.querySelector(sel); if (el) return el; await sleep(50); } throw new Error('missing ' + sel); };
  const waitFor = async (fn, label, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); } throw new Error('timeout waiting for ' + label); };
  await wait('.ProseMirror');
  await waitFor(() => document.querySelector('.ProseMirror')?.textContent.includes('Hello'), 'document hydration');
  document.querySelector('.chat-launcher').click();
  await wait('.floating-chat');
  document.querySelector('.ProseMirror').focus();
  return document.querySelector('.ProseMirror').innerHTML;
})()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft' });
const rewriteCheck = await evalInPage(`(async (originalHtml) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, label, timeout = 6000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); } throw new Error('timeout waiting for ' + label); };
  const buttons = () => [...document.querySelectorAll('button')];
  const byText = text => buttons().find(b => b.textContent.trim() === text || b.title === text || b.getAttribute('aria-label') === text);
  const editor = document.querySelector('.ProseMirror');
  if (!originalHtml.includes('<strong>bold</strong>')) throw new Error('formatted fixture did not hydrate');
  byText('Rewrite selection').click();
  await waitFor(() => document.querySelector('.coauthor-card')?.textContent.includes('Goodbye') && byText('Apply') && !byText('Apply').disabled, 'rewrite completion');
  byText('Apply').click();
  await waitFor(() => editor.textContent.includes('Goodbye bold world'), 'rewrite apply');
  const undoButton = await waitFor(() => buttons().find(b => b.textContent.trim() === 'Undo' && !b.disabled), 'enabled toolbar Undo');
  undoButton.click();
  await waitFor(() => editor.textContent === 'Hello bold world.' && editor.querySelector('strong')?.textContent === 'bold', 'toolbar undo restore');
  return { ok: true, afterApply: editor.textContent };
})(${JSON.stringify(rewriteResult)})`);
assert.equal(rewriteCheck.ok, true);

await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/prep` });
await sleep(2000);

const result = await evalInPage(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (sel, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const el = document.querySelector(sel); if (el) return el; await sleep(50); } throw new Error('missing ' + sel); };
  const waitFor = async (fn, label, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); } throw new Error('timeout waiting for ' + label); };
  const api = path => fetch('http://127.0.0.1:${apiPort}' + path).then(r => r.json().catch(() => ({})));
  const stats = () => api('/stats');
  await wait('.ProseMirror');
  await waitFor(() => document.querySelector('.ProseMirror')?.textContent.includes('Hello'), 'document hydration');
  document.querySelector('.chat-launcher').click();
  await wait('.floating-chat');
  const buttons = () => [...document.querySelectorAll('button')];
  const byText = text => buttons().find(b => b.textContent.trim() === text || b.title === text || b.getAttribute('aria-label') === text);
  const editor = document.querySelector('.ProseMirror');
  const originalHtml = editor.innerHTML;
  if (!originalHtml.includes('<strong>bold</strong>')) throw new Error('formatted fixture did not hydrate');
  await api('/hold-models?value=1');
  const beforeRefresh = await stats();
  document.querySelector('.coauthor-buttons button').click();
  await waitFor(async () => { const current = await stats(); return current.modelRequestsStarted > beforeRefresh.modelRequestsStarted && current.pendingModels >= 1; }, 'first pending model refresh');
  document.querySelector('.chat-send-button').click();
  await waitFor(() => !document.querySelector('.chat-send-button')?.textContent.includes('Stop'), 'stop to settle');
  if (byText('Apply') && !byText('Apply').disabled) throw new Error('stopped refresh created applicable proposal');
  const continueButton = await waitFor(() => { const button = byText('Continue'); return button && !button.disabled && button; }, 'enabled Continue');
  continueButton.click();
  await sleep(1000);
  const afterRestartClick = await stats();
  if (afterRestartClick.pendingModels < 2) throw new Error('second refresh did not start ' + JSON.stringify(afterRestartClick) + ' buttons=' + buttons().map(b => b.textContent.trim() + ':' + b.disabled).join('|'));
  await fetch('http://127.0.0.1:${apiPort}/release-model?which=last');
  await waitFor(() => { const apply = byText('Apply'); return document.querySelector('.coauthor-card')?.textContent.includes('Continuation') && apply && !apply.disabled; }, 'restart completion', 6000);
  const restartedText = document.querySelector('.coauthor-card').textContent;
  await fetch('http://127.0.0.1:${apiPort}/release-model?which=first');
  await sleep(200);
  if (document.querySelector('.coauthor-card')?.textContent !== restartedText || document.querySelector('.chat-error')?.textContent) throw new Error('old refresh altered restarted proposal');
  const before = document.querySelector('.ProseMirror').textContent;
  document.querySelector('.ProseMirror').focus();
  document.execCommand('insertText', false, ' changed');
  await sleep(100);
  byText('Apply').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(100);
  if (!document.body.textContent.includes('manuscript changed')) throw new Error('stale apply was not rejected');
  document.querySelector('.coauthor-actions .danger')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(50);
  const beforeSwitchRefresh = await stats();
  byText('Continue').click();
  await waitFor(async () => { const current = await stats(); return current.modelRequestsStarted > beforeSwitchRefresh.modelRequestsStarted && current.pendingModels >= 1; }, 'pending switch model refresh');
  byText('New').click();
  await fetch('http://127.0.0.1:${apiPort}/release-model?which=last');
  await sleep(200);
  if (document.querySelector('.coauthor-card')) throw new Error('proposal reappeared after document switch');
  return { ok: true, before, after: document.querySelector('.ProseMirror').textContent };
})()`);
assert.equal(result.ok, true);
console.log('browser lifecycle checks passed', result);
ws.close(); chrome.kill(); app.close(); api.close();
