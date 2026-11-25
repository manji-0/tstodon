#!/usr/bin/env node
// Runs the performance benchmark (packages/worker/server/perf.bench.test.ts)
// and prints its results as a Markdown table. See
// docs/architecture/d1-heavy-scenarios.md#benchmark.
//
//   pnpm bench                          build, seed the full dataset, 7 runs per request
//   pnpm bench --scale 0.1 --runs 3     a tenth of the data, quicker
//   pnpm bench --no-build --plan        reuse dist/, print query plans
//   pnpm bench --analyze                run ANALYZE after seeding (planner statistics)
//   pnpm bench --json out.json          also write the parsed results
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    scale: { type: "string", default: "1" },
    runs: { type: "string", default: "7" },
    plan: { type: "boolean", default: false },
    analyze: { type: "boolean", default: false },
    build: { type: "boolean", default: true },
    json: { type: "string" },
    log: { type: "string" },
  },
  allowNegative: true,
});

if (values.build) {
  const built = spawnSync("pnpm", ["exec", "vp", "-C", "packages/worker", "build"], {
    stdio: "inherit",
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const child = spawn(
  "pnpm",
  ["exec", "vp", "test", "run", "--project", "worker", "perf.bench", "--silent=false"],
  {
    env: {
      ...process.env,
      BENCH: "1",
      BENCH_SCALE: values.scale,
      BENCH_RUNS: values.runs,
      BENCH_PLAN: values.plan ? "1" : "",
      BENCH_ANALYZE: values.analyze ? "1" : "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
const code = await new Promise((resolve) => child.on("close", resolve));
if (values.log) writeFileSync(values.log, output);

const lines = output.split("\n").filter((line) => line.startsWith("BENCH_"));
const result = { seed: undefined, counts: {}, rows: [], top: [], plans: [] };
for (const line of lines) {
  const [kind, ...fields] = line.split("|");
  if (kind === "BENCH_SEED")
    result.seed = { seconds: Number(fields[0]), shape: JSON.parse(fields[1]) };
  if (kind === "BENCH_COUNT") result.counts[fields[0]] = Number(fields[1]);
  if (kind === "BENCH_ROW") {
    const [label, status, runs, p50, p95, statements, rounds, rowsRead, rowsWritten, deferred] =
      fields;
    result.rows.push({
      label,
      status,
      runs: Number(runs),
      p50: Number(p50),
      p95: Number(p95),
      statements: Number(statements),
      rounds: Number(rounds),
      rowsRead: Number(rowsRead),
      rowsWritten: Number(rowsWritten),
      deferred: Number(deferred),
    });
  }
  if (kind === "BENCH_TOP") {
    const [label, read, written, times, ...sql] = fields;
    result.top.push({
      label,
      read: Number(read),
      written: Number(written),
      times: Number(times),
      sql: sql.join("|"),
    });
  }
  if (kind === "BENCH_PLAN") {
    const [label, sql, ...detail] = fields;
    result.plans.push({ label, sql, detail: detail.join("|") });
  }
}

if (result.seed) {
  console.log(`Seeded in ${result.seed.seconds} s: ${JSON.stringify(result.counts)}\n`);
}
console.log(
  "| Request | Status | Runs | p50 ms | p95 ms | Statements | Rounds | Rows read | Rows written |",
);
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of result.rows) {
  console.log(
    `| ${row.label} | ${row.status} | ${row.runs} | ${row.p50} | ${row.p95} | ${row.statements}${row.deferred ? ` (+${row.deferred})` : ""} | ${row.rounds} | ${row.rowsRead} | ${row.rowsWritten} |`,
  );
}
console.log("\nCostliest statements (rows read, rows written, executions):");
for (const top of result.top) {
  console.log(
    `- ${top.label}: ${top.read} / ${top.written} / ${top.times}x ${top.sql.slice(0, 160)}`,
  );
}
if (result.plans.length > 0) {
  console.log("\nPlans:");
  for (const plan of result.plans) console.log(`- ${plan.label} [${plan.sql}] ${plan.detail}`);
}
if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
if (result.rows.length === 0) {
  console.error("No BENCH_ROW lines: the benchmark did not run (see --log).");
  process.exit(typeof code === "number" && code !== 0 ? code : 1);
}
process.exit(typeof code === "number" ? code : 1);
