export const SUPPORTED_CURRENCIES = {
  BRL: { code: 'BRL', symbol: 'R$', label: 'Brasil (BRL)', flag: '🇧🇷', rateFromBrl: 1 },
  USD: { code: 'USD', symbol: '$', label: 'Dólar (USD)', flag: '🇺🇸', rateFromBrl: 0.20 },
  EUR: { code: 'EUR', symbol: '€', label: 'Euro (EUR)', flag: '🇪🇺', rateFromBrl: 0.18 },
  GBP: { code: 'GBP', symbol: '£', label: 'Libra (GBP)', flag: '🇬🇧', rateFromBrl: 0.15 },
  CHF: { code: 'CHF', symbol: 'CHF', label: 'Franco Suíço (CHF)', flag: '🇨🇭', rateFromBrl: 0.18 },
};

const EURO_COUNTRIES = new Set([
  'PT', 'ES', 'FR', 'DE', 'IT', 'NL', 'BE', 'AT', 'IE', 'FI',
  'GR', 'LU', 'MT', 'CY', 'EE', 'LV', 'LT', 'SK', 'SI', 'HR'
]);

export function detectCurrencyFromRequest(req) {
  const queryCurr = String(req.query?.currency || '').trim().toUpperCase();
  if (SUPPORTED_CURRENCIES[queryCurr]) return queryCurr;

  const country = String(
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    'BR'
  ).trim().toUpperCase();

  if (country === 'BR') return 'BRL';
  if (country === 'GB' || country === 'UK') return 'GBP';
  if (country === 'CH' || country === 'LI') return 'CHF';
  if (EURO_COUNTRIES.has(country)) return 'EUR';
  return 'USD';
}

export const VIP_TIER_PRICING = {
  BRL: {
    m1: { de: 48.99, por: 25.99 },
    m2: { de: 89.90, por: 44.99 },
    m3: { de: 129.90, por: 59.99 },
    m12: { de: 399.90, por: 149.99 },
  },
  USD: {
    m1: { de: 24.99, por: 14.99 },
    m2: { de: 44.99, por: 24.99 },
    m3: { de: 64.99, por: 34.99 },
    m12: { de: 159.99, por: 89.99 },
  },
  EUR: {
    m1: { de: 22.99, por: 13.99 },
    m2: { de: 39.99, por: 22.99 },
    m3: { de: 59.99, por: 31.99 },
    m12: { de: 149.99, por: 84.99 },
  },
  GBP: {
    m1: { de: 19.99, por: 11.99 },
    m2: { de: 34.99, por: 19.99 },
    m3: { de: 49.99, por: 27.99 },
    m12: { de: 129.99, por: 74.99 },
  },
  CHF: {
    m1: { de: 22.90, por: 13.90 },
    m2: { de: 39.90, por: 22.90 },
    m3: { de: 59.90, por: 31.90 },
    m12: { de: 149.90, por: 84.90 },
  },
};

export function convertBrlToCurrency(brlAmount, targetCurrency = 'BRL') {
  const curr = SUPPORTED_CURRENCIES[targetCurrency] || SUPPORTED_CURRENCIES.BRL;
  if (curr.code === 'BRL') return Number(brlAmount || 0);
  const raw = Number(brlAmount || 0) * curr.rateFromBrl;
  const ceilInt = Math.max(1, Math.ceil(raw));
  return Number((ceilInt - 0.01).toFixed(2));
}