import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { TerminalSession } from "../../../src/features/cockpit/protocol";
import { h } from "../ui/h.js";

const TERM_THEME: ITheme = {
  background: "#100f14",
  foreground: "#d6d6e0",
  cursor: "#e8956f",
  cursorAccent: "#100f14",
  selectionBackground: "rgba(217,119,87,0.32)",
  selectionInactiveBackground: "rgba(217,119,87,0.22)",
  selectionForeground: "#ffffff",
  black: "#1b1a22",
  red: "#e0795c",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c8c8d4",
  brightBlack: "#565666",
  brightRed: "#f08a6a",
  brightGreen: "#b9f27c",
  brightYellow: "#f2c88a",
  brightBlue: "#9bb8ff",
  brightMagenta: "#d2b8ff",
  brightCyan: "#a4dcff",
  brightWhite: "#ffffff",
};

export interface CockpitTerminalView {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly termHost: HTMLElement;
}

export interface CockpitTerminalCallbacks {
  readonly input: (data: string) => void;
  readonly bell: () => void;
  readonly focus: () => void;
  readonly dropImage: (fileName: string, dataBase64: string) => void;
}

export const createCockpitTerminal = (
  session: TerminalSession,
  callbacks: CockpitTerminalCallbacks,
): CockpitTerminalView => {
  const term = new Terminal({
    fontFamily: '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: false,
    theme: TERM_THEME,
    scrollback: 15000,
    scrollOnUserInput: false,
    allowProposedApi: true,
    altClickMovesCursor: false,
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon());
  wireOsc52(term);
  wireKeyboard(term, callbacks.input);
  const termHost = h("div", {
    className: "tc-term hidden",
    attrs: { role: "group", "aria-label": `${session.name} terminal` },
  });
  wireContextMenu(term, termHost);
  wirePaste(term, termHost);
  wireImageDrop(termHost, callbacks.dropImage);
  termHost.addEventListener("pointerdown", callbacks.focus);
  term.onData(callbacks.input);
  term.onBell(callbacks.bell);
  return { term, fit, termHost };
};

const decodeBase64 = (payload: string): string | null => {
  try {
    return atob(payload);
  } catch {
    return null;
  }
};

const fallbackCopy = (text: string): void => {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.left = "-10000px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
};

const clipboardApi = (): Clipboard | null =>
  "clipboard" in navigator ? navigator.clipboard : null;

const writeClipboard = (text: string): void => {
  const clipboard = clipboardApi();
  if (!clipboard) {
    fallbackCopy(text);
    return;
  }
  void clipboard.writeText(text).catch(() => fallbackCopy(text));
};

const readClipboard = (): Promise<string | null> =>
  clipboardApi()?.readText().catch(() => null) ?? Promise.resolve(null);

const wireOsc52 = (term: Terminal): void => {
  term.parser.registerOscHandler(52, (data: string) => {
    const semi = data.indexOf(";");
    if (semi < 0) return true;
    const payload = data.slice(semi + 1);
    if (payload === "?" || payload === "") return true;
    const text = decodeBase64(payload);
    if (text !== null) writeClipboard(text);
    return true;
  });
};

const wireKeyboard = (term: Terminal, input: (data: string) => void): void => {
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    const key = e.key.toLowerCase();
    if (e.metaKey && !e.ctrlKey && !e.altKey && key === "c") {
      const selection = term.getSelection();
      if (!selection) return true;
      writeClipboard(selection);
      e.preventDefault();
      return false;
    }
    if (e.metaKey && !e.ctrlKey && !e.altKey && key === "backspace") {
      input("\x15");
      e.preventDefault();
      return false;
    }
    return true;
  });
};

const wireContextMenu = (term: Terminal, host: HTMLElement): void => {
  host.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel && sel.length > 0) {
      writeClipboard(sel);
      return;
    }
    void pasteFromClipboard(term);
  });
};

const wirePaste = (term: Terminal, host: HTMLElement): void => {
  host.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      void pasteFromClipboard(term);
    },
    true,
  );
};

const pasteFromClipboard = async (term: Terminal): Promise<void> => {
  const text = await readClipboard();
  if (text === null) return;
  if (!text) return;
  term.paste(text);
};

const wireImageDrop = (
  host: HTMLElement,
  dropImage: (fileName: string, dataBase64: string) => void,
): void => {
  host.addEventListener("dragover", (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const hasFiles = Array.from(e.dataTransfer.items).some((i) => i.kind === "file");
    if (!hasFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    host.classList.add("tc-term-drop");
  });
  host.addEventListener("dragleave", () => host.classList.remove("tc-term-drop"));
  host.addEventListener("drop", (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    host.classList.remove("tc-term-drop");
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") return;
        const base64 = result.slice(result.indexOf(",") + 1);
        dropImage(file.name, base64);
      };
      reader.readAsDataURL(file);
    }
  });
};
