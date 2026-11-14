// Port of packages/core/src/ledger.ts.

import 'money.dart';
import 'ops.dart';
import 'settle.dart';
import 'splits.dart';

int baseAmount(ExpenseView x, String base) => convertMinor(x.amount, x.currency, base, x.rate);

Map<String, int> expenseShares(ExpenseView x, String base) => computeShares(baseAmount(x, base), x.split);

class Ledger {
  final String baseCurrency;
  final Map<String, int> balances;
  final Map<String, int> spent;
  final List<Transfer> transfers;
  final int total;
  const Ledger(this.baseCurrency, this.balances, this.spent, this.transfers, this.total);
}

Ledger computeLedger(GroupState state) {
  final base = groupView(state).baseCurrency;
  final balances = <String, int>{};
  final spent = <String, int>{};
  for (final m in memberViews(state, includeDeleted: true)) {
    balances[m.id] = 0;
    spent[m.id] = 0;
  }
  var total = 0;
  for (final x in expenseViews(state)) {
    if (x.paidBy.isEmpty) continue;
    final shares = expenseShares(x, base);
    if (shares.isEmpty) continue;
    final amt = shares.values.fold<int>(0, (a, b) => a + b);
    balances[x.paidBy] = (balances[x.paidBy] ?? 0) + amt;
    for (final e in shares.entries) {
      balances[e.key] = (balances[e.key] ?? 0) - e.value;
      if (x.kind == 'expense') spent[e.key] = (spent[e.key] ?? 0) + e.value;
    }
    if (x.kind == 'expense') total += amt;
  }
  return Ledger(base, balances, spent, settle(balances), total);
}

String _cell(Object v) {
  var s = v.toString();
  if (v is String && RegExp(r'^[=+\-@\t\r]').hasMatch(s)) s = "'$s";
  return RegExp(r'[",\n\r]').hasMatch(s) ? '"${s.replaceAll('"', '""')}"' : s;
}

String _num(double v) => v == v.truncateToDouble() ? v.toInt().toString() : v.toString();

String exportCsv(GroupState state) {
  final g = groupView(state);
  final members = memberViews(state, includeDeleted: true);
  String nameOf(String id) => members.where((m) => m.id == id).firstOrNull?.name ?? id;
  final rows = <List<Object>>[
    [
      'Date', 'Description', 'Type', 'Paid by', 'Amount', 'Currency', 'Exchange rate',
      'Amount (${g.baseCurrency})', 'Split', ...members.map((m) => '${m.name} share (${g.baseCurrency})'),
    ],
  ];
  for (final x in expenseViews(state).reversed) {
    final shares = expenseShares(x, g.baseCurrency);
    rows.add([
      x.date, x.description, x.kind, nameOf(x.paidBy), minorToDecimal(x.amount, x.currency), x.currency,
      x.currency == g.baseCurrency ? '1' : _num(x.rate),
      minorToDecimal(baseAmount(x, g.baseCurrency), g.baseCurrency), x.split.mode,
      ...members.map((m) => minorToDecimal(shares[m.id] ?? 0, g.baseCurrency)),
    ]);
  }
  final ledger = computeLedger(state);
  rows
    ..add([])
    ..add(['Balances'])
    ..addAll(members.map((m) => [m.name, minorToDecimal(ledger.balances[m.id] ?? 0, g.baseCurrency)]))
    ..add([])
    ..add(['Suggested payments'])
    ..addAll(ledger.transfers.map((t) => ['${nameOf(t.from)} pays ${nameOf(t.to)}', minorToDecimal(t.amount, g.baseCurrency)]));
  return '${rows.map((r) => r.map(_cell).join(',')).join('\r\n')}\r\n';
}
