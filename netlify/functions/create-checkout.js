// Prayed & Poured Out — creates a Stripe Checkout Session.
// Needs one Netlify environment variable: STRIPE_SECRET_KEY
// (sk_test_... while testing, sk_live_... when you go live).

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Settings you may want to change ----
const TZ = "America/Chicago";
const BILL_DAY = 20;                       // every subscription bills on the 20th
const FOUNDING_DEADLINE = "2026-11-10";    // subscribe by this date = free November kit
const PAINT_KIT_LIMIT = 10;                // Paint Kits available per month
const BANNER_SHIPPING_CENTS = 1000;        // $10.00 flat-rate banner shipping — CHANGE to your real rate
// -----------------------------------------

// Today's date in Central time, as {y, m, d}
function centralToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

// Next 20th at 9:00 a.m. Central (15:00 UTC; 10 a.m. during daylight time).
// Returns null if today IS the 20th — then Stripe charges right away and keeps the 20th.
function nextBillingAnchor(now = new Date()) {
  const { y, m, d } = centralToday(now);
  if (d === BILL_DAY) return null;
  let year = y, month = m; // 1-12
  if (d > BILL_DAY) { month += 1; if (month > 12) { month = 1; year += 1; } }
  return Math.floor(Date.UTC(year, month - 1, BILL_DAY, 15, 0, 0) / 1000);
}

// Which month's kit the first one will be (for your packing list)
function firstKitMonth(now = new Date()) {
  const { y, m, d } = centralToday(now);
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (iso <= FOUNDING_DEADLINE) return { label: "November 2026 (free founding kit)", founding: true };
  let add = d <= BILL_DAY ? 1 : 2;
  const dt = new Date(Date.UTC(y, m - 1 + add, 1));
  const label = dt.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { label, founding: false };
}

async function priceId(lookupKey) {
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!res.data.length) throw new Error(`No active price with lookup key ${lookupKey}`);
  return res.data[0].id;
}

async function paintKitsTaken(paintPriceId) {
  let count = 0;
  for (const status of ["active", "trialing", "past_due"]) {
    for await (const sub of stripe.subscriptions.list({ price: paintPriceId, status, limit: 100 })) {
      if (!sub.cancel_at_period_end) count += 1;
    }
  }
  return count;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let item, quantity;
  try {
    ({ item, quantity } = JSON.parse(event.body || "{}"));
  } catch {
    return json(400, { error: "Bad request" });
  }

  const site = process.env.URL || `https://${event.headers.host}`;
  const base = {
    // Sales tax is OFF until the Netlify variable TAX_ENABLED is set to "true"
    automatic_tax: { enabled: process.env.TAX_ENABLED === "true" },
    billing_address_collection: "required",
    shipping_address_collection: { allowed_countries: ["US"] },
    phone_number_collection: { enabled: true },
    success_url: `${site}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/`,
    allow_promotion_codes: false,
  };

  try {
    let params;

    if (item === "post_kit" || item === "paint_kit") {
      const lineItems = [];
      if (item === "post_kit") {
        lineItems.push({ price: await priceId("post_kit_monthly"), quantity: 1 });
      } else {
        const paintPrice = await priceId("paint_kit_monthly");
        if ((await paintKitsTaken(paintPrice)) >= PAINT_KIT_LIMIT) {
          return json(409, { error: "The Paint Kit is full this month. Please check back next month!" });
        }
        lineItems.push({ price: paintPrice, quantity: 1 });
        lineItems.push({ price: await priceId("paint_kit_shipping_monthly"), quantity: 1 });
      }

      const first = firstKitMonth();
      const anchor = nextBillingAnchor();
      const subscription_data = {
        metadata: { kit: item, first_kit: first.label, founding_member: String(first.founding) },
      };
      if (anchor) {
        subscription_data.billing_cycle_anchor = anchor;
        subscription_data.proration_behavior = "none"; // nothing charged today; first charge on the 20th
      }

      params = {
        ...base,
        mode: "subscription",
        line_items: lineItems,
        subscription_data,
        custom_text: {
          submit: {
            message: anchor
              ? `Your card is saved today and first charged on the ${BILL_DAY}th. Your first kit: ${first.label}.`
              : `Your first kit: ${first.label}. You'll be billed on the ${BILL_DAY}th each month.`,
          },
        },
      };
    } else if (item === "gift_year") {
      params = {
        ...base,
        mode: "payment",
        line_items: [{ price: await priceId("gift_a_year"), quantity: 1 }],
        custom_fields: [
          { key: "recipient_name", label: { type: "custom", custom: "Gift recipient's name" }, type: "text" },
          {
            key: "gift_message", optional: true,
            label: { type: "custom", custom: "Gift note (optional)" }, type: "text",
            text: { maximum_length: 255 },
          },
        ],
        custom_text: { shipping_address: { message: "Enter the gift recipient's mailing address." } },
        payment_intent_data: { metadata: { item: "gift_a_year" } },
      };
    } else if (item === "banner") {
      const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 10);
      params = {
        ...base,
        mode: "payment",
        line_items: [{
          price: await priceId("banner_missions"), quantity: qty,
          adjustable_quantity: { enabled: true, minimum: 1, maximum: 10 },
        }],
        shipping_options: [
          { shipping_rate_data: {
              display_name: "Local delivery (Spanish Fort / Baldwin County)",
              type: "fixed_amount", fixed_amount: { amount: 0, currency: "usd" },
              tax_behavior: "exclusive", tax_code: "txcd_92010001" } },
          { shipping_rate_data: {
              display_name: "Flat-rate shipping",
              type: "fixed_amount", fixed_amount: { amount: BANNER_SHIPPING_CENTS, currency: "usd" },
              tax_behavior: "exclusive", tax_code: "txcd_92010001" } },
        ],
        custom_fields: [
          { key: "banner_text", label: { type: "custom", custom: "What should your banner say?" }, type: "text",
            text: { maximum_length: 255 } },
        ],
        payment_intent_data: { metadata: { item: "banner_missions" } },
      };
    } else {
      return json(400, { error: "Unknown item" });
    }

    const session = await stripe.checkout.sessions.create(params);
    return json(200, { url: session.url });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Something went wrong starting checkout. Please try again." });
  }
};

// exported for testing
exports._nextBillingAnchor = nextBillingAnchor;
exports._firstKitMonth = firstKitMonth;
