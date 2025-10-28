import PDFDocument from "pdfkit";
import sg from "@sendgrid/mail";
import OpenAI from "openai";

sg.setApiKey(process.env.SENDGRID_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const bad = (res, code, msg, extra = {}) =>
  res.status(code).json({ ok: false, error: msg, ...extra });

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const {
      q, email, first, last, dob, tob, country, city,
      tz = "", notes = "", consent = true, hcaptchaToken
    } = req.body || {};

    if (!q || !email || !first || !last || !dob || !tob || !country || !city)
      return bad(res, 400, "Missing required fields.");
    if (!hcaptchaToken) return bad(res, 400, "hCaptcha token missing.");

    // Verify hCaptcha
    const hcRes = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: process.env.HCAPTCHA_SECRET,
        response: hcaptchaToken
      })
    }).then(r => r.json());

    if (!hcRes.success) return bad(res, 400, "hCaptcha verification failed.");

    // Generate the text with OpenAI
    const prompt = `You are an expert natal chart interpreter. Compose a clear, empathetic reading that answers the question below...

User question: ${q}
Birth details:
- Name: ${first} ${last}
- DOB: ${dob}
- TOB: ${tob}
- City: ${city}, ${country}
- TZ: ${tz || "unspecified"}
- Notes: ${notes || "none"}`;

    const ai = await openai.responses.create({
      model: "gpt-4o",
      input: prompt,
      temperature: 0.7
    });
    const bodyText = ai.output_text || "No content generated.";

    // Build PDF
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", c => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fontSize(20).text("Personalized Reading", { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Question: ${q}`);
      doc.text(`Name: ${first} ${last}`);
      doc.text(`DOB: ${dob}`);
      doc.text(`TOB: ${tob}`);
      doc.text(`City: ${city}, ${country}`);
      doc.text(`TZ: ${tz}`);
      doc.moveDown();
      doc.fontSize(11).text(bodyText);
      doc.end();
    });

    // Send email
    await sg.send({
      to: email,
      from: process.env.FROM_EMAIL,
      subject: "Your personalized astrology reading",
      text: `Hi ${first},\n\nAttached is your personalized PDF reading.\n\nRegards,\nAstrology Intake`,
      attachments: [
        {
          content: pdfBuffer.toString("base64"),
          filename: "reading.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }
      ]
    });

    return res.status(200).json({ ok: true, message: "Email sent successfully." });
  } catch (err) {
    console.error(err);
    return bad(res, 500, "Server error.");
  }
}
