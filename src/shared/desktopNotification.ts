export interface NotifyCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const escapeAppleScript = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export interface NotifyOptions {
  readonly alerterBin?: string | null;
  readonly terminalNotifierBin?: string | null;
  readonly iconPath?: string | null;
}

export const desktopNotifyCommand = (
  platform: NodeJS.Platform,
  title: string,
  message: string,
  opts: NotifyOptions = {},
): NotifyCommand | null => {
  const safeTitle = title.trim().length > 0 ? title : "Claude Trace";
  const safeMessage = message.trim().length > 0 ? message : safeTitle;
  if (platform === "darwin") {
    if (opts.alerterBin) {
      const args = ["--title", safeTitle, "--message", safeMessage, "--group", "claude-trace"];
      if (opts.iconPath) args.push("--app-icon", opts.iconPath);
      return { command: opts.alerterBin, args };
    }
    if (opts.terminalNotifierBin) {
      const args = [
        "-title",
        safeTitle,
        "-message",
        safeMessage,
        "-group",
        "claude-trace",
        "-ignoreDnD",
      ];
      if (opts.iconPath) args.push("-appIcon", opts.iconPath, "-contentImage", opts.iconPath);
      return { command: opts.terminalNotifierBin, args };
    }
    const script = `display notification "${escapeAppleScript(safeMessage)}" with title "${escapeAppleScript(safeTitle)}"`;
    return { command: "osascript", args: ["-e", script] };
  }
  if (platform === "linux") {
    return { command: "notify-send", args: [safeTitle, safeMessage] };
  }
  if (platform === "win32") {
    const esc = (v: string): string => v.replace(/'/g, "''");
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;",
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
      `$n = $t.GetElementsByTagName('text');`,
      `$n.Item(0).AppendChild($t.CreateTextNode('${esc(safeTitle)}')) > $null;`,
      `$n.Item(1).AppendChild($t.CreateTextNode('${esc(safeMessage)}')) > $null;`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($t);",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Trace').Show($toast);",
    ].join(" ");
    return { command: "powershell", args: ["-NoProfile", "-Command", script] };
  }
  return null;
};
