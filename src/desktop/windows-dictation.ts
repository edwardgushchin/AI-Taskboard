import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$operation = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
$action = $methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
$type = [Windows.Media.SpeechRecognition.SpeechRecognizer,Windows.Media.SpeechRecognition,ContentType=WindowsRuntime]
$language = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$compilation = [Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult,Windows.Media.SpeechRecognition,ContentType=WindowsRuntime]
$recognition = [Windows.Media.SpeechRecognition.SpeechRecognitionResult,Windows.Media.SpeechRecognition,ContentType=WindowsRuntime]
$engine = $type::new($language::new($env:AI_TASKBOARD_SPEECH_LOCALE))
try {
  $engine.Timeouts.InitialSilenceTimeout = [TimeSpan]::FromSeconds(15)
  $engine.Timeouts.EndSilenceTimeout = [TimeSpan]::FromSeconds(4)
  $compiled = $operation.MakeGenericMethod($compilation).Invoke($null, @($engine.CompileConstraintsAsync()))
  if ($compiled.GetAwaiter().GetResult().Status -ne 'Success') { throw 'Could not initialize speech recognition' }
  $result = $operation.MakeGenericMethod($recognition).Invoke($null, @($engine.RecognizeAsync()))
  if ($result.IsFaulted) { $result.GetAwaiter().GetResult() | Out-Null }
  [Console]::WriteLine('ready')
  $stdin = [Console]::OpenStandardInput()
  $command = $stdin.ReadAsync([byte[]]::new(1), 0, 1)
  while (!$result.IsCompleted -and !$command.IsCompleted) { Start-Sleep -Milliseconds 50 }
  if (!$result.IsCompleted) {
    $action.Invoke($null, @($engine.StopRecognitionAsync())).GetAwaiter().GetResult()
  }
  $text = $result.GetAwaiter().GetResult().Text
  [Console]::WriteLine('text ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$text)))
} finally {
  $engine.Dispose()
}
`;

export function startWindowsDictation(language: "en" | "ru") {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, AI_TASKBOARD_SPEECH_LOCALE: language === "ru" ? "ru-RU" : "en-US" },
  });
  child.stdin.on("error", () => {});
  const ready = Promise.withResolvers<boolean>();
  const result = Promise.withResolvers<string | undefined>();
  let transcript: string | undefined;
  let stopTimeout: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => child.kill(), 135_000);
  const startupTimeout = setTimeout(() => child.kill(), 8_000);
  const close = () => {
    clearTimeout(timeout);
    clearTimeout(startupTimeout);
    clearTimeout(stopTimeout);
    ready.resolve(false);
    result.resolve(transcript);
  };
  createInterface({ input: child.stdout }).on("line", line => {
    if (line === "ready") {
      clearTimeout(startupTimeout);
      ready.resolve(true);
    } else if (line.startsWith("text ")) {
      transcript = Buffer.from(line.slice(5), "base64").toString("utf8").trim();
    }
  });
  child.once("error", close);
  child.once("close", close);
  return {
    ready: ready.promise, result: result.promise,
    stop: () => {
      if (child.stdin.writableEnded || child.stdin.destroyed) return;
      stopTimeout = setTimeout(() => child.kill(), 4000);
      child.stdin.end("stop\n");
    },
    cancel: () => { child.kill(); },
  };
}
