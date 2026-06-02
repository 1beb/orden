import type {
  ChatHarness,
  DriverEvent,
  HarnessAdapter,
  HarnessDriver,
  ModelOption,
  SlashCommand,
} from "../../src/index";

type PermCb = (req: {
  toolName: string;
  input: unknown;
  title: string;
}) => Promise<{ allow: boolean }>;

export interface FakeDriver extends HarnessDriver {
  // Test controls:
  push(ev: DriverEvent): void; // yield one DriverEvent to the engine's pump
  end(): void; // end the events stream
  firePermission(req: { toolName: string; input: unknown; title: string }): Promise<{
    allow: boolean;
  }>;
  sent: string[];
  models: string[]; // setModel calls
  openCalls: Array<{ cwd: string; model?: string }>;
  closed: boolean;
}

// A HarnessDriver whose event stream is manually pushable: tests call push()/end()
// to feed DriverEvents to the engine's background pump. Records send/setModel and
// captures the onPermission cb so tests can fire a permission round-trip.
export function makeFakeDriver(opts?: {
  commands?: SlashCommand[];
  openCalls?: Array<{ cwd: string; model?: string }>;
}): FakeDriver {
  const queue: DriverEvent[] = [];
  let ended = false;
  // A pending waiter parked when the consumer outran the queue.
  let wake: (() => void) | null = null;
  let permCb: PermCb | null = null;

  const wakeUp = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const events: AsyncIterable<DriverEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  const driver: FakeDriver = {
    events,
    sent: [],
    models: [],
    openCalls: opts?.openCalls ?? [],
    closed: false,
    async send(text: string) {
      this.sent.push(text);
    },
    async setModel(model: string) {
      this.models.push(model);
    },
    async listCommands(): Promise<SlashCommand[]> {
      return opts?.commands ?? [];
    },
    onPermission(cb: PermCb) {
      permCb = cb;
    },
    async close() {
      this.closed = true;
      ended = true;
      wakeUp();
    },
    push(ev: DriverEvent) {
      queue.push(ev);
      wakeUp();
    },
    end() {
      ended = true;
      wakeUp();
    },
    firePermission(req) {
      if (!permCb) throw new Error("no permission handler registered");
      return permCb(req);
    },
  };
  return driver;
}

// A HarnessAdapter whose open() returns a given fake driver and listModels()
// returns canned options.
export function makeFakeAdapter(
  harness: ChatHarness,
  driver: HarnessDriver & { openCalls?: Array<{ cwd: string; model?: string }> },
  models?: ModelOption[],
): HarnessAdapter {
  return {
    harness,
    async listModels(): Promise<ModelOption[]> {
      return models ?? [{ harness, id: "default", label: "Default" }];
    },
    open(o: { cwd: string; model?: string }): HarnessDriver {
      if (driver.openCalls) driver.openCalls.push({ cwd: o.cwd, model: o.model });
      return driver;
    },
  };
}
