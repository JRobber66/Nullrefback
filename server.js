// server.js
// API-only backend for alias generation and inbound email handling.
// Endpoints:
//   POST /api/session           -> { alias, dobISO, dobPretty, email }
//   GET  /api/messages/:alias   -> { alias, messages: [rawPostmarkJson...] }
//   GET  /api/stream/:alias     -> SSE stream for live messages
//   POST /inbound               -> Postmark inbound webhook (raw JSON)
//   GET  /healthz               -> { ok: true }

import express from "express";
import cors from "cors";
import basicAuth from "basic-auth";
import crypto from "crypto";
import { FIRST_NAMES, LAST_NAMES } from "./names.js";

const app = express();
app.use(express.json({ limit: "15mb" }));

// -------- CONFIG (env) --------
const INBOUND_DOMAIN   = process.env.INBOUND_DOMAIN   || "in.nullref.com";
const FRONTEND_ORIGIN  = process.env.FRONTEND_ORIGIN  || "*"; // set to your frontend origin in prod
const WEBHOOK_USER     = process.env.WEBHOOK_USER     || "";  // optional
const WEBHOOK_PASS     = process.env.WEBHOOK_PASS     || "";  // optional
const REQUIRE_AUTH     = Boolean(WEBHOOK_USER && WEBHOOK_PASS);

// CORS: allow your frontend to call this API
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
}));

// -------- In-memory storage (replace with DB for persistence) --------
const sessions  = new Map(); // alias -> { dobISO, dobPretty, email, messages: [], createdAt }
const listeners = new Map(); // alias -> Set(res) for SSE

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

function guardWebhook(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  const creds = basicAuth(req);
  if (!creds || creds.name !== WEBHOOK_USER || creds.pass !== WEBHOOK_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="postmark-inbound"');
    return res.sendStatus(401);
  }
  next();
}

// -------- API: create session --------
app.post("/api/session", (req, res) => {
  const aliasInput = (req.body?.alias || "").trim();
  const alias = (aliasInput || randomNameAlias()).replace(/\s+/g, "-");

  if (sessions.has(alias)) return res.status(409).json({ error: "alias_exists" });

  const dob = randomDOBOver21();
  const localPart = alias.replace(/[^a-z0-9-]/gi, "").slice(0, 64).toLowerCase()
                  || crypto.randomBytes(4).toString("hex");
  const email = `${localPart}@${INBOUND_DOMAIN}`;

  sessions.set(alias, {
    dobISO: dob.iso,
    dobPretty: dob.pretty,
    email,
    messages: [],
    createdAt: new Date().toISOString()
  });

  return res.json({ alias, dobISO: dob.iso, dobPretty: dob.pretty, email });
});

// -------- API: list messages for alias (debug/fetch) --------
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

// -------- Webhook: Postmark inbound (RAW JSON passthrough) --------
app.post("/inbound", guardWebhook, (req, res) => {
  const raw = req.body || {};
  try {
    // Postmark "To" is often "Name <email@domain>, ..."
    const toField = String(raw.To || "").split(",")[0].trim();
    const m = toField.match(/<([^>]+)>/);
    const addr = m ? m[1] : toField;
    const local = (addr.split("@")[0] || "").toLowerCase();

    const alias = local; // local-part is generated from alias already
    const sess = sessions.get(alias);

    if (!sess) {
      // Unknown/expired alias: acknowledge to avoid retries/backscatter
      return res.sendStatus(200);
    }

    // Store entire RAW payload (exactly what Postmark sent)
    sess.messages.push(raw);

    // Emit a simplified + raw event to SSE listeners
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
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// -------- Boot --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  console.log(`Set Postmark Inbound Webhook URL to: https://<your-app>.up.railway.app/inbound`);
});
