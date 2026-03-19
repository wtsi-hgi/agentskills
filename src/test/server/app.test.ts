import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

type TimerRecord = {
  delay: number;
  callback: () => void;
};

type DashboardWindow = JSDOM["window"] & {
  __conductorDashboardTest: {
    applyMessage(message: unknown): void;
  };
};

class FakeWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSED = 3;

  public readonly sent: unknown[] = [];

  public readyState = FakeWebSocket.CONNECTING;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public constructor(public readonly url: string) {}

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(payload: string): void {
    this.sent.push(JSON.parse(payload) as unknown);
  }

  public close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  public open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  public emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  public emitMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

type DashboardHarness = {
  dom: JSDOM;
  window: DashboardWindow;
  sockets: FakeWebSocket[];
  timers: TimerRecord[];
};

const dashboardsToClose: JSDOM[] = [];

function createPhase(number: number, itemCount: number, pendingApprovalId?: string) {
  return {
    number,
    title: `Phase ${number}`,
    items: Array.from({ length: itemCount }, (_, index) => {
      const itemId = `${String.fromCharCode(64 + number)}${index + 1}`;
      return {
        id: itemId,
        title: `Item ${itemId}`,
        specSection: itemId,
        implemented: false,
        reviewed: false,
        status: pendingApprovalId === itemId ? "pending-approval" : "pending",
      };
    }),
    batches: [],
  };
}

async function loadDashboard(width = 1280): Promise<DashboardHarness> {
  const sockets: FakeWebSocket[] = [];
  const timers: TimerRecord[] = [];
  const html = await readFile(path.join(process.cwd(), "src", "server", "app", "index.html"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "http://localhost:8484/",
    beforeParse(window: JSDOM["window"]) {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: width,
      });

      const factory = function createSocket(url: string) {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      };

      window.WebSocket = FakeWebSocket as unknown as JSDOM["window"]["WebSocket"];
      (window as JSDOM["window"] & { CONDUCTOR_WEBSOCKET_FACTORY: typeof factory }).CONDUCTOR_WEBSOCKET_FACTORY = factory;
      window.setTimeout = ((callback: (() => void) | string, delay?: number) => {
        timers.push({
          delay: Number(delay ?? 0),
          callback: typeof callback === "function" ? callback : () => undefined,
        });
        return timers.length;
      }) as typeof window.setTimeout;
      window.clearTimeout = (() => undefined) as typeof window.clearTimeout;
    },
  });

  dashboardsToClose.push(dom);

  return {
    dom,
    window: dom.window as unknown as DashboardWindow,
    sockets,
    timers,
  };
}

afterEach(() => {
  for (const dashboard of dashboardsToClose.splice(0)) {
    dashboard.window.close();
  }
});

describe("team dashboard SPA", () => {
  it("renders 2 phase headings and 5 item rows from a state update", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "state",
      data: {
        status: "running",
        startedBy: "alice",
        currentPhase: 1,
        currentItemIndex: 0,
        itemStatuses: {},
      },
    });
    socket?.emitMessage({ type: "phase", data: createPhase(1, 2) });
    socket?.emitMessage({ type: "phase", data: createPhase(2, 3) });

    expect(dashboard.window.document.querySelectorAll(".phase-heading")).toHaveLength(2);
    expect(dashboard.window.document.querySelectorAll(".item-row")).toHaveLength(5);
  });

  it("lists pending approval items in the approval queue", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "state",
      data: {
        status: "running",
        currentPhase: 1,
        currentItemIndex: 0,
        itemStatuses: { A2: "pending-approval" },
      },
    });
    socket?.emitMessage({ type: "phase", data: createPhase(1, 2, "A2") });

    const approvalText = dashboard.window.document.getElementById("approval-list")?.textContent ?? "";
    expect(approvalText).toContain("A2 - Item A2");
  });

  it("sends a pause client message when the Pause button is clicked", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    (dashboard.window.document.getElementById("pause-button") as { click(): void }).click();

    expect(socket?.sent).toEqual([{ type: "pause" }]);
  });

  it("retries websocket connections with exponential backoff", async () => {
    const dashboard = await loadDashboard();

    dashboard.sockets[0]?.emitClose();
    expect(dashboard.timers[0]?.delay).toBe(1000);
    dashboard.timers[0]?.callback();

    dashboard.sockets[1]?.emitClose();
    expect(dashboard.timers[1]?.delay).toBe(2000);
    dashboard.timers[1]?.callback();

    dashboard.sockets[2]?.emitClose();
    expect(dashboard.timers[2]?.delay).toBe(4000);
  });

  it("renders a single-column layout without horizontal overflow on mobile widths", async () => {
    const dashboard = await loadDashboard(375);

    expect(dashboard.window.document.body.dataset.layout).toBe("single-column");
    expect((dashboard.window.document.getElementById("layout-root") as { style: { gridTemplateColumns: string } }).style.gridTemplateColumns).toBe("1fr");
    expect(dashboard.window.document.body.style.overflowX).toBe("hidden");
  });

  it("sends an addNote client message when a note is submitted", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    ((dashboard.window.document.getElementById("note-item-id") as unknown) as { value: string }).value = "A1";
    ((dashboard.window.document.getElementById("note-text") as unknown) as { value: string }).value = "needs fix";
    (dashboard.window.document.getElementById("note-form") as { dispatchEvent(event: Event): boolean }).dispatchEvent(
      new dashboard.window.Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(socket?.sent).toEqual([{ type: "addNote", itemId: "A1", text: "needs fix" }]);
  });
});