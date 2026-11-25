import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionSupervisor } from "../dist/index.js";
import { PI_SESSION_DIR_ENV, resolveSessionDir } from "../dist/session-dir.js";

/**
 * pi-gui must store and list sessions where the pi CLI does: the
 * PI_CODING_AGENT_SESSION_DIR env var, then the `sessionDir` setting, then
 * pi's per-cwd default. Everything here uses temp dirs; no real session data.
 */

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface Fixture {
  readonly root: string;
  readonly agentDir: string;
  readonly workspace: string;
  readonly otherWorkspace: string;
  readonly sessionDir: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-gui-session-dir-")));
  const previousEnv = process.env[PI_SESSION_DIR_ENV];
  const previousAgentDirEnv = process.env[PI_AGENT_DIR_ENV];
  delete process.env[PI_SESSION_DIR_ENV];
  const fixture: Fixture = {
    root,
    agentDir: join(root, "agent"),
    workspace: join(root, "workspace"),
    otherWorkspace: join(root, "other-workspace"),
    sessionDir: join(root, "shared-sessions"),
  };
  // pi's default session dir derives from its global agent dir, so point that at the temp
  // tree too; otherwise tests would create directories under the real ~/.pi.
  process.env[PI_AGENT_DIR_ENV] = fixture.agentDir;
  await Promise.all(
    [fixture.agentDir, fixture.workspace, fixture.otherWorkspace].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  try {
    await run(fixture);
  } finally {
    if (previousEnv === undefined) {
      delete process.env[PI_SESSION_DIR_ENV];
    } else {
      process.env[PI_SESSION_DIR_ENV] = previousEnv;
    }
    if (previousAgentDirEnv === undefined) {
      delete process.env[PI_AGENT_DIR_ENV];
    } else {
      process.env[PI_AGENT_DIR_ENV] = previousAgentDirEnv;
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** Persist a one-turn session the way pi does (a file appears with the first assistant message). */
function persistTurn(manager: SessionManager): string {
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();
  assert.ok(file, "expected a persisted session file");
  return file;
}

/** Drive SessionSupervisor.createSession up to the point where pi receives its SessionManager. */
async function createSessionAndCaptureManager(
  supervisor: SessionSupervisor,
  workspacePath: string,
  captured: { manager?: SessionManager },
): Promise<void> {
  const workspace = await supervisor.registerWorkspace(workspacePath, "Workspace");
  await assert.rejects(supervisor.createSession(workspace), /stop after capture/);
  assert.ok(captured.manager, "expected createSession to hand pi a SessionManager");
}

function makeSupervisor(agentDir: string, captured: { manager?: SessionManager }) {
  return new SessionSupervisor({
    catalogFilePath: join(agentDir, "..", "catalogs.json"),
    agentDir,
    createAgentSessionRuntimeImpl: async (options) => {
      captured.manager = options?.sessionManager;
      throw new Error("stop after capture");
    },
  });
}

await test("resolveSessionDir is undefined without the env var or a setting", async () => {
  await withFixture(async ({ agentDir, workspace }) => {
    assert.equal(resolveSessionDir(workspace, agentDir), undefined);
  });
});

await test("resolveSessionDir reads the env var, expands ~, and resolves relative paths from the cwd", async () => {
  await withFixture(async ({ agentDir, workspace, sessionDir }) => {
    process.env[PI_SESSION_DIR_ENV] = sessionDir;
    assert.equal(resolveSessionDir(workspace, agentDir), sessionDir);

    process.env[PI_SESSION_DIR_ENV] = "~/pi-sessions";
    assert.equal(resolveSessionDir(workspace, agentDir), join(homedir(), "pi-sessions"));

    process.env[PI_SESSION_DIR_ENV] = "relative-sessions";
    assert.equal(resolveSessionDir(workspace, agentDir), resolve(workspace, "relative-sessions"));

    // file:// URLs are accepted by the pi CLI, so they must not become a path under the workspace.
    process.env[PI_SESSION_DIR_ENV] = pathToFileURL(sessionDir).href;
    assert.equal(resolveSessionDir(workspace, agentDir), sessionDir);
  });
});

await test("resolveSessionDir falls back to the sessionDir setting, and the env var wins over it", async () => {
  await withFixture(async ({ agentDir, workspace, sessionDir, root }) => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionDir }));
    assert.equal(resolveSessionDir(workspace, agentDir), sessionDir);

    const envDir = join(root, "from-env");
    process.env[PI_SESSION_DIR_ENV] = envDir;
    assert.equal(resolveSessionDir(workspace, agentDir), envDir);
  });
});

await test("with the env var set, a new session lands in that dir and listing is filtered by workspace", async () => {
  await withFixture(async ({ agentDir, workspace, otherWorkspace, sessionDir }) => {
    process.env[PI_SESSION_DIR_ENV] = sessionDir;
    const captured: { manager?: SessionManager } = {};
    const supervisor = makeSupervisor(agentDir, captured);

    await createSessionAndCaptureManager(supervisor, workspace, captured);
    const manager = captured.manager!;
    assert.equal(manager.getSessionDir(), sessionDir);
    const sessionId = manager.getSessionId();
    const sessionFile = persistTurn(manager);
    assert.equal(resolve(sessionFile, ".."), sessionDir);

    // A session for a different cwd sharing the same flat directory, as the pi CLI would write it.
    persistTurn(SessionManager.create(otherWorkspace, sessionDir));
    assert.equal((await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).length, 2);

    const synced = await supervisor.syncWorkspace(workspace);
    assert.deepEqual(
      synced.sessions.map((session) => session.sessionRef.sessionId),
      [sessionId],
    );
    // Nothing was written to pi's default per-cwd location (the fixture points pi's agent dir at agentDir).
    await assert.rejects(readdir(join(agentDir, "sessions")), { code: "ENOENT" });
  });
});

await test("with the sessionDir setting and no env var, sessions use the configured dir", async () => {
  await withFixture(async ({ agentDir, workspace, sessionDir }) => {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ sessionDir }));
    const captured: { manager?: SessionManager } = {};
    const supervisor = makeSupervisor(agentDir, captured);

    await createSessionAndCaptureManager(supervisor, workspace, captured);
    const manager = captured.manager!;
    assert.equal(manager.getSessionDir(), sessionDir);
    const sessionId = manager.getSessionId();
    persistTurn(manager);

    const synced = await supervisor.syncWorkspace(workspace);
    assert.deepEqual(
      synced.sessions.map((session) => session.sessionRef.sessionId),
      [sessionId],
    );
  });
});

await test("with neither configured, sessions stay in pi's per-cwd default dir", async () => {
  await withFixture(async ({ agentDir, workspace, sessionDir }) => {
    const captured: { manager?: SessionManager } = {};
    const supervisor = makeSupervisor(agentDir, captured);

    await createSessionAndCaptureManager(supervisor, workspace, captured);
    const manager = captured.manager!;
    const defaultDir = SessionManager.create(workspace).getSessionDir();
    assert.equal(manager.getSessionDir(), defaultDir);
    assert.notEqual(manager.getSessionDir(), sessionDir);
    // The default lives under the (temp) agent dir, so no stray directories land in the real ~/.pi.
    assert.ok(defaultDir.startsWith(join(agentDir, "sessions")), defaultDir);
  });
});
