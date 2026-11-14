// Money is always stored as integer minor units (cents, yen, fils...).
// Every function here is mirrored 1:1 in mobile/lib/core/money.dart so that
// web, server and mobile compute identical numbers.

const ZERO_DECIMALS = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMALS = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD',
  'INR', 'LKR', 'IDR', 'MYR', 'THB', 'PHP', 'VND', 'KRW', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'ZAR', 'AED', 'KWD', 'BHD',
];

export function currencyDecimals(currency: string): number {
  if (ZERO_DECIMALS.has(currency)) return 0;
  if (THREE_DECIMALS.has(currency)) return 3;
  return 2;
}

export function isCurrencyCode(c: unknown): c is string {
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c);
}

/** Round half away from zero. Written without Math.round so Dart matches exactly. */
export function roundHalfAway(x: number): number {
  const r = Math.floor(Math.abs(x) + 0.5);
  return x < 0 ? -r : r;
}

/**
 * Parse a user-typed amount ("12", "12.5", "1,234.56") into minor units
 * using string arithmetic only (no float error). Returns null if invalid or
 * if it has more decimals than the currency allows.
 */
export function parseAmount(input: string, currency: string): number | null {
  const s = input.trim().replace(/[,\s]/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const dec = currencyDecimals(currency);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > dec) return null;
  const minor = Number(whole + frac.padEnd(dec, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Plain decimal string for a minor amount, e.g. 1234 USD -> "12.34". */
export function minorToDecimal(minor: number, currency: string): string {
  const dec = currencyDecimals(currency);
  const neg = minor < 0;
  const digits = Math.abs(minor).toString().padStart(dec + 1, '0');
  const whole = dec === 0 ? digits : digits.slice(0, -dec);
  const frac = dec === 0 ? '' : '.' + digits.slice(-dec);
  return (neg ? '-' : '') + whole + frac;
}

export function formatMoney(minor: number, currency: string, locale?: string): string {
  const dec = currencyDecimals(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(minor / 10 ** dec);
  } catch {
    return `${minorToDecimal(minor, currency)} ${currency}`;
  }
}

/**
 * Convert minor units of `from` into minor units of `to`.
 * `rate` = how many units of `to` one unit of `from` is worth.
 */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  if (from === to) return amountMinor;
  const shift = currencyDecimals(to) - currencyDecimals(from);
  let v = amountMinor * rate;
  if (shift > 0) v = v * POW10[shift]!;
  else if (shift < 0) v = v / POW10[-shift]!;
  return roundHalfAway(v);
}

const POW10 = [1, 10, 100, 1000];
