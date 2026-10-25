/**
 * The local control center's single page.
 *
 * Deliberately dependency-free and CDN-free: it must work offline, on a
 * localhost-only server, with a strict Content-Security-Policy. All data comes
 * from the authenticated JSON API; the page never sees the Telegram session.
 */
export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>telegram-mcp control center</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1020;
    --panel: #121a2e;
    --panel-2: #17213a;
    --line: #26324f;
    --text: #e6edf7;
    --muted: #8b9ab5;
    --accent: #5eead4;
    --accent-2: #a78bfa;
    --ok: #34d399;
    --warn: #fbbf24;
    --bad: #fb7185;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(1200px 700px at 20% -10%, #18264a 0%, var(--bg) 55%);
    color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
    min-height: 100vh;
  }
  header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 20px 28px; border-bottom: 1px solid var(--line); background: rgba(11,16,32,.75);
    position: sticky; top: 0; backdrop-filter: blur(10px); z-index: 2;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: .2px; }
  .brand small { color: var(--muted); font-weight: 500; letter-spacing: 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 16px var(--accent); }
  .meta { color: var(--muted); font-size: 12px; text-align: right; }
  main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 60px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
  .card { background: linear-gradient(180deg, var(--panel), var(--panel-2)); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; }
  .card .value { font-size: 20px; font-weight: 700; margin-top: 6px; overflow-wrap: anywhere; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; border: 1px solid var(--line); }
  .badge.ok { color: var(--ok); border-color: rgba(52,211,153,.35); background: rgba(52,211,153,.08); }
  .badge.warn { color: var(--warn); border-color: rgba(251,191,36,.35); background: rgba(251,191,36,.08); }
  .badge.bad { color: var(--bad); border-color: rgba(251,113,133,.35); background: rgba(251,113,133,.08); }
  .tabs { display: flex; gap: 6px; margin: 26px 0 16px; flex-wrap: wrap; }
  .tabs button {
    background: transparent; color: var(--muted); border: 1px solid transparent; border-radius: 10px;
    padding: 9px 14px; cursor: pointer; font: inherit; font-weight: 600;
  }
  .tabs button:hover { color: var(--text); background: rgba(255,255,255,.03); }
  .tabs button.active { color: var(--text); border-color: var(--line); background: var(--panel); }
  .panel { display: none; }
  .panel.active { display: block; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
  h2 { font-size: 16px; margin: 0; }
  .muted { color: var(--muted); }
  .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 720px; }
  th, td { text-align: left; padding: 11px 13px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; background: rgba(0,0,0,.12); position: sticky; top: 0; }
  tr:last-child td { border-bottom: 0; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  .args { color: var(--muted); max-width: 520px; overflow-wrap: anywhere; }
  .btn { background: rgba(94,234,212,.1); color: var(--accent); border: 1px solid rgba(94,234,212,.35); border-radius: 8px; padding: 5px 10px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; }
  .btn:hover { background: rgba(94,234,212,.18); }
  .btn.danger { color: var(--bad); border-color: rgba(251,113,133,.35); background: rgba(251,113,133,.08); }
  .btn.danger:hover { background: rgba(251,113,133,.16); }
  .empty { padding: 26px; text-align: center; color: var(--muted); }
  #error { display: none; margin-bottom: 16px; padding: 12px 14px; border: 1px solid rgba(251,113,133,.4); background: rgba(251,113,133,.08); color: var(--bad); border-radius: 12px; white-space: pre-wrap; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolbar input, .toolbar select { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 12px; }
  .foot { margin-top: 24px; color: var(--muted); font-size: 12px; }
  @media (max-width: 640px) { header { padding: 16px; } main { padding: 18px 12px 40px; } .meta { display: none; } }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot"></span> telegram-mcp <small>control center</small></div>
  <div class="meta" id="meta">local only · loading…</div>
</header>
<main>
  <div id="error"></div>

  <section class="grid" aria-label="Overview">
    <div class="card"><div class="label">Access profile</div><div class="value" id="profile">—</div><div class="sub" id="profile-sub"></div></div>
    <div class="card"><div class="label">Session</div><div class="value" id="session">—</div><div class="sub" id="session-sub"></div></div>
    <div class="card"><div class="label">Approval mode</div><div class="value" id="approval">—</div><div class="sub" id="approval-sub"></div></div>
    <div class="card"><div class="label">Pending approvals</div><div class="value" id="pending">—</div><div class="sub">one-shot, human-granted</div></div>
    <div class="card"><div class="label">Audit calls</div><div class="value" id="calls">—</div><div class="sub" id="calls-sub"></div></div>
    <div class="card"><div class="label">Version</div><div class="value" id="version">—</div><div class="sub">stdio · local-first</div></div>
  </section>

  <nav class="tabs" aria-label="Sections">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="approvals">Approvals</button>
    <button data-tab="audit">Audit log</button>
    <button data-tab="tools">Tools</button>
  </nav>

  <section class="panel active" id="panel-overview">
    <div class="panel-head"><h2>Health</h2><button class="btn" id="refresh-overview">Refresh</button></div>
    <div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody id="health-body"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody></table></div>
    <p class="foot">This dashboard is bound to 127.0.0.1 and never connects to Telegram itself. Live authorization is checked by the <code>telegram_doctor</code> tool.</p>
  </section>

  <section class="panel" id="panel-approvals">
    <div class="panel-head"><h2>Pending approvals</h2><div class="toolbar"><button class="btn" id="refresh-approvals">Refresh</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Tool</th><th>Arguments</th><th>Created</th><th>Action</th></tr></thead><tbody id="approvals-body"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>
    <p class="foot">Approving allows exactly one call with these arguments. The agent must retry the same call afterwards.</p>
  </section>

  <section class="panel" id="panel-audit">
    <div class="panel-head"><h2>Audit log</h2><div class="toolbar">
      <select id="audit-outcome"><option value="">all outcomes</option><option value="ok">ok</option><option value="error">error</option></select>
      <input id="audit-tool" placeholder="filter tool" size="18">
      <button class="btn" id="refresh-audit">Refresh</button>
    </div></div>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Outcome</th><th>Arguments / error</th></tr></thead><tbody id="audit-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div>
  </section>

  <section class="panel" id="panel-tools">
    <div class="panel-head"><h2>Tool catalog</h2><div class="toolbar"><input id="tool-filter" placeholder="filter name or title" size="24"><button class="btn" id="refresh-tools">Refresh</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>Tool</th><th>Access</th><th>Hints</th><th>Description</th></tr></thead><tbody id="tools-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody></table></div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var state = { tab: "overview", summary: null, tools: [] };

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function short(value, max) {
    var text;
    try { text = typeof value === "string" ? value : JSON.stringify(value); } catch (e) { text = String(value); }
    text = String(text == null ? "" : text);
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function time(value) {
    if (!value) return "—";
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
  }
  function badge(text, kind) { return '<span class="badge ' + (kind || "") + '">' + esc(text) + "</span>"; }
  function showError(message) {
    var node = el("error");
    if (!message) { node.style.display = "none"; node.textContent = ""; return; }
    node.style.display = "block"; node.textContent = message;
  }
  async function api(path, options) {
    var response = await fetch(path, Object.assign({ credentials: "same-origin" }, options || {}));
    var type = response.headers.get("content-type") || "";
    var body = type.indexOf("application/json") >= 0 ? await response.json() : await response.text();
    if (!response.ok) throw new Error((body && body.error) || body || ("HTTP " + response.status));
    return body;
  }
  function fill(id, value, subId, sub) {
    el(id).textContent = value == null ? "—" : String(value);
    if (subId) el(subId).textContent = sub == null ? "" : String(sub);
  }

  async function loadSummary() {
    var data = await api("/api/summary");
    state.summary = data;
    var profileKind = data.profileError ? "bad" : (data.profile === "full" ? "warn" : "ok");
    el("profile").innerHTML = badge(data.profile, profileKind);
    el("profile-sub").textContent = data.profileError || data.profileDescription || "";
    el("session").innerHTML = data.sessionPresent ? badge("present", "ok") : badge("not logged in", "warn");
    el("session-sub").textContent = data.sessionPath || "";
    var approvalKind = data.approvalError ? "bad" : (data.approvalMode === "off" ? "warn" : "ok");
    el("approval").innerHTML = badge(data.approvalMode, approvalKind);
    el("approval-sub").textContent = data.approvalError || "approve with telegram-mcp approve <id>";
    fill("pending", data.approvals.pending);
    fill("calls", data.audit.calls, "calls-sub", data.audit.ok + " ok · " + data.audit.error + " error");
    fill("version", data.version);
    el("meta").textContent = "local only · " + (data.configured ? "configured" : "not configured") + " · " + data.stateDir;
    renderHealth(data);
    if (state.tab === "approvals") await loadApprovals();
  }

  function renderHealth(data) {
    var rows = [];
    rows.push(["config", data.configured ? badge("pass", "ok") : badge("fail", "bad"), data.configError || "api_id/api_hash present"]);
    rows.push(["session", data.sessionPresent ? badge("pass", "ok") : badge("fail", "warn"), data.sessionPath || ""]);
    rows.push(["access profile", data.profileError ? badge("fail", "bad") : badge("pass", "ok"), data.profileError || (data.profile + " (" + data.profileSource + ")")]);
    rows.push(["approval mode", data.approvalError ? badge("fail", "bad") : badge("pass", "ok"), data.approvalError || (data.approvalMode + " (" + data.approvalSource + ")")]);
    rows.push(["audit log", data.audit.exists ? badge("pass", "ok") : badge("info", "warn"), data.audit.path + " · " + data.audit.calls + " calls"]);
    rows.push(["last call", data.audit.lastCallAt ? badge("seen", "ok") : badge("none", "warn"), data.audit.lastCallAt || "no calls recorded"]);
    el("health-body").innerHTML = rows.map(function (row) {
      return "<tr><td>" + esc(row[0]) + "</td><td>" + row[1] + "</td><td class=\"muted\">" + esc(row[2]) + "</td></tr>";
    }).join("");
  }

  async function loadApprovals() {
    var data = await api("/api/approvals");
    var pending = data.pending || [];
    if (!pending.length) {
      el("approvals-body").innerHTML = '<tr><td colspan="5" class="empty">No pending approvals.</td></tr>';
      return;
    }
    el("approvals-body").innerHTML = pending.map(function (request) {
      return "<tr>" +
        "<td class=\"mono\">" + esc(request.id) + "</td>" +
        "<td class=\"mono\">" + esc(request.tool) + "</td>" +
        "<td class=\"args mono\">" + esc(short(request.argsPreview, 420)) + "</td>" +
        "<td class=\"muted\">" + esc(time(request.createdAt)) + "<br>expires " + esc(time(request.expiresAt)) + "</td>" +
        "<td><button class=\"btn\" data-approve=\"" + esc(request.id) + "\">Approve</button> " +
        "<button class=\"btn danger\" data-deny=\"" + esc(request.id) + "\">Deny</button></td>" +
        "</tr>";
    }).join("");
  }

  async function decide(id, action) {
    showError("");
    try {
      await api("/api/approvals/" + encodeURIComponent(id) + "/" + action, {
        method: "POST",
        headers: { "X-Requested-With": "telegram-mcp-dashboard" }
      });
      await loadApprovals();
      await loadSummary();
    } catch (err) {
      showError(err.message);
    }
  }

  async function loadAudit() {
    var params = new URLSearchParams();
    params.set("limit", "100");
    var outcome = el("audit-outcome").value;
    var tool = el("audit-tool").value.trim();
    if (outcome) params.set("outcome", outcome);
    if (tool) params.set("tool", tool);
    var data = await api("/api/audit?" + params.toString());
    var entries = data.entries || [];
    if (!entries.length) {
      el("audit-body").innerHTML = '<tr><td colspan="4" class="empty">No matching audit entries.</td></tr>';
      return;
    }
    el("audit-body").innerHTML = entries.map(function (entry) {
      var outcomeKind = entry.outcome === "ok" ? "ok" : (entry.outcome === "error" ? "bad" : "warn");
      var detail = entry.outcome === "error" ? entry.detail : entry.args;
      return "<tr>" +
        "<td class=\"muted\">" + esc(time(entry.ts)) + "</td>" +
        "<td class=\"mono\">" + esc(entry.tool || "—") + "</td>" +
        "<td>" + badge(entry.outcome || "unknown", outcomeKind) + "</td>" +
        "<td class=\"args mono\">" + esc(short(detail, 500)) + "</td>" +
        "</tr>";
    }).join("");
  }

  async function loadTools() {
    var data = await api("/api/tools");
    state.tools = data.tools || [];
    renderTools();
  }

  function renderTools() {
    var needle = el("tool-filter").value.trim().toLowerCase();
    var tools = state.tools.filter(function (tool) {
      return !needle || (tool.name + " " + tool.title).toLowerCase().indexOf(needle) >= 0;
    });
    if (!tools.length) {
      el("tools-body").innerHTML = '<tr><td colspan="4" class="empty">No matching tools.</td></tr>';
      return;
    }
    el("tools-body").innerHTML = tools.map(function (tool) {
      var hints = (tool.readOnly ? "read-only" : "write") + (tool.destructive ? " · destructive" : "");
      return "<tr>" +
        "<td><span class=\"mono\">" + esc(tool.name) + "</span><br><span class=\"muted\">" + esc(tool.title) + "</span></td>" +
        "<td>" + badge(tool.minimumProfile, tool.minimumProfile === "full" ? "warn" : "ok") + "</td>" +
        "<td class=\"muted\">" + esc(hints) + "</td>" +
        "<td class=\"muted\">" + esc(tool.description) + "</td>" +
        "</tr>";
    }).join("");
  }

  function switchTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (button) {
      button.classList.toggle("active", button.getAttribute("data-tab") === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".panel"), function (panel) {
      panel.classList.toggle("active", panel.id === "panel-" + tab);
    });
    showError("");
    if (tab === "approvals") loadApprovals().catch(function (err) { showError(err.message); });
    if (tab === "audit") loadAudit().catch(function (err) { showError(err.message); });
    if (tab === "tools") loadTools().catch(function (err) { showError(err.message); });
  }

  document.querySelectorAll(".tabs button").forEach(function (button) {
    button.addEventListener("click", function () { switchTab(button.getAttribute("data-tab")); });
  });
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || target.tagName !== "BUTTON") return;
    var approve = target.getAttribute("data-approve");
    var deny = target.getAttribute("data-deny");
    if (approve) decide(approve, "approve");
    if (deny) decide(deny, "deny");
  });
  el("refresh-overview").addEventListener("click", function () { loadSummary().catch(function (err) { showError(err.message); }); });
  el("refresh-approvals").addEventListener("click", function () { loadApprovals().catch(function (err) { showError(err.message); }); });
  el("refresh-audit").addEventListener("click", function () { loadAudit().catch(function (err) { showError(err.message); }); });
  el("refresh-tools").addEventListener("click", function () { loadTools().catch(function (err) { showError(err.message); }); });
  el("audit-outcome").addEventListener("change", function () { loadAudit().catch(function (err) { showError(err.message); }); });
  el("tool-filter").addEventListener("input", renderTools);

  loadSummary().catch(function (err) { showError(err.message); });
  setInterval(function () {
    loadSummary().catch(function (err) { showError(err.message); });
  }, 10000);
  setInterval(function () {
    if (state.tab === "approvals") loadApprovals().catch(function (err) { showError(err.message); });
  }, 5000);
})();
</script>
</body>
</html>`;
}
