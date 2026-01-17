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

function pickEventId(body) {
  // Try common patterns; fall back to hash-like string if needed.
  return (
    body?.event?.id ||
    body?.event_id ||
    body?.id ||
    body?.data?.id ||
    body?.alert?.id ||
    body?.uuid ||
    null
  );
}

app.post("/webhook/spotai", async (req, res) => {
  const body = req.body ?? {};

  const eventId = pickEventId(body) || `fallback_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // optional fields (best effort)
  const cameraId = body?.camera?.id || body?.camera_id || body?.device?.id || null;
  const cameraName = body?.camera?.name || body?.camera_name || null;
  const scenario = body?.scenario?.name || body?.scenario || body?.rule?.name || body?.alert_type || null;

  const eventTs =
    body?.event?.timestamp ||
    body?.timestamp ||
    body?.created_at ||
    body?.event_time ||
    null;

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
      eventTs ? new Date(eventTs) : null,
      JSON.stringify(body)
    ]);

    // Always 200 to stop Spot retries even if duplicate
    return res.status(200).json({
      ok: true,
      inserted: r.rowCount === 1,
      event_id: eventId
    });
  } catch (err) {
    console.error("Webhook insert error:", err);
    // Still return 200 if you prefer to avoid Spot retry storms,
    // but returning 500 can help surface issues early.
    return res.status(500).json({ ok: false });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Webhook receiver listening on ${port}`));
