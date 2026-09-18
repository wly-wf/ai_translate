// Serialize provider mutations in each settings window. A failed write must not
// prevent a later correction or deletion from reaching the native store.
export class ProviderWrites {
  private pending = new Map<string, Promise<unknown>>();

  run<T>(provider: string, write: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(provider) ?? Promise.resolve())
      .catch(() => undefined)
      .then(write);
    this.pending.set(provider, result);
    void result.finally(() => {
      if (this.pending.get(provider) === result) this.pending.delete(provider);
    }).catch(() => undefined);
    return result;
  }
}
