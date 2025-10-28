// File: api/astrology-intake.js
import PDFDocument from "pdfkit";
import sg from "@sendgrid/mail";
import OpenAI from "openai";

// ---- env sanity (logs show up in Runtime Logs) ----
if (!process.env.SENDGRID_API_KEY) console.warn("WARN: SENDGRID_API_KEY missing");
if (!process.env.OPENAI_API_KEY)  console.warn("WARN: OPENAI_API_KEY missing");
if (!process.env.FROM_EMAIL)      console.warn("WARN: FROM_EMAIL missing");
if (!process.env.HCAPTCHA_SECRET) console.warn("WARN: HCAPTCHA_SECRET missing");

sg.setApiKey(process.env.SENDGRID_API_KEY || "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// ---------- helpers ----------
const setCors = (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "Content-Type"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
};

const json = (req, res, code, obj) => {
  setCors(req, res);
  res.status(code);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(obj));
};
const bad = (req, res, code, msg, extra = {}) =>
  json(req, res, code, { ok: false, error: msg, ...extra });

/** Read and parse JSON body on Vercel Node functions */
const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    try {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        try {
          if (!buf) return resolve({});
          const obj = JSON.parse(buf);
          resolve(obj);
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });

// ---------- main handler ----------
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(req, res);
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return bad(req, res, 405, "Method not allowed");
  }

  try {
    // IMPORTANT: manually parse JSON
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return bad(req, res, 400, e.message || "Invalid JSON");
    }

    const {
      q, email, first, last, dob, tob, country, city,
      tz = "", notes = "", consent = true, hcaptchaToken
    } = body;

    // Basic field validation
    if (!q || !email || !first || !last || !dob || !tob || !country || !city) {
      return bad(req, res, 400, "Missing required fields.");
    }
    if (!hcaptchaToken) return bad(req, res, 400, "hCaptcha token missing.");

    // hCaptcha verify
    let hcRes = null;
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
    } catch (e) {
      return bad(req, res, 502, "Could not reach hCaptcha.");
    }
    if (!hcRes || !hcRes.success) {
      return bad(req, res, 400, "hCaptcha verification failed.");
    }

    // Build prompt and call OpenAI
    const prompt = `You are an expert natal chart interpreter. Compose a clear, empathetic, non-deterministic reading that answers the user's question using birth details.
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
    if (!bodyText.trim()) bodyText = "No content generated.";

    // Render PDF
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const brand = process.env.BRAND_NAME || "Your Brand";

      doc.fontSize(20).text(`${brand} – Personalised Reading`, { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Question: ${q}`);
      doc.text(`Name: ${first} ${last}`);
      doc.text(`DOB: ${dob}   TOB: ${tob}`);
      doc.text(`Birthplace: ${city}, ${country}`);
      if (tz) doc.text(`Time zone: ${tz}`);
      if (notes) doc.text(`Notes: ${notes}`);
      doc.moveDown().moveDown();
      doc.fontSize(11).text(bodyText, { align: "left" });
      doc.moveDown();
      doc.fontSize(9).fillColor("#666").text(
        "Disclaimer: This material is for reflection and entertainment. Outcomes depend on your choices. If you need professional help, consult a qualified practitioner."
      );
      doc.end();
    });

    // Send email via SendGrid
    try {
      const brand = process.env.BRAND_NAME || "Your Brand";
      await sg.send({
        to: email,
        from: process.env.FROM_EMAIL, // must be verified in SendGrid
        subject: `${brand} – Your personalised PDF reading`,
        text: `Hi ${first},\n\nAttached is your personalised reading in PDF format.\n\nQuestion: ${q}\n\nWarmly,\n${brand}`,
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
  } catch (err) {
    console.error("Unhandled error:", err);
    return bad(req, res, 500, "Server error.");
  }
}
