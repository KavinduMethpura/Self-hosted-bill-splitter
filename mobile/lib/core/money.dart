// Port of packages/core/src/money.ts. Keep the arithmetic identical so web,
// server and mobile compute the same numbers (checked by shared fixtures).

import 'package:intl/intl.dart';

const _zeroDecimals = {
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
};
const _threeDecimals = {'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'};

const commonCurrencies = [
  'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD',
  'INR', 'LKR', 'IDR', 'MYR', 'THB', 'PHP', 'VND', 'KRW', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'ZAR', 'AED', 'KWD', 'BHD',
];

int currencyDecimals(String c) {
  if (_zeroDecimals.contains(c)) return 0;
  if (_threeDecimals.contains(c)) return 3;
  return 2;
}

bool isCurrencyCode(Object? c) => c is String && RegExp(r'^[A-Z]{3}$').hasMatch(c);

int roundHalfAway(double x) {
  final r = (x.abs() + 0.5).floor();
  return x < 0 ? -r : r;
}

int? parseAmount(String input, String currency) {
  final s = input.trim().replaceAll(RegExp(r'[,\s]'), '');
  final m = RegExp(r'^(\d+)(?:\.(\d*))?$').firstMatch(s);
  if (m == null) return null;
  final dec = currencyDecimals(currency);
  final whole = m.group(1)!;
  final frac = m.group(2) ?? '';
  if (frac.length > dec) return null;
  final digits = whole + frac.padRight(dec, '0');
  if (digits.length > 15) return null; // stay within JS safe integers
  return int.parse(digits);
}

String minorToDecimal(int minor, String currency) {
  final dec = currencyDecimals(currency);
  final neg = minor < 0;
  final digits = minor.abs().toString().padLeft(dec + 1, '0');
  final whole = dec == 0 ? digits : digits.substring(0, digits.length - dec);
  final frac = dec == 0 ? '' : '.${digits.substring(digits.length - dec)}';
  return '${neg ? '-' : ''}$whole$frac';
}

String formatMoney(int minor, String currency) {
  final dec = currencyDecimals(currency);
  try {
    return NumberFormat.simpleCurrency(name: currency, decimalDigits: dec).format(minor / _pow10[dec]);
  } catch (_) {
    return '${minorToDecimal(minor, currency)} $currency';
  }
}

const _pow10 = [1, 10, 100, 1000];

int convertMinor(int amountMinor, String from, String to, double rate) {
  if (from == to) return amountMinor;
  final shift = currencyDecimals(to) - currencyDecimals(from);
  double v = amountMinor * rate;
  if (shift > 0) {
    v = v * _pow10[shift];
  } else if (shift < 0) {
    v = v / _pow10[-shift];
  }
  return roundHalfAway(v);
}
