// api/astrology-intake.js  — DIAGNOSTIC VERSION (no top-level imports)

// --- tiny CORS + helpers ---
const setCors = (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
};
const send = (req, res, code, obj) => {
  setCors(req, res);
  res.status(code).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
const bad = (req, res, code, error, extra = {}) =>
  send(req, res, code, { ok: false, error, ...extra });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/json")) return resolve(raw ? JSON.parse(raw) : {});
        if (ct.includes("application/x-www-form-urlencoded"))
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return send(req, res, 204, {});
    if (req.method === "GET")     return send(req, res, 200, { ok: true, message: "Health OK" });
    if (req.method !== "POST")    return bad(req, res, 405, "Method not allowed");

    let body = {};
    try { body = await readBody(req); }
    catch { return bad(req, res, 400, "Invalid JSON body"); }

    const { q, email, first, last, dob, tob, country, city, hcaptchaToken } = body;

    // minimal field check
    if (!q || !email || !first || !last || !dob || !tob || !country || !city)
      return bad(req, res, 400, "Missing required fields.");
    if (!hcaptchaToken) return bad(req, res, 400, "hCaptcha token missing.");

    // hCaptcha only (no other calls)
    try {
      const r = await fetch("https://hcaptcha.com/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: process.env.HCAPTCHA_SECRET || "",
          response: hcaptchaToken
        })
      });
      const hc = await r.json();
      if (!hc?.success) return bad(req, res, 400, "hCaptcha verification failed.");
    } catch (e) {
      console.error("hCaptcha error:", e);
      return bad(req, res, 502, "Could not reach hCaptcha.");
    }

    // success stub
    return send(req, res, 200, { ok: true, message: "Diagnostic OK: captcha passed." });
  } catch (err) {
    console.error("Unhandled error:", err);
    return send(req, res, 500, { ok: false, error: "Server error." });
  }
}
