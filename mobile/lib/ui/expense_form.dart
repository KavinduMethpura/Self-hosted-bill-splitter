import 'package:flutter/material.dart';

import '../core/money.dart';
import '../core/ops.dart';
import '../core/splits.dart';
import '../data/repository.dart';
import 'widgets.dart';

class ExpenseFormScreen extends StatefulWidget {
  final GroupController g;
  final ExpenseView? expense;
  const ExpenseFormScreen({super.key, required this.g, this.expense});

  @override
  State<ExpenseFormScreen> createState() => _ExpenseFormScreenState();
}

class _ExpenseFormScreenState extends State<ExpenseFormScreen> {
  GroupController get g => widget.g;
  ExpenseView? get x => widget.expense;
  bool get isTransfer => x?.kind == 'transfer';

  late final _desc = TextEditingController(text: x?.description ?? '');
  late final _amount = TextEditingController(text: x == null ? '' : minorToDecimal(x!.amount, x!.currency));
  late final _rate = TextEditingController(text: x != null && x!.currency != g.group.baseCurrency ? '${x!.rate}' : '');
  late String _currency = x?.currency ?? g.group.baseCurrency;
  late String _paidBy = x?.paidBy ?? g.me!;
  late DateTime _date = DateTime.tryParse(x?.date ?? '') ?? DateTime.now();
  late String _mode = x?.split.mode ?? 'equal';
  final Map<String, TextEditingController> _values = {};
  final Set<String> _included = {};

  @override
  void initState() {
    super.initState();
    if (x == null) {
      _included.addAll(g.members.map((m) => m.id));
    } else {
      for (final e in x!.split.entries.entries) {
        if (_mode == 'equal') {
          if (e.value > 0) _included.add(e.key);
        } else {
          _ctrl(e.key).text = _mode == 'exact' ? minorToDecimal(e.value.toInt(), x!.currency) : _fmtNum(e.value);
        }
      }
    }
  }

  String _fmtNum(num v) => v == v.truncate() ? v.toInt().toString() : v.toString();
  TextEditingController _ctrl(String id) => _values.putIfAbsent(id, TextEditingController.new);

  List<MemberView> get people {
    final ids = g.members.map((m) => m.id).toSet()
      ..addAll(x?.split.entries.keys ?? const [])
      ..addAll([if (x != null) x!.paidBy]);
    return g.allMembers.where((m) => ids.contains(m.id)).toList();
  }

  String get base => g.group.baseCurrency;
  int? get amount => parseAmount(_amount.text, _currency);
  double? get lastRate => g.expenses.where((e) => e.currency == _currency && e.id != x?.id).firstOrNull?.rate;
  double get rate => _currency == base ? 1 : (double.tryParse(_rate.text) ?? lastRate ?? double.nan);
  bool get rateOk => _currency == base || (rate.isFinite && rate > 0);

  Split get split {
    if (isTransfer) {
      final to = x!.split.entries.keys.firstOrNull ?? '';
      return Split('exact', {to: amount ?? 0});
    }
    final entries = <String, num>{};
    for (final p in people) {
      num v;
      if (_mode == 'equal') {
        v = _included.contains(p.id) ? 1 : 0;
      } else if (_mode == 'exact') {
        final t = _ctrl(p.id).text;
        v = parseAmount(t.isEmpty ? '0' : t, _currency) ?? double.nan;
      } else {
        final t = _ctrl(p.id).text.trim();
        v = t.isEmpty ? 0 : (double.tryParse(t) ?? double.nan);
      }
      if (v != 0) entries[p.id] = v;
    }
    return Split(_mode, entries);
  }

  void _switchMode(String m) {
    final current = split.entries.keys.toList();
    final who = current.isEmpty ? people.map((p) => p.id).toList() : current;
    setState(() {
      _mode = m;
      _included
        ..clear()
        ..addAll(who);
      for (final c in _values.values) {
        c.clear();
      }
      for (final id in who) {
        _ctrl(id).text = switch (m) {
          'shares' => '1',
          'percent' => _fmtNum((10000 / who.length).round() / 100),
          _ => '',
        };
      }
    });
  }

  Future<void> _save() async {
    final a = amount;
    if (a == null) return;
    await g.edit('expense', x?.id ?? newId(), {
      'description': _desc.text.trim(),
      'amount': a,
      'currency': _currency,
      'rate': _currency == base ? 1 : rate,
      'paidBy': _paidBy,
      'split': split,
      'date': _date.toIso8601String().substring(0, 10),
      'kind': x?.kind ?? 'expense',
      if (x == null) 'deleted': false,
    });
    if (mounted) Navigator.pop(context);
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this expense?'),
        content: const Text('You can restore it from More → Recently deleted.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    await g.edit('expense', x!.id, {'deleted': true}, force: ['deleted']);
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final a = amount;
    final s = split;
    final badEntry = s.entries.values.any((v) => !v.isFinite || v < 0);
    final splitError = badEntry ? 'Check the numbers' : (a != null ? validateSplit(s, a) : null);
    final baseTotal = a != null && rateOk ? convertMinor(a, _currency, base, rate) : 0;
    final shares = splitError == null && a != null && rateOk ? computeShares(baseTotal, s) : <String, int>{};
    final canSave = a != null && a > 0 && rateOk && splitError == null && (isTransfer || _desc.text.trim().isNotEmpty);
    final live = x == null ? null : g.expenses.where((e) => e.id == x!.id).firstOrNull;

    String? hint;
    if (a != null && _mode == 'exact' && !badEntry) {
      final left = a - s.entries.values.fold<num>(0, (p, v) => p + v).toInt();
      hint = left == 0 ? 'All assigned' : left > 0 ? '${formatMoney(left, _currency)} left to assign' : '${formatMoney(-left, _currency)} too much';
    } else if (_mode == 'percent' && !badEntry) {
      hint = '${_fmtNum((s.entries.values.fold<num>(0, (p, v) => p + v) * 100).round() / 100)}% of 100%';
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(x == null ? 'Add expense' : (isTransfer ? 'Payment' : 'Edit expense')),
        actions: [
          if (x != null) IconButton(onPressed: _delete, icon: const Icon(Icons.delete_outline), tooltip: 'Delete'),
          TextButton(onPressed: canSave ? _save : null, child: const Text('Save')),
        ],
      ),
      body: ListenableBuilder(
        listenable: g,
        builder: (context, _) => ListView(padding: const EdgeInsets.all(16), children: [
          if (live != null && live.conflicts.isNotEmpty) ConflictCards(g: g, x: live),
          if (!isTransfer)
            TextField(
              controller: _desc,
              decoration: const InputDecoration(labelText: 'What was it for?'),
              maxLength: 200,
              onChanged: (_) => setState(() {}),
            ),
          Row(children: [
            Expanded(
              child: TextField(
                controller: _amount,
                decoration: InputDecoration(
                  labelText: 'Amount',
                  errorText: _amount.text.isNotEmpty && a == null ? 'Invalid amount for $_currency' : null,
                ),
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setState(() {}),
              ),
            ),
            const SizedBox(width: 12),
            DropdownButton<String>(
              value: _currency,
              items: [for (final c in {base, ...commonCurrencies}) DropdownMenuItem(value: c, child: Text(c))],
              onChanged: isTransfer ? null : (v) => setState(() => _currency = v ?? _currency),
            ),
          ]),
          if (_currency != base)
            TextField(
              controller: _rate,
              decoration: InputDecoration(
                labelText: 'Exchange rate: 1 $_currency = ? $base',
                hintText: lastRate != null ? '$lastRate (last used)' : 'e.g. 1.52',
                helperText: a != null && rateOk ? '= ${formatMoney(baseTotal, base)}' : null,
              ),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (_) => setState(() {}),
            ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                value: _paidBy,
                decoration: const InputDecoration(labelText: 'Paid by'),
                items: [
                  for (final p in people) DropdownMenuItem(value: p.id, child: Text(p.id == g.me ? '${p.name} (you)' : p.name)),
                ],
                onChanged: (v) => setState(() => _paidBy = v ?? _paidBy),
              ),
            ),
            const SizedBox(width: 12),
            OutlinedButton.icon(
              icon: const Icon(Icons.event),
              label: Text(_date.toIso8601String().substring(0, 10)),
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime(2000), lastDate: DateTime(2100));
                if (d != null) setState(() => _date = d);
              },
            ),
          ]),
          if (!isTransfer) ...[
            const SizedBox(height: 16),
            Text('Split', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'equal', label: Text('Equally')),
                ButtonSegment(value: 'exact', label: Text('Amounts')),
                ButtonSegment(value: 'percent', label: Text('%')),
                ButtonSegment(value: 'shares', label: Text('Shares')),
              ],
              selected: {_mode},
              onSelectionChanged: (v) => _switchMode(v.first),
            ),
            for (final p in people)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Avatar(name: p.name),
                title: Text(p.name),
                subtitle: shares[p.id] != null && _mode != 'exact' ? Text(formatMoney(shares[p.id]!, base)) : null,
                trailing: _mode == 'equal'
                    ? Checkbox(
                        value: _included.contains(p.id),
                        onChanged: (v) => setState(() => v == true ? _included.add(p.id) : _included.remove(p.id)),
                      )
                    : SizedBox(
                        width: 110,
                        child: TextField(
                          controller: _ctrl(p.id),
                          textAlign: TextAlign.right,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: InputDecoration(hintText: '0', suffixText: _mode == 'percent' ? '%' : null),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
              ),
            if (hint != null)
              Text(hint, style: TextStyle(color: splitError != null ? Theme.of(context).colorScheme.error : null)),
            if (splitError != null && _mode != 'exact' && _mode != 'percent')
              Text(splitError, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
        ]),
      ),
    );
  }
}
