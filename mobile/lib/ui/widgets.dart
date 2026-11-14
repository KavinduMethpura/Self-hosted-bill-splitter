import 'package:flutter/material.dart';

import '../core/money.dart';
import '../core/ops.dart';
import '../core/splits.dart';
import '../data/repository.dart';

class Avatar extends StatelessWidget {
  final String name;
  const Avatar({super.key, required this.name});

  @override
  Widget build(BuildContext context) {
    var h = 0;
    for (final c in name.codeUnits) {
      h = (h * 31 + c) % 360;
    }
    return CircleAvatar(
      backgroundColor: HSLColor.fromAHSL(1, h.toDouble(), 0.45, 0.45).toColor(),
      foregroundColor: Colors.white,
      child: Text(name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase()),
    );
  }
}

Color? moneyColor(BuildContext context, int v) {
  if (v == 0) return null;
  final dark = Theme.of(context).brightness == Brightness.dark;
  return v > 0 ? (dark ? const Color(0xFF4CC98B) : const Color(0xFF0F7A4A)) : (dark ? const Color(0xFFF07C71) : const Color(0xFFB4352B));
}

String shortDate(String d) {
  final dt = DateTime.tryParse(d);
  if (dt == null) return d;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${dt.day}\n${months[dt.month - 1]}';
}

class SyncChip extends StatelessWidget {
  final GroupController g;
  const SyncChip({super.key, required this.g});

  @override
  Widget build(BuildContext context) {
    final (label, icon) = switch (g.status) {
      SyncStatus.offline => ('Offline', Icons.cloud_off),
      SyncStatus.error => ('Sync failed', Icons.sync_problem),
      SyncStatus.notFound => ('Not found', Icons.error_outline),
      _ when g.pending > 0 || g.status == SyncStatus.syncing => ('Syncing', Icons.sync),
      _ => ('Synced', Icons.cloud_done),
    };
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ActionChip(
        avatar: Icon(icon, size: 18),
        label: Text(g.pending > 0 ? '$label · ${g.pending}' : label),
        tooltip: g.error,
        onPressed: g.sync,
      ),
    );
  }
}

const _labels = {
  'description': 'Description', 'amount': 'Amount', 'currency': 'Currency', 'rate': 'Exchange rate',
  'paidBy': 'Paid by', 'split': 'Split', 'date': 'Date', 'kind': 'Type', 'deleted': 'Deleted',
  'name': 'Name', 'baseCurrency': 'Main currency',
};

/// Both versions of every field two people edited at once; tap one to keep it.
class ConflictCards extends StatelessWidget {
  final GroupController g;
  final ExpenseView x;
  const ConflictCards({super.key, required this.g, required this.x});

  String _show(String field, Object? v) {
    if (field == 'deleted') return v == true ? 'Delete it' : 'Keep it';
    if (field == 'amount' && v is num) return formatMoney(v.toInt(), x.currency);
    if (field == 'paidBy' && v is String) return g.nameOf(v);
    if (field == 'split') {
      final s = Split.fromJson(v);
      if (s == null) return '?';
      final parts = s.entries.entries.where((e) => e.value > 0).map((e) => s.mode == 'equal'
          ? g.nameOf(e.key)
          : '${g.nameOf(e.key)} ${e.value}${s.mode == 'percent' ? '%' : ''}');
      return '${s.mode}: ${parts.join(', ')}';
    }
    return '$v';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(children: [
      for (final c in x.conflicts)
        Card(
          color: scheme.tertiaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                c.field == 'deleted'
                    ? 'Deleted while being edited. ${_who(c.versions[1])} deleted this, but ${_who(c.versions[0])} edited it at the same time.'
                    : '${_labels[c.field] ?? c.field} was changed by two people. Pick the right one:',
              ),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final v in c.versions)
                  OutlinedButton(
                    onPressed: () => g.edit('expense', x.id, {c.field: v.v}, force: [c.field]),
                    child: Text(c.field == 'deleted' ? _show(c.field, v.v) : '${_show(c.field, v.v)} · ${_who(v)}'),
                  ),
              ]),
            ]),
          ),
        ),
    ]);
  }

  String _who(Version v) => v.by == null ? 'Someone' : g.nameOf(v.by!);
}
