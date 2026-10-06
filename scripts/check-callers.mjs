#!/usr/bin/env node
// The check a caller of the shared improve-score workflow runs on its own workflow files:
//
//   node check-callers.mjs .github/workflows/improve-score.yml [more files]
//
// Every `uses:` that names this repository's reusable workflows must end in `@` and a full 40-character commit sha. A branch
// or a tag moves under a caller without a reviewed change to the caller, which is the property the shared scorer exists to
// keep: the file that measures an attempt changes only when a reviewed pull request changes the sha. `secrets: inherit` is
// refused too, because the key is passed by name so a reader can see exactly what the shared file receives.
//
// Exit 0 when every call is pinned, 1 when any is not, 2 when a file is unreadable or names no call at all.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHARED = /^\s*uses:\s*(?<repo>[\w.-]+)\/renovate-config\/\.github\/workflows\/(?<file>[\w.-]+)@(?<ref>\S+)/;

/**
 * @param {string} text
 * @returns {{ line: number, problem: string }[]}
 */
export function callerProblems(text) {
  /** @type {{ line: number, problem: string }[]} */
  const problems = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let calls = 0;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "");
    const call = SHARED.exec(line);
    if (call?.groups) {
      calls += 1;
      if (!/^[0-9a-f]{40}$/.test(call.groups.ref)) {
        problems.push({ line: index + 1, problem: `pinned to "${call.groups.ref}", not a full 40-character commit sha` });
      }
    }
    if (/^\s*secrets:\s*inherit\s*$/.test(line)) {
      problems.push({ line: index + 1, problem: "secrets: inherit hides what the shared workflow receives; pass IMPROVE_SCORE_KEY by name" });
    }
  });
  if (calls === 0) problems.push({ line: 0, problem: "no call to a renovate-config reusable workflow" });
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: check-callers.mjs <workflow file>...");
    process.exit(2);
  }
  let status = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      console.error(`${file}: cannot read: ${error instanceof Error ? error.message : error}`);
      process.exit(2);
    }
    const problems = callerProblems(text);
    for (const { line, problem } of problems) console.error(`${file}${line ? `:${line}` : ""}: ${problem}`);
    if (problems.some((p) => p.line === 0)) status = Math.max(status, 2);
    else if (problems.length > 0) status = Math.max(status, 1);
    else console.log(`${file}: ok`);
  }
  process.exit(status);
}
