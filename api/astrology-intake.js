// api/astrology-intake.js
import PDFDocument from "pdfkit";
import sg from "@sendgrid/mail";
import OpenAI from "openai";

// Only set SendGrid if the key is present (harmless if missing)
if (process.env.SENDGRID_API_KEY) {
  try { sg.setApiKey(process.env.SENDGRID_API_KEY); } catch {}
}

// Lazy init OpenAI to avoid throwing at module load when key is missing
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

// ---------- helpers ----------
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
const reply = (req, res, code, obj) => {
  setCors(req, res);
  res.status(code).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};
const bad = (req, res, code, error, extra = {}) =>
  reply(req, res, code, { ok: false, error, ...extra });

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

const renderPdf = ({ q, first, last, dob, tob, city, country, tz, notes, bodyText, brand }) =>
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
    doc.moveDown().fontSize(11).text(bodyText || "No content generated.");
    doc.moveDown().fontSize(9).fillColor("#666").text(
      "Disclaimer: This material is for reflection and entertainment. Outcomes depend on your choices."
    );
    doc.end();
  });

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return reply(req, res, 204, {});
    if (req.method === "GET")    return reply(req, res, 200, { ok: true, message: "Astrology Intake API is reachable." });
    if (req.method !== "POST")   return bad(req, res, 405, "Method not allowed");

    let body = {};
    try { body = await readBody(req); }
    catch { return bad(req, res, 400, "Invalid JSON body"); }

    const {
      q, email, first, last, dob, tob, country, city,
      tz = "", notes = "", consent = true, hcaptchaToken
    } = body;

    if (!q || !email || !first || !last || !dob || !tob || !country || !city)
      return bad(req, res, 400, "Missing required fields.");
    if (!hcaptchaToken) return bad(req, res, 400, "hCaptcha token missing.");

    // hCaptcha verify
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

    const brand = process.env.BRAND_NAME || "Your Brand";

    // TEST_MODE: skip AI + email to verify pipeline
    if (process.env.TEST_MODE === "1") {
      const pdf = await renderPdf({
        q, first, last, dob, tob, city, country, tz, notes,
        bodyText: "TEST MODE: This is a stub report.", brand
      });
      // We won't email in test mode—just confirm success
      return reply(req, res, 200, { ok: true, message: "Test mode OK (PDF generated, email skipped)." });
    }

    // OpenAI (lazy init here, AFTER captcha)
    let bodyText = "";
    try {
      const openai = getOpenAI();
      const prompt =
`You are an empathetic natal chart interpreter. Provide a clear, non-deterministic reading with a brief summary, key themes, timing windows (probabilistic), and practical guidance. Avoid legal/medical/financial advice.

User question: ${q}
Birth details:
- Name: ${first} ${last}
- Date of birth: ${dob}
- Time of birth (local): ${tob}
- City/Town: ${city}
- Country: ${country}
- Time zone: ${tz || "unspecified"}
- Notes: ${notes || "none"}`;
      const ai = await openai.responses.create({ model: "gpt-4o", input: prompt, temperature: 0.7 });
      bodyText = ai.output_text || "";
    } catch (e) {
      console.error("OpenAI error:", e);
      return bad(req, res, 502, "AI generation failed.");
    }

    // PDF
    let pdfBuffer;
    try {
      pdfBuffer = await renderPdf({ q, first, last, dob, tob, city, country, tz, notes, bodyText, brand });
    } catch (e) {
      console.error("PDF error:", e);
      return bad(req, res, 500, "PDF generation failed.");
    }

    // Email (requires verified FROM_EMAIL + SENDGRID_API_KEY)
    try {
      await sg.send({
        to: email,
        from: process.env.FROM_EMAIL,
        subject: `${brand} – Your personalised PDF reading`,
        text: `Hi ${first},\n\nAttached is your personalised reading.\n\nQuestion: ${q}\n\nWarmly,\n${brand}`,
        attachments: [{
          content: pdfBuffer.toString("base64"),
          filename: "reading.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }]
      });
    } catch (e) {
      console.error("SendGrid error:", e?.response?.body || e);
      return bad(req, res, 502, "Email delivery failed.");
    }

    return reply(req, res, 200, { ok: true, message: "Your reading is being sent to your email." });
  } catch (err) {
    console.error("Unhandled error:", err);
    return reply(req, res, 500, { ok: false, error: "Server error." });
  }
}
