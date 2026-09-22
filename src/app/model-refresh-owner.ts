export type ModelRefreshSettings = {
  provider: string;
  apiKey: string;
  aiServerUrl: string;
};

export type ModelRefreshHandle<T extends ModelRefreshSettings> = {
  token: number;
  settings: T;
};

export class ModelRefreshOwner<T extends ModelRefreshSettings> {
  private token = 0;

  start(settings: T): ModelRefreshHandle<T> {
    return { token: ++this.token, settings };
  }

  cancel(): void {
    this.token += 1;
  }

  isCurrent(handle: ModelRefreshHandle<T>, signal: AbortSignal | undefined, currentSettings: T): boolean {
    return !signal?.aborted
      && handle.token === this.token
      && currentSettings.provider === handle.settings.provider
      && currentSettings.apiKey === handle.settings.apiKey
      && currentSettings.aiServerUrl === handle.settings.aiServerUrl;
  }
}

export async function runOwnedModelRefresh<TSettings extends ModelRefreshSettings, TItem>(options: {
  owner: ModelRefreshOwner<TSettings>;
  settings: TSettings;
  signal?: AbortSignal;
  getSettings: () => TSettings;
  fetchItems: (settings: TSettings, signal?: AbortSignal) => Promise<TItem[]>;
  onStart: () => void;
  onSuccess: (items: TItem[]) => void;
  onError: (error: unknown) => void;
  onAbortCurrent: () => void;
}): Promise<void> {
  const refresh = options.owner.start(options.settings);
  options.onStart();

  const isCurrent = (): boolean => {
    const currentSettings = options.getSettings();
    const current = options.owner.isCurrent(refresh, options.signal, currentSettings);
    if (options.signal?.aborted && options.owner.isCurrent(refresh, undefined, currentSettings)) options.onAbortCurrent();
    return current;
  };

  try {
    const items = await options.fetchItems(options.settings, options.signal);
    if (!isCurrent()) return;
    options.onSuccess(items);
  } catch (error) {
    if (!isCurrent()) return;
    options.onError(error);
  }
}
