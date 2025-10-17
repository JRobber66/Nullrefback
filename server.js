// server.js
// npm i express cors basic-auth

import express from "express";
import cors from "cors";
import basicAuth from "basic-auth";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "15mb" }));

// ---------- CONFIG ----------
const INBOUND_DOMAIN = process.env.INBOUND_DOMAIN || "in.nullref.com";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*"; // e.g., https://nullref.com
const WEBHOOK_USER = process.env.WEBHOOK_USER || "";
const WEBHOOK_PASS = process.env.WEBHOOK_PASS || "";
const REQUIRE_WEBHOOK_AUTH = Boolean(WEBHOOK_USER && WEBHOOK_PASS);

// CORS: allow your frontend only (set FRONTEND_ORIGIN in prod)
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// ---------- In-memory (swap for DB in prod) ----------
const sessions = new Map(); // alias -> { dobISO, dobPretty, email, messages: [raw], createdAt }
const listeners = new Map(); // alias -> Set(res) for SSE

// ---------- Helpers ----------
function randomAlias() {
  const C = "bcdfghjklmnpqrstvwxyz";
  const V = "aeiou";
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const left = pick(C) + pick(V) + pick(C) + pick(V);
  const nouns = ["void","marten","vertex","delta","amber","cinder","neon","quartz","glyph","nadir"];
  return `${left}-${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

function randomDOBOver21() {
  const now = new Date();
  const age = Math.floor(Math.random() * (50 - 21 + 1)) + 21; // 21..50
  const y = now.getFullYear() - age;
  const m = Math.floor(Math.random() * 12);  // 0..11
  const d = Math.floor(Math.random() * 28) + 1;
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

// ---------- API ----------
app.post("/api/session", (req, res) => {
  const aliasInput = (req.body?.alias || "").toLowerCase().trim();
  const alias = aliasInput || randomAlias();
  if (sessions.has(alias)) return res.status(409).json({ error: "alias_exists" });

  const dob = randomDOBOver21();
  const local = alias.replace(/[^a-z0-9-]/g, "").slice(0, 64) || crypto.randomBytes(4).toString("hex");
  const email = `${local}@${INBOUND_DOMAIN}`;
  sessions.set(alias, {
    dobISO: dob.iso,
    dobPretty: dob.pretty,
    email,
    messages: [],
    createdAt: new Date().toISOString(),
  });
  res.json({ alias, dobISO: dob.iso, dobPretty: dob.pretty, email });
});

app.get("/api/messages/:alias", (req, res) => {
  const sess = sessions.get(req.params.alias);
  res.json({ alias: req.params.alias, messages: sess?.messages || [] });
});

app.get("/api/stream/:alias", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
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

function guardWebhook(req, res, next) {
  if (!REQUIRE_WEBHOOK_AUTH) return next();
  const creds = basicAuth(req);
  if (!creds || creds.name !== WEBHOOK_USER || creds.pass !== WEBHOOK_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="inbound"');
    return res.sendStatus(401);
  }
  next();
}

// Postmark inbound webhook (RAW JSON pass-through)
app.post("/inbound", guardWebhook, (req, res) => {
  const raw = req.body || {};
  try {
    // Extract first "To" address; Postmark formats To as "Name <email@domain>, ..."
    const toField = String(raw.To || "").split(",")[0].trim();
    const match = toField.match(/<([^>]+)>/);
    const addr = match ? match[1] : toField;
    const local = (addr.split("@")[0] || "").toLowerCase();

    const alias = local;
    const sess = sessions.get(alias);
    if (!sess) return res.sendStatus(200); // Unknown alias: acknowledge, drop

    // Store entire RAW payload
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
      })),
    };
    pushEvent(alias, "email", { simplified, raw });

    res.sendStatus(200);
  } catch (e) {
    console.error("Inbound parse error:", e);
    res.sendStatus(200);
  }
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  console.log(`Expect Postmark webhook at https://<your-app>.up.railway.app/inbound`);
});
