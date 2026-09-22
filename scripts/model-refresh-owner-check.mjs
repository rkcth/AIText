import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ModelRefreshOwner, runOwnedModelRefresh } from '../src/app/model-refresh-owner.ts';

class ModelRefreshHarness {
  owner = new ModelRefreshOwner();
  settings = { provider: 'aiServer', apiKey: '', aiServerUrl: 'http://old', model: 'old-model' };
  cache = { items: [], error: '', isLoading: false };

  updateSetting(key, value) {
    if (key === 'provider' || key === 'apiKey' || key === 'aiServerUrl') this.cancelModelRefresh();
    this.settings = { ...this.settings, [key]: value };
  }

  cancelModelRefresh() {
    this.owner.cancel();
    this.cache = { ...this.cache, isLoading: false };
  }

  async refreshModels(fetchModels, signal) {
    await runOwnedModelRefresh({
      owner: this.owner,
      settings: this.settings,
      signal,
      getSettings: () => this.settings,
      fetchItems: fetchModels,
      onStart: () => { this.cache = { ...this.cache, isLoading: true, error: '' }; },
      onSuccess: (items) => {
        const model = items.some((item) => item.id === this.settings.model) ? this.settings.model : (items[0]?.id ?? '');
        this.cache = { items, error: '', isLoading: false };
        this.settings = { ...this.settings, model };
      },
      onError: (error) => { this.cache = { ...this.cache, error: String(error?.message ?? error), isLoading: false }; },
      onAbortCurrent: () => { this.cache = { ...this.cache, isLoading: false }; },
    });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

{
  const store = new ModelRefreshHarness();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise);
  const freshRun = store.refreshModels(() => fresh.promise);
  stale.resolve([{ id: 'stale-model' }]);
  await staleRun;
  assert.equal(store.cache.isLoading, true);
  assert.deepEqual(store.cache.items, []);
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.settings.model, 'fresh-model');
  assert.equal(store.cache.error, '');
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise);
  const freshRun = store.refreshModels(() => fresh.promise);
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  stale.resolve([{ id: 'stale-model' }]);
  await staleRun;
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.settings.model, 'fresh-model');
  assert.equal(store.cache.error, '');
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise);
  const freshRun = store.refreshModels(() => fresh.promise);
  stale.reject(new Error('stale boom'));
  await staleRun;
  assert.equal(store.cache.error, '');
  assert.equal(store.cache.isLoading, true);
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  assert.equal(store.cache.error, '');
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise);
  const freshRun = store.refreshModels(() => fresh.promise);
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  stale.reject(new Error('late stale boom'));
  await staleRun;
  assert.equal(store.cache.error, '');
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.settings.model, 'fresh-model');
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const pending = deferred();
  const run = store.refreshModels(() => pending.promise);
  store.updateSetting('aiServerUrl', 'http://new');
  assert.equal(store.cache.isLoading, false);
  pending.resolve([{ id: 'stale-model' }]);
  await run;
  assert.deepEqual(store.cache.items, []);
  assert.equal(store.settings.model, 'old-model');
  assert.equal(store.cache.error, '');
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const oldController = new AbortController();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise, oldController.signal);
  oldController.abort();
  const freshRun = store.refreshModels(() => fresh.promise);
  stale.resolve([{ id: 'stale-model' }]);
  await staleRun;
  assert.equal(store.cache.isLoading, true);
  assert.deepEqual(store.cache.items, []);
  assert.equal(store.cache.error, '');
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const oldController = new AbortController();
  const stale = deferred();
  const fresh = deferred();
  const staleRun = store.refreshModels(() => stale.promise, oldController.signal);
  oldController.abort();
  const freshRun = store.refreshModels(() => fresh.promise);
  stale.reject(new Error('aborted stale boom'));
  await staleRun;
  assert.equal(store.cache.isLoading, true);
  assert.deepEqual(store.cache.items, []);
  assert.equal(store.cache.error, '');
  fresh.resolve([{ id: 'fresh-model' }]);
  await freshRun;
  assert.deepEqual(store.cache.items.map((item) => item.id), ['fresh-model']);
  assert.equal(store.cache.isLoading, false);
}

{
  const store = new ModelRefreshHarness();
  const controller = new AbortController();
  const pending = deferred();
  const run = store.refreshModels(() => pending.promise, controller.signal);
  controller.abort();
  pending.reject(new Error('current abort'));
  await run;
  assert.equal(store.cache.isLoading, false);
  assert.deepEqual(store.cache.items, []);
  assert.equal(store.cache.error, '');
}

console.log('model refresh owner checks passed');
