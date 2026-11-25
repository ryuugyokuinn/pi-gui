import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

/** A git package whose clone fails fast and offline: nothing listens on that port. */
const MISSING_PACKAGE = "git:http://127.0.0.1:1/owner/repo.git";

async function createFixture(): Promise<{ agentDir: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-package-failure-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [MISSING_PACKAGE] }));
  return { agentDir, workspacePath };
}

await test("a package that fails to install shows up as an extension diagnostic", async () => {
  const { agentDir, workspacePath } = await createFixture();
  const supervisor = new RuntimeSupervisor({ agentDir });
  const workspace = { workspaceId: "workspace-1", path: workspacePath };

  // pi 1.6 skips the package instead of throwing, so the snapshot still loads.
  const snapshot = await supervisor.getRuntimeSnapshot(workspace);

  const record = snapshot.extensions.find((extension) => extension.path === MISSING_PACKAGE);
  assert.ok(record, "the failed package should be listed");
  assert.equal(record.enabled, false);
  // Marks the placeholder as not enableable, so list UIs (the @ menu) can skip it.
  assert.equal(record.installFailed, true);
  await assert.rejects(
    supervisor.setExtensionEnabled(workspace, MISSING_PACKAGE, true),
    /Unknown extension/,
  );
  assert.equal(record.sourceInfo.origin, "package");
  assert.deepEqual(
    record.diagnostics.map((diagnostic) => diagnostic.type),
    ["error"],
  );
  const message = record.diagnostics[0]?.message ?? "";
  assert.match(message, /failed to install and was skipped/);
  assert.match(message, /user settings/);
  // Captured git output makes the cause readable, not just "failed with code N".
  assert.match(message, /git .* failed with code \d+:\n/);
});

await test("a workspace with no packages has no failure record", async () => {
  const { agentDir, workspacePath } = await createFixture();
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const supervisor = new RuntimeSupervisor({ agentDir });

  const snapshot = await supervisor.getRuntimeSnapshot({
    workspaceId: "workspace-1",
    path: workspacePath,
  });

  assert.ok(!snapshot.extensions.some((extension) => extension.path === MISSING_PACKAGE));
});

await test("a new session reports a package that failed to install as a load diagnostic", async (t) => {
  const { agentDir, workspacePath } = await createFixture();

  const runtime = await createAgentSessionRuntimeWithNpmFallback({
    cwd: workspacePath,
    agentDir,
  });
  t.after(() => runtime.dispose());

  const diagnostic = runtime.diagnostics.find((entry) => entry.message.startsWith(MISSING_PACKAGE));
  assert.ok(diagnostic, "the install failure should reach the runtime diagnostics");
  assert.equal(diagnostic.type, "warning");
  assert.match(diagnostic.message, /failed to install/);
  assert.match(diagnostic.message, /fatal:/);
});
