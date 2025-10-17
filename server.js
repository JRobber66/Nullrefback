// server.js
// API for alias generation + inbound email handling (Postmark).
// Endpoints:
//   POST /api/session           -> { alias, dobISO, dobPretty, email }
//   GET  /api/messages/:alias   -> { alias, messages: [rawPostmarkJson...] }
//   GET  /api/stream/:alias     -> SSE stream (backlog + live)
//   POST /inbound               -> Postmark inbound webhook (RAW JSON passthrough)
//   GET  /healthz               -> { ok: true, domain, corsOrigin }

import express from "express";
import cors from "cors";
import basicAuth from "basic-auth";
import crypto from "crypto";
import { FIRST_NAMES, LAST_NAMES } from "./names.js";

const app = express();
app.use(express.json({ limit: "15mb" }));

// -------- CONFIG (env) --------
const INBOUND_DOMAIN  = process.env.INBOUND_DOMAIN  || "in.refnull.net";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*"; // set to your Pages/host URL in prod
const WEBHOOK_USER    = process.env.WEBHOOK_USER    || "";  // optional
const WEBHOOK_PASS    = process.env.WEBHOOK_PASS    || "";  // optional
const REQUIRE_AUTH    = Boolean(WEBHOOK_USER && WEBHOOK_PASS);

app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
}));

// -------- In-memory (swap for DB in prod) --------
// sessions: alias -> { dobISO, dobPretty, email, localPart, baseLocal, messages: [], createdAt }
const sessions = new Map();
// index: local/base local-part -> alias
const indexByLocal = new Map();
// SSE listeners: alias -> Set(res)
const listeners = new Map();

// -------- Helpers --------
function randomNameAlias() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last  = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const suffix = Math.random() < 0.35 ? String(Math.floor(Math.random() * 900 + 100)) : "";
  return `${first}-${last}${suffix}`; // e.g., "Jordan-Wright482"
}
function randomDOBOver21() {
  const now = new Date();
  const age = Math.floor(Math.random() * (50 - 21 + 1)) + 21; // 21..50
  const y = now.getFullYear() - age;
  const m = Math.floor(Math.random() * 12);         // 0..11
  const d = Math.floor(Math.random() * 28) + 1;     // 1..28
  const dt = new Date(y, m, d);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    iso: dt.toISOString().slice(0, 10),
    pretty: `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}/${dt.getFullYear()}`
  };
}
function sanitizeLocalPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 64);
}
function addListener(alias, res) {
  if (!listeners.has(alias)) listeners.set(alias, new Set());
  listeners.get(alias).add(res);
}
function removeListener(alias, res) {
  const set = listeners.get(alias);
  if (!set) return;
  set.delete(res);
  if (!set.size) listeners.delete(alias);
}
function pushEvent(alias, event, data) {
  const set = listeners.get(alias);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}
// Robust extraction of recipient local-part from Postmark payload
function extractLocalPart(raw) {
  const toFull = Array.isArray(raw?.ToFull) ? raw.ToFull : [];
  if (toFull.length && toFull[0]?.Email) {
    return sanitizeLocalPart(toFull[0].Email.split("@")[0]);
  }
  const toStr = String(raw?.To || "");
  if (toStr) {
    const first = toStr.split(",")[0].trim();
    const m = first.match(/<([^>]+)>/);
    const addr = (m ? m[1] : first).trim();
    if (addr.includes("@")) return sanitizeLocalPart(addr.split("@")[0]);
  }
  const headers = Array.isArray(raw?.Headers) ? raw.Headers : [];
  const findHeader = (name) => headers.find(h => String(h?.Name || "").toLowerCase() === name)?.Value;
  const orig = findHeader("x-original-to") || findHeader("delivered-to");
  if (orig && orig.includes("@")) return sanitizeLocalPart(orig.split("@")[0]);
  return "";
}

// -------- API: create session --------
app.post("/api/session", (req, res) => {
  const aliasInput = (req.body?.alias || "").trim();
  const alias = (aliasInput || randomNameAlias()).replace(/\s+/g, "-");
  if (sessions.has(alias)) return res.status(409).json({ error: "alias_exists" });

  const dob = randomDOBOver21();
  const localPart = sanitizeLocalPart(alias) || crypto.randomBytes(4).toString("hex");
  const baseLocal = localPart.replace(/\d+$/,""); // for tolerant matching (with/without numeric suffix)
  const email = `${localPart}@${INBOUND_DOMAIN}`;

  const session = {
    dobISO: dob.iso,
    dobPretty: dob.pretty,
    email,
    localPart,
    baseLocal,
    messages: [],
    createdAt: new Date().toISOString(),
  };
  sessions.set(alias, session);
  indexByLocal.set(localPart, alias);
  if (baseLocal && baseLocal !== localPart) indexByLocal.set(baseLocal, alias);

  return res.json({ alias, dobISO: dob.iso, dobPretty: dob.pretty, email });
});

// -------- API: list messages for alias --------
app.get("/api/messages/:alias", (req, res) => {
  const sess = sessions.get(req.params.alias);
  res.json({ alias: req.params.alias, messages: sess?.messages || [] });
});

// -------- API: SSE stream for alias --------
app.get("/api/stream/:alias", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  const { alias } = req.params;
  const sess = sessions.get(alias);
  if (sess?.messages?.length) {
    res.write(`event: backlog\ndata: ${JSON.stringify(sess.messages)}\n\n`);
  }
  addListener(alias, res);
  req.on("close", () => removeListener(alias, res));
});

// -------- Optional: inbound logger --------
app.use((req, _res, next) => {
  if (req.path === "/inbound") {
    console.log(">> /inbound hit", {
      method: req.method,
      contentType: req.headers["content-type"],
      time: new Date().toISOString(),
    });
  }
  next();
});

// -------- Webhook guard (Basic Auth) --------
function guardWebhook(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  const creds = basicAuth(req);
  if (!creds || creds.name !== WEBHOOK_USER || creds.pass !== WEBHOOK_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="postmark-inbound"');
    return res.sendStatus(401);
  }
  next();
}

// -------- Webhook: Postmark inbound --------
app.post("/inbound", guardWebhook, (req, res) => {
  const raw = req.body || {};
  try {
    const local = extractLocalPart(raw);        // e.g., "teagan-pena482" or "teagan-pena"
    const base  = local.replace(/\d+$/,"");     // base w/o numeric suffix
    let alias   = indexByLocal.get(local) || indexByLocal.get(base);

    console.log("   RAW To:", raw?.To);
    if (raw?.ToFull)  console.log("   ToFull[0]:", raw.ToFull?.[0]);
    console.log("   Resolved localPart:", local, "base:", base, "-> alias:", alias || "(unknown)");

    if (!alias || !sessions.has(alias)) return res.sendStatus(200);

    const sess = sessions.get(alias);
    // Store full RAW payload
    sess.messages.push(raw);

    // Emit simplified + raw over SSE
    const simplified = {
      from: raw.From,
      to: raw.To,
      subject: raw.Subject,
      text: raw.TextBody,
      html: raw.HtmlBody,
      attachments: (raw.Attachments || []).map(a => ({
        Name: a.Name, ContentType: a.ContentType, ContentLength: a.ContentLength
      }))
    };
    pushEvent(alias, "email", { simplified, raw });

    return res.sendStatus(200);
  } catch (err) {
    console.error("Inbound parse error:", err);
    return res.sendStatus(200);
  }
});

// -------- Health --------
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, domain: INBOUND_DOMAIN, corsOrigin: FRONTEND_ORIGIN });
});

// -------- Boot --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  console.log(`Expect Postmark webhook at: https://<your-app>.up.railway.app/inbound`);
  console.log(`Configured inbound domain: ${INBOUND_DOMAIN}`);
});
