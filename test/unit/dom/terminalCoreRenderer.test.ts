import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const canvasInstances: object[] = [];
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    constructor() {
      canvasInstances.push(this);
    }
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

const SOFTWARE_GL = {
  RENDERER: 0,
  getExtension: (name: string): unknown =>
    name === "WEBGL_debug_renderer_info"
      ? { UNMASKED_RENDERER_WEBGL: 1 }
      : name === "WEBGL_lose_context"
        ? { loseContext: (): void => {} }
        : null,
  getParameter: (): string =>
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
};
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => SOFTWARE_GL;

const { webglUsable, attachCanvasRenderer } = await import("../../../media/src/cockpit/terminalCore");

describe("terminalCore renderer selection on a software-GL webview (Cursor / SwiftShader-Subzero)", () => {
  it("reports WebGL unusable for the SwiftShader/Subzero renderer that breaks typing (xterm.js #4665, vscode #190195)", () => {
    expect(webglUsable()).toBe(false);
  });

  it("attaches the canvas renderer as the fallback (VS Code's fix), never leaving the slow DOM renderer", () => {
    const before = canvasInstances.length;
    const loaded: object[] = [];
    const term = { loadAddon: (addon: object) => loaded.push(addon) } as unknown as Terminal;
    const handle = attachCanvasRenderer(term);
    expect(handle).not.toBeNull();
    expect(canvasInstances.length).toBe(before + 1);
    expect(loaded.length).toBe(1);
  });
});
