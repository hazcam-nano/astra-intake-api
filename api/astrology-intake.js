// api/astrology-intake.js  (stage A)
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.status(200).end(JSON.stringify({ ok: true, msg: "health" }));
}
