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
  it("renders the spec-writing audit role filter options", async () => {
    const dashboard = await loadDashboard();

    const options = Array.from(
      dashboard.window.document.querySelectorAll("#audit-role-filter option"),
      (option) => (option as HTMLOptionElement).value,
    );

    expect(options).toEqual([
      "all",
      "implementor",
      "reviewer",
      "clarifier",
      "spec-author",
      "spec-reviewer",
      "spec-proofreader",
      "phase-creator",
      "phase-reviewer",
    ]);
  });

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

  it("renders historical notes when addendum entries arrive on connect", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "addendum",
      entry: {
        timestamp: "2025-03-19T09:00:00.000Z",
        itemId: "A1",
        deviation: "Carry this note forward.",
        rationale: "Historical context for the next reviewer.",
        author: "reviewer",
      },
    });

    const noteText = dashboard.window.document.getElementById("notes-list")?.textContent ?? "";
    expect(noteText).toContain("A1");
    expect(noteText).toContain("Carry this note forward.");
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

  it("renders explicit spec-writing status when specStep is active", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "state",
      data: {
        status: "running",
        currentPhase: 1,
        currentItemIndex: 0,
        itemStatuses: {},
        specStep: "reviewing-phases",
        specConsecutivePasses: 1,
        clarificationQuestions: [],
      },
    });

    expect((dashboard.window.document.getElementById("spec-step-card") as HTMLDivElement).hidden).toBe(false);
    expect((dashboard.window.document.getElementById("spec-pass-card") as HTMLDivElement).hidden).toBe(false);
    expect(dashboard.window.document.getElementById("spec-step")?.textContent).toBe("Reviewing Phases");
    expect(dashboard.window.document.getElementById("spec-pass-count")?.textContent).toBe("1");
  });

  it("renders clarification questions and sends submit-clarification from the browser UI", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "state",
      data: {
        status: "running",
        currentPhase: 1,
        currentItemIndex: 0,
        itemStatuses: {},
        specStep: "clarifying",
        clarificationQuestions: [
          {
            question: "Which language should the extension target?",
            suggestedOptions: ["TypeScript", "JavaScript"],
          },
        ],
      },
    });

    const panel = dashboard.window.document.getElementById("clarification-panel") as HTMLDivElement;
    expect(panel.hidden).toBe(false);
    expect(dashboard.window.document.getElementById("clarification-questions")?.textContent).toContain(
      "Which language should the extension target?",
    );

    ((dashboard.window.document.getElementById("clarification-answer-0") as unknown) as { value: string }).value = "TypeScript";
    (dashboard.window.document.getElementById("clarification-form") as HTMLFormElement).dispatchEvent(
      new dashboard.window.Event("submit", { bubbles: true, cancelable: true }),
    );

    expect(socket?.sent).toContainEqual({
      type: "submit-clarification",
      answers: [{ question: "Which language should the extension target?", answer: "TypeScript" }],
    });
  });

  it("hides clarification questions when questions exist outside the clarifying step", async () => {
    const dashboard = await loadDashboard();
    const socket = dashboard.sockets[0];
    socket?.open();

    socket?.emitMessage({
      type: "state",
      data: {
        status: "running",
        currentPhase: 1,
        currentItemIndex: 0,
        itemStatuses: {},
        specStep: "reviewing",
        clarificationQuestions: [
          {
            question: "Which language should the extension target?",
            suggestedOptions: ["TypeScript", "JavaScript"],
          },
        ],
      },
    });

    const panel = dashboard.window.document.getElementById("clarification-panel") as HTMLDivElement;
    expect(panel.hidden).toBe(true);
    expect(dashboard.window.document.getElementById("clarification-questions")?.innerHTML).toBe("");
  });
});
