import express from "express";
import os from "os";

const app = express();
app.use(express.json({ limit: "10mb" }));

// 1️⃣  POSTMARK inbound endpoint
app.post("/inbound", (req, res) => {
  const email = req.body;

  // Debug log — you’ll see this in Railway logs
  console.log("📩 New inbound email:");
  console.log({
    from: email.From,
    to: email.To,
    subject: email.Subject,
    text: email.TextBody?.slice(0, 200) + "...", // preview
  });

  // TODO: Save, forward, or process however you like
  res.sendStatus(200); // tell Postmark "OK"
});

// 2️⃣  Simple status endpoint (to confirm deployment)
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    hostname: os.hostname(),
    railwayHint:
      "Your webhook URL is https://" +
      (process.env.RAILWAY_STATIC_URL ||
        process.env.RAILWAY_URL ||
        "<your-app>.up.railway.app") +
      "/inbound",
  });
});

// 3️⃣  Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(
    `➡️  Webhook endpoint: https://${process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_URL ||
      "<your-app>.up.railway.app"}/inbound`
  );
});
