type Listener<T> = (payload: T) => void;

export class EventBus<TEvents extends Record<string, unknown>> {
  private readonly map = new Map<keyof TEvents, Set<Listener<TEvents[keyof TEvents]>>>();

  on<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(listener as Listener<TEvents[keyof TEvents]>);
    return () => {
      set?.delete(listener as Listener<TEvents[keyof TEvents]>);
    };
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const l of set) {
      try { (l as Listener<TEvents[K]>)(payload); } catch { }
    }
  }

  dispose(): void {
    this.map.clear();
  }
}
