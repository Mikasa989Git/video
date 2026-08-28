import { getSession } from './auth-client.js';

const ctaHero = document.getElementById('cta-hero-btn');
const ctaNav = document.getElementById('cta-nav-btn');
const appLink = document.getElementById('app-link');

getSession().then((session) => {
  const dest = session ? '/app.html' : '/pricing.html';
  const label = session ? 'My videos' : 'Get started';
  ctaHero.href = dest;
  ctaHero.textContent = label;
  ctaNav.href = session ? '/app.html' : '/login.html';
  ctaNav.textContent = session ? 'My videos' : 'Sign in';
  appLink.href = session ? '/app.html' : '/login.html';
});
