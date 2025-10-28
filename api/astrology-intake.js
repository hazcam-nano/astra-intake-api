// File: api/astrology-intake.js
import PDFDocument from "pdfkit";
import sg from "@sendgrid/mail";
import OpenAI from "openai";
import crypto from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // ✅ Handle Shopify proxy test GET
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Astrology Intake API is reachable.",
    });
  }

  // ✅ Continue with your existing POST logic
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

}

// ---- Env checks (printed to Runtime Logs, won't crash) ----
if (!process.env.SENDGRID_API_KEY) console.warn("WARN: SENDGRID_API_KEY missing");
if (!process.env.OPENAI_API_KEY)  console.warn("WARN: OPENAI_API_KEY missing");
if (!process.env.FROM_EMAIL)      console.warn("WARN: FROM_EMAIL missing");
if (!process.env.HCAPTCHA_SECRET) console.warn("WARN: HCAPTCHA_SECRET missing");
// Optional: only needed if you enable HMAC verification for App Proxy
if (!process.env.SHOPIFY_APP_SECRET) console.warn("INFO: SHOPIFY_APP_SECRET not set (App Proxy HMAC verification disabled)");

sg.setApiKey(process.env.SENDGRID_API_KEY || "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// -------------------- util: CORS --------------------
const setCors = (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight
};

const json = (req, res, code, obj) => {
  setCors(req, res);
  res.status(code);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(obj));
};
const bad = (req, res, code, msg, extra = {}) =>
  json(req, res, code, { ok: false, error: msg, ...extra });

// -------------------- util: read body --------------------
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const ct = (req.headers["content-type"] || "").toLowerCase();

        if (ct.includes("application/json")) {
          resolve(raw ? JSON.parse(raw) : {});
          return;
        }
        if (ct.includes("application/x-www-form-urlencoded")) {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
          return;
        }
        // Fallback: attempt JSON else empty
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { resolve({}); }
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

// -------------------- util: detect & verify App Proxy --------------------
const isFromShopifyProxy = (req) => {
  // Shopify adds these headers when proxying
  return Boolean(
    req.headers["x-shopify-shop-domain"] ||
    req.headers["x-shopify-forwarded-host"]
  );
};

const verifyShopifyProxy = (req) => {
  // Optional verification: only if SHOPIFY_APP_SECRET is set.
  if (!process.env.SHOPIFY_APP_SECRET) return true;

  // Build URL from req (Vercel gives path & query on req.url)
  const url = new URL(req.url, "https://dummy"); // base unused
  const qp = url.searchParams;
  const signature = qp.get("signature");
  if (!signature) return false;

  // HMAC is path + '?' + sorted query without 'signature'
  const pairs = [];
  qp.forEach((v, k) => { if (k !== "signature") pairs.push(`${k}=${v}`); });
  pairs.sort(); // lexicographic
  const base = `${url.pathname}?${pairs.join("&")}`;

  const expected = crypto
    .createHmac("sha256", process.env.SHOPIFY_APP_SECRET)
    .update(base)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
};

// -------------------- util: generate PDF --------------------
const renderPdf = ({ brand, q, first, last, dob, tob, city, country, tz, notes, bodyText }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text(`${brand} – Personalised Reading`, { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Question: ${q}`);
    doc.text(`Name: ${first} ${last}`);
    doc.text(`DOB: ${dob}   TOB: ${tob}`);
    doc.text(`Birthplace: ${city}, ${country}`);
    if (tz) doc.text(`Time zone: ${tz}`);
    if (notes) doc.text(`Notes: ${notes}`);
    doc.moveDown().moveDown();
    doc.fontSize(11).text(bodyText || "No content generated.", { align: "left" });
    doc.moveDown();
    doc.fontSize(9).fillColor("#666").text(
      "Disclaimer: This material is for reflection and entertainment. Outcomes depend on your choices. " +
      "If you need professional help, consult a qualified practitioner."
    );
    doc.end();
  });

// -------------------- main handler --------------------
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(req, res);
    return res.status(204).end();
  }

  // We only accept POST (Shopify proxy can POST; direct front-end POST is fine)
  if (req.method !== "POST") {
    return bad(req, res, 405, "Method not allowed");
  }

  // If coming via App Proxy and secret provided, verify HMAC
  if (isFromShopifyProxy(req) && !verifyShopifyProxy(req)) {
    return bad(req, res, 401, "Invalid Shopify proxy signature");
  }

  // Parse body (JSON or form)
  let body;
  try {
    body = await readBody(req);
  } catch {
    return bad(req, res, 400, "Invalid JSON body");
  }

  // Support GET-style query (in case proxy adds fields there). Body wins.
  try {
    const url = new URL(req.url, "https://dummy");
    for (const [k, v] of url.searchParams) {
      if (!(k in body)) body[k] = v;
    }
  } catch { /* ignore */ }

  const {
    q, email, first, last, dob, tob, country, city,
    tz = "", notes = "", consent = true, hcaptchaToken
  } = body;

  // Basic validation (keep messages explicit for UI)
  if (!q || !email || !first || !last || !dob || !tob || !country || !city) {
    return bad(req, res, 400, "Missing required fields.");
  }
  if (!hcaptchaToken) {
    return bad(req, res, 400, "hCaptcha token missing.");
  }

  // hCaptcha verification
  let hcRes;
  try {
    const r = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.HCAPTCHA_SECRET || "",
        response: hcaptchaToken
      })
    });
    hcRes = await r.json();
  } catch {
    return bad(req, res, 502, "Could not reach hCaptcha.");
  }
  if (!hcRes?.success) {
    return bad(req, res, 400, "hCaptcha verification failed.");
  }

  // OpenAI prompt
  const prompt =
`You are an expert natal chart interpreter. Compose a clear, empathetic, non-deterministic reading that answers the user's question using birth details.
Avoid medical/legal/financial advice. Include a gentle disclaimer and encourage personal agency.

User question: ${q}
Birth details:
- Name: ${first} ${last}
- Date of birth: ${dob}
- Time of birth (local): ${tob}
- City/Town: ${city}
- Country: ${country}
- Time zone (as given): ${tz || "unspecified"}
- Notes: ${notes || "none"}

Structure:
1) Short summary (2–3 sentences)
2) Key themes (bulleted)
3) Timing windows (probabilistic ranges)
4) Practical guidance (bulleted)
5) Closing encouragement.`;

  let bodyText = "";
  try {
    const ai = await openai.responses.create({
      model: "gpt-4o",
      input: prompt,
      temperature: 0.7
    });
    bodyText = ai.output_text || "";
  } catch (e) {
    console.error("OpenAI error:", e);
    return bad(req, res, 502, "AI generation failed.");
  }

  // PDF
  let pdfBuffer;
  try {
    pdfBuffer = await renderPdf({
      brand: process.env.BRAND_NAME || "Your Brand",
      q, first, last, dob, tob, city, country, tz, notes, bodyText
    });
  } catch (e) {
    console.error("PDF error:", e);
    return bad(req, res, 500, "PDF generation failed.");
  }

  // Email via SendGrid
  try {
    const brand = process.env.BRAND_NAME || "Your Brand";
    await sg.send({
      to: email,
      from: process.env.FROM_EMAIL, // must be verified sender/domain in SendGrid
      subject: `${brand} – Your personalised PDF reading`,
      text:
        `Hi ${first},\n\nAttached is your personalised reading in PDF format.\n\n` +
        `Question: ${q}\n\nWarmly,\n${brand}`,
      attachments: [
        {
          content: pdfBuffer.toString("base64"),
          filename: "reading.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }
      ]
    });
  } catch (e) {
    console.error("SendGrid error:", e?.response?.body || e);
    return bad(req, res, 502, "Email delivery failed.");
  }

  return json(req, res, 200, { ok: true, message: "Your reading is being sent to your email." });
}
