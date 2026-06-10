const assert = require("node:assert");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports.run = async () => {
  const vscode = require("vscode");

  const ext = vscode.extensions.getExtension("nrigalle.claude-trace");
  assert.ok(ext, "extension nrigalle.claude-trace must be installed in the dev host");

  await ext.activate();
  assert.ok(ext.isActive, "extension must activate without throwing (node-pty load, hooks, stores)");

  const commands = await vscode.commands.getCommands(true);
  for (const id of ["claudeTrace.openDashboard", "claudeTrace.showLog"]) {
    assert.ok(commands.includes(id), `command ${id} must be registered`);
  }

  await vscode.commands.executeCommand("claudeTrace.openDashboard");
  await sleep(1500);

  const tab = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => (t.label ?? "").toLowerCase().includes("claude trace"));
  assert.ok(tab, "the dashboard webview tab must open");

  console.log("smoke assertions passed: activate, commands, dashboard webview");
};
