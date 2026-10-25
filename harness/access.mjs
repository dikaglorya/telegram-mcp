#!/usr/bin/env node
/**
 * MCP stdio harness for access profiles and approvals.
 *
 * Proves:
 *   1. readonly profile denies telegram_send_message before any Telegram call
 *   2. messaging profile passes profile check, reaches NO_SESSION
 *   3. approval mode returns APPROVAL_REQUIRED, CLI approval then permits retry
 *
 * Uses fake API creds and a sandbox state dir.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distIndex = path.join(root, "dist", "index.js");

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgmcp-access-"));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function startServer(env) {
  return spawn("node", [distIndex], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForInit(server) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("serving over stdio") || stderr.includes("not configured")) {
        resolve();
      }
    });
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`server exited with ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error("server init timeout")), 5000);
  });
}

function callTool(server, name, args, id = 1) {
  return new Promise((resolve) => {
    const request = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line);
          if (res.id === id) {
            server.stdout.off("data", onData);
            resolve(res);
            return;
          }
        } catch {
          // not a complete JSON line yet
        }
      }
    };
    server.stdout.on("data", onData);
    server.stdin.write(request + "\n");
    setTimeout(() => {
      server.stdout.off("data", onData);
      resolve({ error: { message: "timeout" } });
    }, 5000);
  });
}

async function run() {
  const sandbox = makeSandbox();
  console.log(`Sandbox: ${sandbox}`);

  try {
    // ---- Test 1: readonly denies telegram_send_message before Telegram ----
    console.log("\n=== Test 1: readonly profile denies write ===");
    const env1 = {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test-hash",
      TELEGRAM_STATE_DIR: sandbox,
      TELEGRAM_ACCESS_PROFILE: "readonly",
    };
    const s1 = startServer(env1);
    await waitForInit(s1);
    const res1 = await callTool(s1, "telegram_send_message", { chat: "me", text: "hello" });
    s1.kill();

    if (res1.error?.code === "PERMISSION_DENIED" || res1.result?.isError) {
      const text = res1.result?.content?.[0]?.text ?? JSON.stringify(res1.error);
      if (text.includes("PERMISSION_DENIED") && text.includes("readonly")) {
        console.log("✅ readonly denied telegram_send_message before Telegram");
        console.log(`   Response: ${text.split("\n")[0]}`);
      } else {
        console.log("❌ unexpected error:", text);
        process.exit(1);
      }
    } else {
      console.log("❌ expected PERMISSION_DENIED, got:", JSON.stringify(res1));
      process.exit(1);
    }

    // ---- Test 2: messaging profile passes profile check, reaches NO_SESSION ----
    console.log("\n=== Test 2: messaging profile passes, hits NO_SESSION ===");
    const env2 = {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test-hash",
      TELEGRAM_STATE_DIR: sandbox,
      TELEGRAM_ACCESS_PROFILE: "messaging",
    };
    const s2 = startServer(env2);
    await waitForInit(s2);
    const res2 = await callTool(s2, "telegram_send_message", { chat: "me", text: "hello" });
    s2.kill();

    if (res2.result?.isError) {
      const text = res2.result.content[0].text;
      if (text.includes("NO_SESSION") || text.includes("NOT_AUTHORIZED") || text.includes("not authorized")) {
        console.log("✅ messaging passed profile, failed at auth (NO_SESSION)");
        console.log(`   Response: ${text.split("\n")[0]}`);
      } else {
        console.log("❌ unexpected error:", text);
        process.exit(1);
      }
    } else {
      console.log("❌ expected auth error, got:", JSON.stringify(res2));
      process.exit(1);
    }

    // ---- Test 3: approval mode destructive requires approval ----
    console.log("\n=== Test 3: approval mode=destructive requires approval ===");
    const env3 = {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test-hash",
      TELEGRAM_STATE_DIR: sandbox,
      TELEGRAM_ACCESS_PROFILE: "full",
      TELEGRAM_APPROVAL_MODE: "destructive",
    };
    const s3 = startServer(env3);
    await waitForInit(s3);

    // Call a destructive tool (telegram_delete_chat)
    const res3a = await callTool(s3, "telegram_delete_chat", { chat: "test" });
    if (res3a.error?.code === "APPROVAL_REQUIRED" || res3a.result?.isError) {
      const text = res3a.result?.content?.[0]?.text ?? JSON.stringify(res3a.error);
      if (text.includes("APPROVAL_REQUIRED")) {
        const match = text.match(/approval_id: ([a-f0-9]+)/);
        const approvalId = match ? match[1] : null;
        console.log("✅ approval required for destructive tool");
        console.log(`   Approval ID: ${approvalId}`);

        // Now approve it via CLI
        if (approvalId) {
          const { spawnSync } = await import("node:child_process");
          const approve = spawnSync("node", [path.join(root, "dist/cli/approvals.js"), "approve", approvalId], {
            env: { ...process.env, TELEGRAM_STATE_DIR: sandbox },
            encoding: "utf8",
          });
          if (approve.status !== 0) {
            console.log("❌ approve CLI failed:", approve.stderr);
            process.exit(1);
          }
          console.log("✅ CLI approve succeeded");

          // Retry the call - should now pass profile, hit NO_SESSION
          const res3b = await callTool(s3, "telegram_delete_chat", { chat: "test" }, 2);
          s3.kill();

          if (res3b.result?.isError) {
            const text = res3b.result.content[0].text;
            if (text.includes("NO_SESSION") || text.includes("NOT_AUTHORIZED")) {
              console.log("✅ after approval, call reaches NO_SESSION (expected)");
              console.log(`   Response: ${text.split("\n")[0]}`);
            } else {
              console.log("❌ unexpected error after approval:", text);
              process.exit(1);
            }
          } else {
            console.log("❌ expected NO_SESSION after approval, got success");
            process.exit(1);
          }
        }
      } else {
        console.log("❌ unexpected error:", text);
        process.exit(1);
      }
    } else {
      console.log("❌ expected APPROVAL_REQUIRED, got:", JSON.stringify(res3a));
      process.exit(1);
    }

    // ---- Test 4: approval mode=writes requires approval for any write ----
    console.log("\n=== Test 4: approval mode=writes requires approval for any write ===");
    const env4 = {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test-hash",
      TELEGRAM_STATE_DIR: sandbox,
      TELEGRAM_ACCESS_PROFILE: "full",
      TELEGRAM_APPROVAL_MODE: "writes",
    };
    const s4 = startServer(env4);
    await waitForInit(s4);

    // Call a non-destructive write (telegram_send_message)
    const res4a = await callTool(s4, "telegram_send_message", { chat: "me", text: "hello" });
    if (res4a.error?.code === "APPROVAL_REQUIRED" || res4a.result?.isError) {
      const text = res4a.result?.content?.[0]?.text ?? JSON.stringify(res4a.error);
      if (text.includes("APPROVAL_REQUIRED")) {
        const match = text.match(/approval_id: ([a-f0-9]+)/);
        const approvalId = match ? match[1] : null;
        console.log("✅ approval required for write in 'writes' mode");
        console.log(`   Approval ID: ${approvalId}`);

        // Approve via CLI
        if (approvalId) {
          const { spawnSync } = await import("node:child_process");
          const approve = spawnSync("node", [path.join(root, "dist/cli/approvals.js"), "approve", approvalId], {
            env: { ...process.env, TELEGRAM_STATE_DIR: sandbox },
            encoding: "utf8",
          });
          if (approve.status !== 0) {
            console.log("❌ approve CLI failed:", approve.stderr);
            process.exit(1);
          }
          console.log("✅ CLI approve succeeded");

          // Retry - should reach NO_SESSION
          const res4b = await callTool(s4, "telegram_send_message", { chat: "me", text: "hello" }, 2);
          s4.kill();

          if (res4b.result?.isError) {
            const text = res4b.result.content[0].text;
            if (text.includes("NO_SESSION")) {
              console.log("✅ after approval, call reaches NO_SESSION");
            } else {
              console.log("❌ unexpected:", text);
              process.exit(1);
            }
          } else {
            console.log("❌ expected NO_SESSION");
            process.exit(1);
          }
        }
      } else {
        console.log("❌ unexpected error:", text);
        process.exit(1);
      }
    } else {
      console.log("❌ expected APPROVAL_REQUIRED for write in writes mode");
      process.exit(1);
    }

    // ---- Test 5: denied approval is final ----
    console.log("\n=== Test 5: denied approval is final ===");
    const env5 = {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test-hash",
      TELEGRAM_STATE_DIR: sandbox,
      TELEGRAM_ACCESS_PROFILE: "full",
      TELEGRAM_APPROVAL_MODE: "destructive",
    };
    const s5 = startServer(env5);
    await waitForInit(s5);

    const res5a = await callTool(s5, "telegram_delete_chat", { chat: "test" });
    const text5a = res5a.result?.content?.[0]?.text ?? "";
    const match5 = text5a.match(/approval_id: ([a-f0-9]+)/);
    const approvalId5 = match5 ? match5[1] : null;

    if (approvalId5) {
      // Deny it
      const { spawnSync } = await import("node:child_process");
      const deny = spawnSync("node", [path.join(root, "dist/cli/approvals.js"), "deny", approvalId5], {
        env: { ...process.env, TELEGRAM_STATE_DIR: sandbox },
        encoding: "utf8",
      });
      if (deny.status !== 0) {
        console.log("❌ deny CLI failed:", deny.stderr);
        process.exit(1);
      }
      console.log("✅ CLI deny succeeded");

      // Retry - should still be denied
      const res5b = await callTool(s5, "telegram_delete_chat", { chat: "test" }, 2);
      s5.kill();

      const text5b = res5b.result?.content?.[0]?.text ?? "";
      if (text5b.includes("APPROVAL_DENIED") && text5b.includes("denied by the human")) {
        console.log("✅ denied approval stays denied on retry");
      } else {
        console.log("❌ expected denied, got:", text5b);
        process.exit(1);
      }
    } else {
      console.log("❌ no approval ID in first response");
      process.exit(1);
    }

    console.log("\n=== ALL ACCESS/APPROVAL TESTS PASSED ===");
  } finally {
    cleanup(sandbox);
  }
}

run().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});