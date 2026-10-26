# Prayed & Poured Out — checkout page

## Put it on Netlify (about 10 minutes)
1. Create a free GitHub account if you don't have one. Make a new repository and upload everything in this folder (drag the files into "Add file → Upload files").
2. In Netlify: **Add new site → Import an existing project → GitHub** and pick that repository. Leave the build settings as they are and click Deploy.
3. In Netlify: **Site configuration → Environment variables → Add**. Name: `STRIPE_SECRET_KEY`. Value: your **test** secret key from Stripe (Developers → API keys → Secret key, starts with `sk_test_`). Then **Deploys → Trigger deploy**.
   (Netlify's drag-and-drop "Drop" upload can't run the checkout function, which is why this uses GitHub.)

## Test it
Use card `4242 4242 4242 4242`, any future date, any CVC, and an Alabama address.
Check in Stripe → Subscriptions that the next invoice date is the 20th and that sales tax shows on it.

## Before you go live
- Activate your live Stripe account, recreate the same products in live mode **with the same lookup keys**
  (post_kit_monthly, paint_kit_monthly, post_paint_monthly, paint_kit_shipping_monthly, local_pickup_monthly, gift_a_year, banner_missions), and turn on Stripe Tax with your Alabama registration.
- Swap the Netlify variable to your `sk_live_` key and redeploy.
- In `public/index.html`, replace the "Manage or cancel my subscription" link with the live customer portal link (Settings → Billing → Customer portal).
