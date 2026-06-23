import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveSourceRoot } from "./runtimeSettings.mjs";

const INITIAL_PATH_ENV = "CHATGPT_EXPORT_PICKER_INITIAL_PATH";

export async function pickNativeFolder({ initialPath, fallbackPath } = {}) {
  if (process.platform !== "win32") {
    throw new Error("Native folder picker is only available on Windows");
  }
  const selectedPath = await runWindowsFolderDialog(await resolveInitialFolder(initialPath, fallbackPath));
  if (!selectedPath) return { canceled: true };
  return { selectedPath: await resolveSourceRoot(selectedPath) };
}

async function resolveInitialFolder(initialPath, fallbackPath) {
  for (const candidate of [initialPath, fallbackPath, process.cwd()]) {
    const folder = await nearestExistingFolder(candidate);
    if (folder) return folder;
  }
  return process.cwd();
}

async function nearestExistingFolder(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  let current = path.resolve(candidate.trim());
  while (true) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) return current;
    } catch {
      // Walk upward until an existing parent can seed the OS dialog.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function runWindowsFolderDialog(initialPath) {
  const invocation = createWindowsFolderDialogInvocation(initialPath);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    const stdoutChunks = [];
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", () => {
      // Drain stderr so a localized PowerShell error cannot block process exit.
    });
    child.on("error", () => {
      reject(new Error("Native folder picker failed to start. Windows PowerShell is not available."));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString("utf8").trim());
      } else if (code === 2) {
        resolve(null);
      } else {
        reject(new Error(`Native folder picker failed to start. Restart the API server from an interactive Windows desktop session and try again. Exit code ${code}.`));
      }
    });
  });
}

export function createWindowsFolderDialogInvocation(initialPath) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select ChatGPT export source folder"
$dialog.ShowNewFolderButton = $false
$initialPath = [Environment]::GetEnvironmentVariable("${INITIAL_PATH_ENV}", "Process")
if ($initialPath) {
  $dialog.SelectedPath = $initialPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
  exit 0
}
exit 2
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    options: {
      windowsHide: false,
      env: {
        ...process.env,
        [INITIAL_PATH_ENV]: initialPath ?? ""
      }
    }
  };
}
