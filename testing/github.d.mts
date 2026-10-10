/** The sha git gives `content` as a blob. The header counts UTF-8 bytes, not string length. */
export function gitBlobSha(content: string): Promise<string>;

export type RecordedCall = {
  method: string;
  path: string;
  body: unknown;
};

export type HistoryEntry = { sha: string; message: string; author: string; date: string };

export type GitHubStub = {
  calls: RecordedCall[];
  files: Map<string, string>;
  /** What the commits-for-a-path listing answers (newest first), whatever the path. */
  history: HistoryEntry[];
  /** Fail the next `times` requests whose path contains `fragment`, with a 500. */
  failNext: (fragment: string, times: number) => void;
  /** The fake itself, for code that takes a fetch rather than reading the global. */
  fetch: typeof fetch;
  /** Puts back the global fetch the stub replaced. A no-op when it was created with `install: false`. */
  restore: () => void;
};

/**
 * Stands up the fake for one repository. Installed as the global fetch unless `install` is false. An unknown host or
 * route throws; blob shas are real.
 */
export function stubGitHub(options: {
  owner: string;
  repo: string;
  /** Default `main`. */
  branch?: string;
  /** Path to content, the repository's files when the case starts. */
  files?: Record<string, string>;
  /** Default true. */
  install?: boolean;
}): GitHubStub;

/** The blob sha of a file as the stub holds it now. */
export function versionOf(stub: Pick<GitHubStub, "files">, path: string): Promise<string>;
