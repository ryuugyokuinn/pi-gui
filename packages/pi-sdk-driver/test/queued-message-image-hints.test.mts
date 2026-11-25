import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";

/**
 * pi appends image resize/conversion hints to a queued message's text after a blank line before
 * it announces the message start, so the queued entry has to match by that prefix too.
 */

type Queued = { id: string; mode: "steer" | "followUp"; text: string };

function queued(id: string, mode: Queued["mode"], text: string): Queued {
  return { id, mode, text, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "" } as Queued;
}

async function startUserMessage(queuedMessages: Queued[], text: string) {
  const emitted: Array<{ type: string; message?: { id: string } }> = [];
  const record = {
    ref: { workspaceId: "ws-1", sessionId: "sess-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "queued probe",
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runningRunId: "run-1",
    queuedMessages,
    startedQueuedMessageIds: new Set<string>(),
    closed: false,
    listeners: new Set([
      (event: { type: string; message?: { id: string } }) => {
        emitted.push(event);
      },
    ]),
    eventQueue: Promise.resolve(),
    pendingHostUiRequests: new Map(),
    extensionUiState: { dialogs: [], notices: [] },
  };
  const supervisor = new SessionSupervisor({
    catalogStorage: {
      sessions: { upsertSession: async () => undefined },
      setSessionFile: async () => undefined,
    } as never,
  }) as unknown as { handleAgentEvent: (record: unknown, event: unknown) => void };
  supervisor.handleAgentEvent(record, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }] },
  });
  await record.eventQueue;
  return {
    remaining: record.queuedMessages.map((message) => message.id),
    started: emitted.filter((event) => event.type === "queuedMessageStarted"),
  };
}

await test("a queued message whose text pi extended with image hints still starts", async () => {
  const { remaining, started } = await startUserMessage(
    [queued("a", "steer", "look at this")],
    "look at this\n\n[Image resized: 4000x3000 to 2000x1500.]",
  );
  assert.deepEqual(remaining, []);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.message?.id, "a");
});

await test("an exact text match wins over an earlier hinted-prefix candidate", async () => {
  const { remaining, started } = await startUserMessage(
    [queued("short", "steer", "note"), queued("long", "steer", "note\n\nmore")],
    "note\n\nmore",
  );
  assert.deepEqual(remaining, ["short"]);
  assert.equal(started[0]?.message?.id, "long");
});

await test("the hinted match takes the earliest queued message of its mode", async () => {
  const { remaining, started } = await startUserMessage(
    [
      queued("follow", "followUp", "same"),
      queued("steer-1", "steer", "same"),
      queued("steer-2", "steer", "same"),
    ],
    "same\n\n[Image omitted: could not be resized.]",
  );
  assert.deepEqual(remaining, ["follow", "steer-2"]);
  assert.equal(started[0]?.message?.id, "steer-1");
});

await test("text that merely begins with the queued text does not start it", async () => {
  const { remaining, started } = await startUserMessage(
    [queued("a", "steer", "look")],
    "look at this instead",
  );
  assert.deepEqual(remaining, ["a"]);
  assert.equal(started.length, 0);
});
