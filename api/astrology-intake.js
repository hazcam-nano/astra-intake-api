// stage B: add body parsing & method gates
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = ""; req.on("data", c => raw += c);
  req.on("end", () => {
    try {
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) return resolve(raw ? JSON.parse(raw) : {});
      if (ct.includes("application/x-www-form-urlencoded")) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    } catch (e) { reject(e); }
  });
  req.on("error", reject);
});
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")     return res.status(200).json({ ok: true, msg: "health" });
  if (req.method !== "POST")    return res.status(405).json({ ok: false, error: "Method not allowed" });
  let body = {}; try { body = await readBody(req); } catch { return res.status(400).json({ ok:false, error:"Invalid JSON body"}); }
  return res.status(200).json({ ok: true, echo: body });
}
