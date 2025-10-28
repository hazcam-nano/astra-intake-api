// api/ping.js
export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json");
    res.status(200).end(JSON.stringify({ ok: true, route: "/api/ping", method: req.method }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: "ping failed" }));
  }
}

