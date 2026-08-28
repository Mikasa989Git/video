import { getSession, authedFetch, signOut } from './auth-client.js';

const tierGrid = document.getElementById('tier-grid');
const statusNotice = document.getElementById('status-notice');
const currentPlanNotice = document.getElementById('current-plan-notice');
const serverErrorEl = document.getElementById('pricing-server-error');
const signoutBtn = document.getElementById('signout-btn');

const params = new URLSearchParams(window.location.search);
const status = params.get('status');
if (status === 'success') {
  statusNotice.textContent = "Payment received — it may take a few seconds for your plan to activate.";
  statusNotice.hidden = false;
} else if (status === 'failure') {
  statusNotice.textContent = 'Payment did not go through. You can try again below.';
  statusNotice.hidden = false;
}

function tierCard(tier, activeTierId) {
  const isCurrent = tier.id === activeTierId;
  const card = document.createElement('div');
  card.className = 'tier-card' + (isCurrent ? ' current' : '');
  card.innerHTML = `
    <h2>${tier.name}</h2>
    <p class="tier-price">&#8362;${tier.price_ils_monthly}<span>/month</span></p>
    <ul class="tier-features">
      ${(tier.features || []).map(f => `<li>${f}</li>`).join('')}
    </ul>
    <button type="button" class="primary-btn tier-btn" ${isCurrent ? 'disabled' : ''}>
      ${isCurrent ? 'Current plan' : 'Subscribe'}
    </button>
  `;
  if (!isCurrent) {
    card.querySelector('.tier-btn').addEventListener('click', () => subscribe(tier.id));
  }
  return card;
}

async function subscribe(tierId) {
  serverErrorEl.hidden = true;
  const session = await getSession();
  if (!session) {
    window.location.href = '/login.html?next=' + encodeURIComponent('/pricing.html');
    return;
  }
  try {
    const res = await authedFetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    window.location.href = data.paymentPageLink; // PayPlus's hosted payment page
  } catch (err) {
    serverErrorEl.textContent = err.message;
    serverErrorEl.hidden = false;
  }
}

async function load() {
  const tiers = await (await fetch('/api/pricing-tiers')).json();
  const session = await getSession();

  let activeTierId = null;
  if (session) {
    signoutBtn.hidden = false;
    signoutBtn.addEventListener('click', signOut);
    try {
      const me = await (await authedFetch('/api/me')).json();
      if (me.subscription) {
        activeTierId = me.subscription.tier_id;
        currentPlanNotice.textContent = `Current plan: ${me.subscription.tier.name} — ${me.subscription.videos_used_current_period}/${me.subscription.tier.included_videos_per_month} videos used this period.`;
        currentPlanNotice.hidden = false;
      }
    } catch { /* not fatal — just show plans without a "current" highlight */ }
  }

  tierGrid.innerHTML = '';
  for (const tier of tiers) tierGrid.appendChild(tierCard(tier, activeTierId));
}

load();
