#!/usr/bin/env node

// Integration test — spawns the MCP server and calls every tool via JSON-RPC over stdio.
// Requires RUNN_API_KEY in the environment. Not run in CI.
//
// Usage:
//   just integration
//   RUNN_API_KEY=xxx node test-integration.mjs

import { spawn } from "node:child_process";

const API_KEY = process.env.RUNN_API_KEY;
if (!API_KEY) {
  console.error("Set RUNN_API_KEY");
  process.exit(1);
}

const server = spawn("node", ["build/index.js"], {
  env: { ...process.env, RUNN_API_KEY: API_KEY },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let responseResolve = null;

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (responseResolve) {
          responseResolve(msg);
          responseResolve = null;
        }
      } catch {}
    }
  }
});

server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function send(msg) {
  return new Promise((resolve) => {
    responseResolve = resolve;
    server.stdin.write(JSON.stringify(msg) + "\n");
  });
}

let nextId = 1;
let passed = 0;
let failed = 0;

function ok(label, elapsed, extra) {
  passed++;
  const ms = elapsed != null ? ` (${elapsed}ms)` : "";
  console.log(`  PASS  ${label}${ms}${extra ? " — " + extra : ""}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label} — ${reason}`);
}

async function run() {
  // Initialize
  console.log("=== MCP HANDSHAKE ===");
  const initResp = await send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1.0.0" },
    },
  });
  console.log(
    `Server: ${initResp.result?.serverInfo?.name} v${initResp.result?.serverInfo?.version}`
  );

  // Send initialized notification (no response expected)
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  // List tools
  console.log("\n=== TOOLS ===");
  const toolsResp = await send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/list",
    params: {},
  });
  const tools = toolsResp.result?.tools || [];
  console.log(`Registered: ${tools.map((t) => t.name).join(", ")}`);

  // Helper to call a tool
  async function callTool(name, args = {}) {
    const start = Date.now();
    const resp = await send({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const elapsed = Date.now() - start;
    const isError = !!resp.result?.isError;
    const text = resp.result?.content?.[0]?.text;
    const data = !isError && text ? JSON.parse(text) : null;
    const kb = text ? (text.length / 1024).toFixed(1) + "KB" : null;
    return { elapsed, isError, text, data, kb };
  }

  // --- search_resources ---
  console.log("\n=== search_resources ===");

  let r = await callTool("search_resources", { query: "a", resourceType: "people" });
  let personIdForDetails = null;
  if (r.isError) fail("people search", r.text);
  else {
    personIdForDetails = r.data.people?.[0]?.id ?? null;
    ok("people search", r.elapsed, `${r.data.people?.length ?? 0} results ${r.kb}`);
  }

  r = await callTool("search_resources", { query: "a", resourceType: "projects" });
  if (r.isError) fail("project search", r.text);
  else ok("project search", r.elapsed, `${r.data.projects?.length ?? 0} results`);

  r = await callTool("search_resources", { query: "a", resourceType: "clients" });
  if (r.isError) fail("client search", r.text);
  else ok("client search", r.elapsed, `${r.data.clients?.length ?? 0} results`);

  r = await callTool("search_resources", { query: "zzzznonexistent99999" });
  if (r.isError) fail("no-match search", r.text);
  else {
    const total =
      (r.data.people?.length || 0) +
      (r.data.projects?.length || 0) +
      (r.data.clients?.length || 0);
    if (total === 0) ok("no-match search", r.elapsed, "0 results as expected");
    else fail("no-match search", `expected 0 results, got ${total}`);
  }

  // --- get_team_utilization ---
  console.log("\n=== get_team_utilization ===");

  r = await callTool("get_team_utilization");
  if (r.isError) fail("utilization (all)", r.text);
  else
    ok(
      "utilization (all)",
      r.elapsed,
      `${r.data.summary.totalPeople} people, avg ${r.data.summary.avgUtilizationPercent}% ${r.kb}`
    );

  // --- get_project_overview ---
  console.log("\n=== get_project_overview ===");

  r = await callTool("get_project_overview");
  if (r.isError) fail("projects (active)", r.text);
  else {
    const nullPricing = r.data.projects.filter((p) => p.pricingModel === null).length;
    ok(
      "projects (active/default)",
      r.elapsed,
      `${r.data.totalProjects} projects, ${nullPricing} null-pricing ${r.kb}`
    );
  }

  r = await callTool("get_project_overview", { status: "tentative" });
  if (r.isError) fail("projects (tentative)", r.text);
  else ok("projects (tentative)", r.elapsed, `${r.data.totalProjects} projects`);

  r = await callTool("get_project_overview", { status: "archived" });
  if (r.isError) fail("projects (archived)", r.text);
  else ok("projects (archived)", r.elapsed, `${r.data.totalProjects} projects`);

  r = await callTool("get_project_overview", { status: "all" });
  if (r.isError) fail("projects (all)", r.text);
  else ok("projects (all)", r.elapsed, `${r.data.totalProjects} projects ${r.kb}`);

  // --- get_capacity_forecast ---
  console.log("\n=== get_capacity_forecast ===");

  r = await callTool("get_capacity_forecast", { weeksAhead: 4 });
  if (r.isError) fail("forecast (4w)", r.text);
  else
    ok(
      "forecast (4w)",
      r.elapsed,
      `${r.data.totalPeople} people, ${r.data.currentlyUnassigned} unassigned ${r.kb}`
    );

  r = await callTool("get_capacity_forecast");
  if (r.isError) fail("forecast (default 8w)", r.text);
  else ok("forecast (default 8w)", r.elapsed, `${r.data.weeklyBuckets.length} buckets`);

  // --- get_person_details ---
  console.log("\n=== get_person_details ===");

  if (personIdForDetails) {
    r = await callTool("get_person_details", { personId: personIdForDetails });
    if (r.isError) fail(`person ${personIdForDetails}`, r.text);
    else
      ok(
        `person ${personIdForDetails}`,
        r.elapsed,
        `${r.data.name}, ${r.data.skills.length} skills, ${r.data.assignments.length} assignments`
      );
  }

  r = await callTool("get_person_details", { personId: 999999 });
  if (r.isError) ok("invalid person (expected error)", r.elapsed);
  else fail("invalid person", "expected error but got success");

  // --- Summary ---
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => {
  console.error("TIMEOUT (120s)");
  server.kill();
  process.exit(1);
}, 120_000);

run().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
