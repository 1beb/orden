import type { ChatHarness, HarnessAdapter } from "./index";

// Maps a ChatHarness to the adapter that knows how to drive it. The engine takes
// a registry as a dependency (not a global lookup) so tests can wire fakes; a
// shared `defaultRegistry` exists for production where real adapters self-register.
export class AdapterRegistry {
  private adapters = new Map<ChatHarness, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.harness, adapter);
  }

  get(harness: ChatHarness): HarnessAdapter {
    const a = this.adapters.get(harness);
    if (!a) throw new Error(`No adapter registered for harness "${harness}"`);
    return a;
  }
}

export const defaultRegistry = new AdapterRegistry();
