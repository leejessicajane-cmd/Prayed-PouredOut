// Prayed & Poured Out — delivers digital kit downloads after a paid Stripe checkout.
// Uses the same STRIPE_SECRET_KEY environment variable as create-checkout.
//
//   GET ?session_id=cs_...           -> the PDF (add &check=1 for a JSON status check)
//   GET ?email=you@example.com       -> JSON list of kits bought with that email
//   GET ?email=...&kit=2026-11       -> the PDF, if that email bought that kit
//
// To add a new month: add a Stripe price with lookup key digital_kit_YYYY_MM,
// encrypt the PDF into /private (see README), and add a line to KITS below.

const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const KITS = {
  digital_kit_2026_11: {
    id: "2026-11",
    title: "November 2026 Digital Post Kit — Grace upon Grace",
    file: "PPO-November-2026-Digital-Post-Kit.pdf",
  },
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

// PDFs are stored encrypted (AES-256-GCM: 12-byte IV + 16-byte tag + data) so the public
// GitHub repo never holds a readable copy. Key: Netlify env var KIT_KEY (64 hex chars).
function decrypt(buf) {
  const key = Buffer.from(process.env.KIT_KEY || "", "hex");
  if (key.length !== 32) throw new Error("KIT_KEY is missing or invalid");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = require("crypto").createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

function readKitFile(file) {
  file = file + ".enc";
  const candidates = [
    path.join(process.cwd(), "private", file),
    path.join(__dirname, "private", file),
    path.join(__dirname, "..", "..", "private", file),
    path.join("/var/task/private", file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return decrypt(fs.readFileSync(p));
  }
  throw new Error(`Kit file not found: ${file}`);
}

function pdfResponse(kit) {
  const data = readKitFile(kit.file);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${kit.file}"`,
      "Cache-Control": "private, no-store",
    },
    body: data.toString("base64"),
    isBase64Encoded: true,
  };
}

// Kits included in a completed, paid checkout session
async function kitsInSession(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items.data.price"] });
  const paid = session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  if (!paid) return { paid: false, kits: [], session };
  const kits = (session.line_items?.data || [])
    .map((li) => KITS[li.price?.lookup_key])
    .filter(Boolean);
  return { paid: true, kits, session };
}

async function kitsForEmail(email) {
  const found = new Map();
  for await (const s of stripe.checkout.sessions.list({
    customer_details: { email }, status: "complete", limit: 100,
    expand: ["data.line_items.data.price"],
  })) {
    if (!(s.payment_status === "paid" || s.payment_status === "no_payment_required")) continue;
    for (const li of s.line_items?.data || []) {
      const kit = KITS[li.price?.lookup_key];
      if (kit) found.set(kit.id, kit);
    }
  }
  return [...found.values()];
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });
  const q = event.queryStringParameters || {};

  try {
    if (q.session_id) {
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(q.session_id)) return json(400, { error: "That link doesn't look right." });
      const { paid, kits, session } = await kitsInSession(q.session_id);
      if (!paid || !kits.length) return json(402, { error: "We couldn't find a completed purchase for this link." });
      if (q.check) {
        return json(200, {
          ok: true,
          email: session.customer_details?.email || null,
          kits: kits.map((k) => ({ id: k.id, title: k.title })),
        });
      }
      const kit = kits.find((k) => k.id === q.kit) || kits[0];
      return pdfResponse(kit);
    }

    if (q.email) {
      const email = String(q.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Please enter a valid email." });
      const kits = await kitsForEmail(email);
      if (!kits.length) {
        return json(404, { error: "We couldn't find a digital kit purchase for that email. Try the email on your receipt, or email prayedandpouredout@gmail.com." });
      }
      if (q.kit) {
        const kit = kits.find((k) => k.id === q.kit);
        if (!kit) return json(404, { error: "That kit isn't on this email's purchases." });
        return pdfResponse(kit);
      }
      return json(200, { ok: true, kits: kits.map((k) => ({ id: k.id, title: k.title })) });
    }

    return json(400, { error: "Missing session_id or email" });
  } catch (err) {
    console.error(err);
    if (err && err.type === "StripeInvalidRequestError") {
      return json(404, { error: "We couldn't find that purchase." });
    }
    return json(500, { error: "Something went wrong. Please email prayedandpouredout@gmail.com and I'll send your kit." });
  }
};

exports._KITS = KITS;
