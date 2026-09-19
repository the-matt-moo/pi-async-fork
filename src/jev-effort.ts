/**
 * Jev Choice–based effort tier suggestion for async forks.
 * Classifies a task description into fast | balanced | deep using TypeSafe System One.
 * Falls back to "balanced" on error or missing API key.
 */

import { execFile } from "node:child_process";
import type { Tier } from "./configuration.js";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CREDENTIAL_TARGET = "pi-bifrost/jev-api-key";
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

const TIER_CRITERIA: Record<Tier, string> = {
  fast:
    "Bounded read-only evidence gathering: lookups, codebase exploration, documentation or web research, exact checks, inventories, and source or relationship tracing. Returns facts without final judgments, recommendations, or changes.",
  balanced:
    "Bounded judgment or settled execution: review, plan validation, test interpretation, bounded diagnosis, research synthesis, implementation planning, and scoped changes.",
  deep:
    "Frontier uncertainty or the hardest reasoning: novel architecture, unclear root causes, conflicting evidence, difficult security or data analysis, complex system behavior, major product decisions, broad blast radius, and hard-to-reverse choices.",
};

export interface JevEffortOptions {
  /** API key for TypeSafe. If omitted, reads from Windows Credential Manager. */
  apiKey?: string;
  /** Credential Manager target. Default: `pi-bifrost/jev-api-key`. */
  credentialTarget?: string;
  /** Jev model reference. Default: `jev-latest`. */
  model?: string;
  /** Request timeout in ms. Default: 5000. */
  timeoutMs?: number;
  /** Minimum confidence to accept Jev's answer. Default: 0.5. */
  confidenceThreshold?: number;
  /** Custom fetch for testing. */
  fetch?: typeof globalThis.fetch;
  /** Custom credential reader for testing. */
  readCredential?: (target: string) => Promise<string | undefined>;
}

export interface JevEffortResult {
  tier: Tier;
  source: "jev" | "default";
  confidence?: number;
}

/**
 * Suggest an effort tier for a fork task using Jev Choice.
 * Returns "balanced" as the default fallback.
 */
export async function suggestEffort(
  task: string,
  options: JevEffortOptions = {},
): Promise<JevEffortResult> {
  if (!task.trim()) {
    return { tier: "balanced", source: "default" };
  }

  try {
    const apiKey =
      options.apiKey ??
      (await (options.readCredential ?? readWindowsCredential)(
        options.credentialTarget ?? DEFAULT_CREDENTIAL_TARGET,
      ));

    if (!apiKey) {
      return { tier: "balanced", source: "default" };
    }

    const result = await classifyWithJev(task, apiKey, options);
    if (result) return result;
  } catch {
    // Jev unavailable — silent fallback
  }

  return { tier: "balanced", source: "default" };
}

async function classifyWithJev(
  task: string,
  apiKey: string,
  options: JevEffortOptions,
): Promise<JevEffortResult | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const body = {
    state: task.length > 2000 ? task.slice(0, 2000) : task,
    model,
    questions: {
      effort: {
        type: "choice" as const,
        instructions:
          "Classify the cognitive effort required for this coding-agent task. Pick the lowest tier that can reliably complete it.",
        criteria: TIER_CRITERIA,
      },
    },
  };

  const response = await fetchFn(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) return undefined;

  const data = (await response.json()) as {
    answers?: {
      effort?: { choice?: string; confidence?: number };
    };
  };

  const answer = data.answers?.effort;
  if (!answer?.choice) return undefined;

  const tier = answer.choice as Tier;
  if (!(tier in TIER_CRITERIA)) return undefined;

  if (answer.confidence !== undefined && answer.confidence < threshold) {
    return undefined;
  }

  return { tier, source: "jev", confidence: answer.confidence };
}

// ---------- Windows Credential Manager ----------

const CREDENTIAL_SCRIPT = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;

public static class ForkCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 reserved, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr credential);

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new InvalidOperationException("Credential Manager read failed.");
    }

    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      return credential.CredentialBlobSize == 0
        ? ""
        : Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    }
    finally {
      CredFree(pointer);
    }
  }
}
'@
Add-Type -TypeDefinition $source
$value = [ForkCredential]::Read($env:FORK_CREDENTIAL_TARGET)
if ($null -eq $value) { exit 3 }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
`;

const encodedScript = Buffer.from(CREDENTIAL_SCRIPT, "utf16le").toString("base64");
const credentialCache = new Map<string, string>();

async function readWindowsCredential(target: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !target.trim()) return undefined;
  const cached = credentialCache.get(target);
  if (cached !== undefined) return cached;

  const encoded = await new Promise<string | undefined>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          ComSpec: process.env.ComSpec,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          FORK_CREDENTIAL_TARGET: target,
        },
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          if ("code" in error && error.code === 3) resolve(undefined);
          else reject(new Error(`Unable to read Windows credential "${target}".`));
          return;
        }
        resolve(stdout.trim() || undefined);
      },
    );
  });

  if (!encoded) return undefined;
  const value = Buffer.from(encoded, "base64").toString("utf8");
  credentialCache.set(target, value);
  return value;
}
