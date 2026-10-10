#!/usr/bin/env node
// The no-bloat report, written once (capsid/research/design-shared-tests.md section 3, D3 and D4 of job_bf31c124055e). Knip
// for unused files, exports and dependencies, jscpd for duplicated blocks, each count compared with the repository's own
// baseline, and what grew said as a ::warning:: line and a table in the job summary.
//
// WARN-ONLY by ruling: a number nobody has acted on is information, not a rule. It exits 0 whatever it finds, and a tool
// that cannot run is a warning naming its error, never a silent pass. Base: capsid's scripts/no-bloat-report.mjs, with the
// runs and the baseline read from the repository's config instead of written into the script.
//
//   npx devkit-no-bloat                      report against .no-bloat.json (no file: one knip run, jscpd on its own config)
//   npx devkit-no-bloat --config <file>      another config
//   npx devkit-no-bloat --write-baseline     measure and record the counts as the config's baseline
//
// The config, every field optional:
//
//   {
//     "knip": [{ "label": "knip (Worker)" }, { "label": "knip (dashboard)", "args": ["--directory", "dashboard"] }],
//     "jscpd": { "args": ["app", "workers", "--min-lines", "8"] },
//     "tools": { "knip": "knip@6", "jscpd": "jscpd@4" },
//     "baseline": { "measured_at": "036d615", "knip (Worker)": { "Unused exports": 12 }, "jscpd": { "clones": 23, "percentage": 0.59 } }
//   }
//
// A tool the repository installs is run from node_modules/.bin; otherwise through npx at the spec in `tools`.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TOOLS = { knip: "knip@6", jscpd: "jscpd@4" };

/**
 * @typedef {{ label: string, args?: string[] }} KnipRun
 * @typedef {{ knip?: KnipRun[], jscpd?: { args?: string[] } | false, tools?: { knip?: string, jscpd?: string },
 *   baseline?: Record<string, unknown> & { measured_at?: string } }} Config
 * @typedef {(name: "knip" | "jscpd", args: string[]) => string} Runner
 * @typedef {Record<string, Record<string, number>>} Counts
 */

/** Knip's compact report as counts per heading, e.g. { "Unused exports": 12 }. */
export function knipCounts(/** @type {string} */ text) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const m of text.matchAll(/^([A-Z][A-Za-z ]+) \((\d+)\)$/gm)) counts[m[1]] = Number(m[2]);
  return counts;
}

/**
 * Runs every tool the config names and returns the counts, keyed as the baseline is, and a warning for each tool that could
 * not run.
 * @param {Config} config
 * @param {Runner} run
 * @param {boolean} [jscpdConfigured] whether the repository has its own .jscpd.json, which then names the paths
 * @returns {{ counts: Counts, warnings: string[] }}
 */
export function measure(config, run, jscpdConfigured = true) {
  /** @type {Counts} */
  const counts = {};
  const warnings = [];

  for (const { label, args = [] } of config.knip ?? [{ label: "knip" }]) {
    try {
      counts[label] = knipCounts(run("knip", [...args, "--no-exit-code", "--no-progress", "--reporter", "compact"]));
    } catch (error) {
      warnings.push(`${label} could not run: ${messageOf(error)}`);
    }
  }

  if (config.jscpd !== false) {
    const own = config.jscpd?.args ?? [];
    // jscpd with no path and no config of its own scans nothing; the repository root is the honest default.
    const paths = own.length === 0 && !jscpdConfigured ? ["."] : [];
    const out = mkdtempSync(join(tmpdir(), "jscpd-"));
    try {
      run("jscpd", [...own, ...paths, "--reporters", "json", "--output", out, "--silent"]);
      const total = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")).statistics.total;
      counts.jscpd = { clones: total.clones, percentage: Number(Number(total.percentage).toFixed(2)) };
    } catch (error) {
      warnings.push(`jscpd could not run: ${messageOf(error)}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  return { counts, warnings };
}

/**
 * One row per finding the baseline or the measurement names, and a warning for each that grew. A finding with no baseline
 * is a row and never a warning: there is nothing to have grown from.
 * @param {Record<string, unknown>} baseline
 * @param {Counts} counts
 * @param {KnipRun[]} [knipRuns]
 */
export function compare(baseline, counts, knipRuns = [{ label: "knip" }]) {
  /** @type {Array<[string, string, number | null, number]>} */
  const rows = [];
  const warnings = [];
  const before = (/** @type {string} */ tool) => /** @type {Record<string, number> | null} */ (tool in baseline ? baseline[tool] : null);

  for (const [tool, now] of Object.entries(counts)) {
    if (tool === "jscpd") continue;
    const was = before(tool);
    const keys = [...new Set([...Object.keys(was ?? {}), ...Object.keys(now)])];
    // A clean run is a row too, so the table shows the tool ran.
    if (keys.length === 0) rows.push([tool, "findings", was ? 0 : null, 0]);
    for (const key of keys) {
      const a = was ? (was[key] ?? 0) : null;
      const b = now[key] ?? 0;
      rows.push([tool, key, a, b]);
      if (a !== null && b > a) {
        const args = knipRuns.find((r) => r.label === tool)?.args ?? [];
        warnings.push(`${tool}: ${key} went from ${a} to ${b}. Run \`npx knip${args.length ? ` ${args.join(" ")}` : ""}\` to see which.`);
      }
    }
  }

  if (counts.jscpd) {
    const was = before("jscpd");
    const now = counts.jscpd;
    rows.push(["jscpd", "clones", was ? (was.clones ?? 0) : null, now.clones]);
    rows.push(["jscpd", "duplicated lines %", was ? (was.percentage ?? 0) : null, now.percentage]);
    if (was && now.clones > (was.clones ?? 0)) {
      warnings.push(`jscpd: clones went from ${was.clones ?? 0} to ${now.clones} (${now.percentage}% of lines, baseline ${was.percentage ?? 0}%). Run \`npx jscpd\` to see them.`);
    }
  }
  return { rows, warnings };
}

/**
 * The job summary table.
 * @param {Array<[string, string, number | null, number]>} rows
 * @param {string[]} warnings
 * @param {string | undefined} measuredAt
 */
export function render(rows, warnings, measuredAt) {
  const show = (/** @type {number | null} */ n) => (n === null ? "none" : String(n));
  return [
    `### No-bloat report (warn-only; ${measuredAt ? `baseline ${measuredAt}` : "no baseline yet: run `npx devkit-no-bloat --write-baseline`"})`,
    "",
    "| Tool | Finding | Baseline | Now |",
    "|---|---|---|---|",
    ...rows.map(([tool, key, a, b]) => `| ${tool} | ${key} | ${show(a)} | ${b}${a !== null && b > a ? " (up)" : ""} |`),
    "",
    warnings.length ? warnings.map((w) => `- ${w}`).join("\n") : "Nothing grew past the baseline.",
  ].join("\n");
}

/** Runs a tool from the repository's node_modules/.bin when it is installed there, through npx at `spec` otherwise. */
export function runnerIn(/** @type {string} */ root, /** @type {{ knip: string, jscpd: string }} */ tools) {
  /** @type {Runner} */
  return (name, args) => {
    const local = join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
    const [file, argv] = existsSync(local) ? [local, args] : ["npx", ["--yes", tools[name], ...args]];
    // A .cmd shim (and npx itself) on Windows needs cmd.exe; elsewhere the bin runs directly.
    const [cmd, all] = process.platform === "win32" ? ["cmd.exe", ["/c", file, ...argv]] : [file, argv];
    const r = spawnSync(cmd, all, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return r.stdout;
  };
}

function messageOf(/** @type {unknown} */ error) {
  return error instanceof Error ? error.message : String(error);
}

function shortHead(/** @type {string} */ root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--config");
  const root = process.cwd();
  const file = resolve(root, at >= 0 && argv[at + 1] ? argv[at + 1] : ".no-bloat.json");
  const write = argv.includes("--write-baseline");

  /** @type {Config} */
  let config = {};
  const warnings = [];
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (write) {
        console.error(`devkit-no-bloat: ${file} is not JSON: ${messageOf(error)}`);
        process.exit(1);
      }
      warnings.push(`${file} is not JSON (${messageOf(error)}); measured with the defaults and no baseline.`);
    }
  }

  const measured = measure(config, runnerIn(root, { ...DEFAULT_TOOLS, ...config.tools }), existsSync(join(root, ".jscpd.json")));

  if (write) {
    if (measured.warnings.length) {
      for (const w of measured.warnings) console.error(`devkit-no-bloat: ${w}`);
      console.error("devkit-no-bloat: the baseline was not written, because a tool could not run.");
      process.exit(1);
    }
    config.baseline = { measured_at: shortHead(root), ...measured.counts };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`devkit-no-bloat: wrote the baseline to ${file}`);
    return;
  }

  const baseline = config.baseline ?? {};
  const { rows, warnings: grew } = compare(baseline, measured.counts, config.knip);
  warnings.push(...measured.warnings, ...grew);
  const table = render(rows, warnings, config.baseline?.measured_at);
  console.log(table);
  for (const w of warnings) console.log(`::warning::${w}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}

// Run through node_modules/.bin, argv[1] is the link and import.meta.url the file it points to.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
