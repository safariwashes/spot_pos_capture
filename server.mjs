// server.mjs (FULL VERSION) — Spot.ai webhook receiver → inserts jobs into spot_jobs
// Drop-in replacement for your current server.mjs
// Key fix: robust extraction of camera_id / camera_name / scenario so they are NOT NULL when Spot sends them.

import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.use(express.json({ limit: "2mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s && s !== "null" && s !== "undefined") return s;
  }
  return null;
}

function pickEventId(body) {
  // Try common patterns; fall back to null if not found.
  return pickFirst(
    body?.event?.id,
    body?.event_id,
    body?.id,
    body?.data?.id,
    body?.alert?.id,
    body?.uuid
  );
}

function pickCameraId(body) {
  // This list is intentionally broad because Spot payloads vary by configuration.
  return pickFirst(
    body?.camera?.id,
    body?.cameraId,
    body?.camera_id,

    body?.device?.id,
    body?.deviceId,
    body?.device_id,

    body?.data?.camera?.id,
    body?.data?.cameraId,
    body?.data?.camera_id,

    body?.event?.camera?.id,
    body?.event?.cameraId,
    body?.event?.camera_id,

    body?.alert?.camera?.id,
    body?.alert?.cameraId,
    body?.alert?.camera_id
  );
}

function pickCameraName(body) {
  return pickFirst(
    body?.camera?.name,
    body?.camera_name,
    body?.data?.camera?.name,
    body?.event?.camera?.name
  );
}

function pickScenario(body) {
  return pickFirst(
    body?.scenario?.name,
    body?.scenario,

    body?.rule?.name,
    body?.rule_name,

    body?.alert_type,
    body?.alert?.type,

    body?.event?.type
  );
}

function pickEventTs(body) {
  const raw = pickFirst(
    body?.event?.timestamp,
    body?.event?.time,
    body?.timestamp,
    body?.created_at,
    body?.event_time
  );
  if (!raw) return null;

  // If it's numeric-ish (epoch ms/sec), try to parse safely
  const n = Number(raw);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    // Heuristic: if it's > 10^12 it's probably ms, else seconds
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Otherwise assume ISO date/time string
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

app.post("/webhook/spotai", async (req, res) => {
  const body = req.body ?? {};

  const eventId = pickEventId(body) || `fallback_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // best-effort extraction
  const cameraId = pickCameraId(body);     // <-- FIX: should populate for your 120333/120329
  const cameraName = pickCameraName(body);
  const scenario = pickScenario(body);
  const eventTs = pickEventTs(body);

  // TEMP debug (optional): uncomment for 1-2 events then remove
  // console.log("SPOT parsed:", { eventId, cameraId, cameraName, scenario, eventTs });

  try {
    const q = `
      insert into spot_jobs (event_id, camera_id, camera_name, scenario, event_ts, payload, status)
      values ($1, $2, $3, $4, $5, $6::jsonb, 'NEW')
      on conflict (event_id) do nothing
      returning id
    `;

    const r = await pool.query(q, [
      eventId,
      cameraId,
      cameraName,
      scenario,
      eventTs,
      JSON.stringify(body)
    ]);

    // Always 200 to stop Spot retries even if duplicate
    return res.status(200).json({
      ok: true,
      inserted: r.rowCount === 1,
      event_id: eventId,
      camera_id: cameraId,
      scenario
    });
  } catch (err) {
    console.error("Webhook insert error:", err);
    // Returning 500 helps reveal DB/config issues; Spot will retry depending on its policy.
    return res.status(500).json({ ok: false });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Webhook receiver listening on ${port}`));
