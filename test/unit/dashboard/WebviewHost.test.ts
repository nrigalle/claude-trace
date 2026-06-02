import { describe, it, expect } from "vitest";
import { WebviewHost } from "../../../src/features/dashboard/infra/WebviewHost";
import { Uri } from "../../stubs/vscode";
import type { WebviewToHost } from "../../../src/features/dashboard/protocol";

type RawListener = (raw: unknown) => void;

const makeFakePanel = () => {
  let onReceive: RawListener | null = null;
  const panel = {
    iconPath: undefined as unknown,
    visible: true,
    webview: {
      html: "",
      cspSource: "vscode-webview:",
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (cb: RawListener) => {
        onReceive = cb;
        return { dispose() {} };
      },
      postMessage: () => Promise.resolve(true),
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    reveal: () => {},
    dispose: () => {},
  };
  return { panel, fire: (raw: unknown) => onReceive?.(raw) };
};

const newHost = () => {
  const { panel, fire } = makeFakePanel();
  const host = new WebviewHost({
    extensionUri: Uri.file("/ext") as never,
    existingPanel: panel as never,
  });
  const received: WebviewToHost[] = [];
  host.onMessage((m) => received.push(m));
  return { fire, received };
};

describe("WebviewHost — inbound message allowlist", () => {
  it("forwards a known, well-formed message untouched", () => {
    const { fire, received } = newHost();
    fire({ type: "selectSession", sessionId: "s1" });
    expect(received).toEqual([{ type: "selectSession", sessionId: "s1" }]);
  });

  it("drops a forged message whose type is not on the allowlist", () => {
    const { fire, received } = newHost();
    fire({ type: "evilCommand", payload: "rm -rf" });
    fire({ type: "selectSession", sessionId: "ok" });
    expect(received).toEqual([{ type: "selectSession", sessionId: "ok" }]);
  });

  it("drops non-objects and messages with no type field", () => {
    const { fire, received } = newHost();
    fire(null);
    fire("not an object");
    fire(42);
    fire({ noType: true });
    fire({ type: 123 });
    expect(received).toEqual([]);
  });

  it("forwards every allowlisted message type", () => {
    const { fire, received } = newHost();
    const types: WebviewToHost["type"][] = [
      "ready",
      "selectSession",
      "renameSession",
      "resumeSession",
      "openMemoryFile",
      "openMemoryFolder",
      "openFile",
      "viewFileDiff",
      "exportChatMarkdown",
      "copyConversation",
      "togglePin",
      "saveDetailLayout",
    ];
    for (const type of types) fire({ type });
    expect(received.map((m) => m.type)).toEqual(types);
  });
});
