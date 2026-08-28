// PayPlus integration (docs.payplus.co.il). Flow:
//   1. createPaymentLink() — hosted page, customer enters card there (no PCI burden on
//      us); create_token:true asks PayPlus to hand back a reusable card token afterward.
//   2. Their server POSTs the result to our webhook; verifyCallbackSignature() confirms
//      it's genuinely from PayPlus (HMAC-SHA256 of the JSON body, base64, keyed with our
//      secret key — documented at docs.payplus.co.il/reference/validate-requests-received-from-payplus).
//   3. createRecurringSubscription() registers the actual monthly billing using the token
//      captured in step 1/2 — PayPlus then charges the saved card automatically each period.
//   4. cancelSubscription() stops future charges.
//
// Two things below are marked ASSUMPTION: PayPlus's docs don't fully spell out (a) the
// exact field name the card token arrives under in the callback payload — their own
// example payload doesn't show one, despite create_token:true supposedly returning it —
// and (b) items[].product_uid — whether it must be a product pre-created in the PayPlus
// dashboard, or accepts any string we choose. Both need a live sandbox test to confirm;
// this is the first thing to check when actually wiring this up against real credentials.

const crypto = require('crypto');
const { requireEnvOrThrow } = require('./util');

function baseUrl() {
  // PayPlus publishes a separate staging host — default to it so testing never risks a
  // real charge; set PAYPLUS_ENV=production to switch once verified.
  return process.env.PAYPLUS_ENV === 'production'
    ? 'https://restapi.payplus.co.il/api/v1.0'
    : 'https://restapidev.payplus.co.il/api/v1.0';
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'api-key': requireEnvOrThrow('PAYPLUS_API_KEY'),
    'secret-key': requireEnvOrThrow('PAYPLUS_SECRET_KEY'),
  };
}

async function callApi(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.result?.status === 'error' || json.results?.status === 'error') {
    const desc = json.result?.description || json.results?.description || `HTTP ${res.status}`;
    throw new Error(`PayPlus ${path} failed: ${desc}`);
  }
  return json;
}

// tier: one entry from config/pricing-tiers.json. userId/tierId are threaded through as
// more_info fields so the webhook can correlate the callback back to who paid for what.
async function createPaymentLink({ userId, tier, email, customerName, successUrl, failureUrl, callbackUrl }) {
  const json = await callApi('/PaymentPages/generateLink', {
    payment_page_uid: requireEnvOrThrow('PAYPLUS_PAYMENT_PAGE_UID'),
    amount: tier.price_ils_monthly,
    currency_code: 'ILS',
    create_token: true,
    sendEmailApproval: true,
    sendEmailFailure: true,
    customer: { customer_name: customerName || email, email },
    more_info: userId,
    more_info_2: tier.id,
    refURL_success: successUrl,
    refURL_failure: failureUrl,
    refURL_callback: callbackUrl,
  });
  return json.data.payment_page_link;
}

// HMAC-SHA256(JSON.stringify(rawBody), secret_key) -> base64, compared against the
// request's `hash` header. Pass the *exact* parsed body object used to compute this on
// PayPlus's side (i.e. JSON.parse of the raw request bytes) — re-serializing a mutated
// object could produce a different byte sequence and false-reject a real callback.
function verifyCallbackSignature(bodyObj, hashHeader, userAgentHeader) {
  if (userAgentHeader !== 'PayPlus') return false;
  if (!hashHeader) return false;
  const secret = requireEnvOrThrow('PAYPLUS_SECRET_KEY');
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(bodyObj)).digest('base64');
  return expected === hashHeader;
}

// Best-effort extraction — see the ASSUMPTION note at the top of this file re: the token
// field name. Logs the full `data` object when a token can't be found so a real callback
// during testing immediately reveals the actual field name to fix this against.
function parseCallbackPayload(body) {
  const txn = body.transaction || {};
  const data = body.data || {};
  const cardToken = data.card_token || data.token || data.card_information?.token || null;
  if (!cardToken) console.warn('[payplus] callback had no recognizable card token field — inspect body.data:', JSON.stringify(data));
  return {
    success: txn.status_code === '000',
    transactionUid: txn.uid,
    userId: txn.more_info,
    tierId: txn.more_info_2,
    customerUid: data.customer_uid,
    cardToken,
  };
}

function nextMonthDateString() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD — format assumed, confirm in testing
}

// The webhook's first (instant) charge already collected this period's payment, so the
// recurring schedule is registered to start billing from *next* period.
async function createRecurringSubscription({ cardToken, customerUid, tier }) {
  const json = await callApi('/RecurringPayments/Add', {
    terminal_uid: requireEnvOrThrow('PAYPLUS_TERMINAL_UID'),
    customer_uid: customerUid,
    card_token: cardToken,
    cashier_uid: requireEnvOrThrow('PAYPLUS_CASHIER_UID'),
    currency_code: 'ILS',
    instant_first_payment: false,
    recurring_type: 2, // monthly
    recurring_range: 1,
    number_of_charges: 0, // unlimited, until cancelled
    start_date: nextMonthDateString(),
    items: [{ product_uid: tier.id, quantity: 1, price: tier.price_ils_monthly }],
  });
  return json.data.recurring_payment_uid;
}

async function cancelSubscription(recurringUid) {
  await callApi(`/RecurringPayments/DeleteRecurring/${recurringUid}`, {
    terminal_uid: requireEnvOrThrow('PAYPLUS_TERMINAL_UID'),
  });
}

module.exports = { createPaymentLink, verifyCallbackSignature, parseCallbackPayload, createRecurringSubscription, cancelSubscription };
