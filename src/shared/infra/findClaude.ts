import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const knownLocations = (): string[] => {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
};

export const findClaude = (): string | null => {
  for (const bin of knownLocations()) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {}
  }
  return null;
};
