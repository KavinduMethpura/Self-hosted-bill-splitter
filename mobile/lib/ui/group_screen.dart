import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../core/ledger.dart';
import '../core/money.dart';
import '../core/ops.dart';
import '../core/splits.dart';
import '../data/repository.dart';
import 'expense_form.dart';
import 'widgets.dart';

class GroupScreen extends StatefulWidget {
  final AppServices services;
  final String groupId;
  const GroupScreen({super.key, required this.services, required this.groupId});

  @override
  State<GroupScreen> createState() => _GroupScreenState();
}

class _GroupScreenState extends State<GroupScreen> {
  late final GroupController g = widget.services.controller(widget.groupId);

  @override
  void dispose() {
    widget.services.dispose(widget.groupId);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: g,
      builder: (context, _) {
        if (!g.loaded) return const Scaffold(body: Center(child: CircularProgressIndicator()));
        if (!g.exists) return _NotReady(g: g);
        final me = g.me;
        if (me == null || !g.allMembers.any((m) => m.id == me)) return _WhoAreYou(g: g);
        return DefaultTabController(
          length: 4,
          child: Scaffold(
            appBar: AppBar(
              title: Text(g.group.name),
              actions: [SyncChip(g: g)],
              bottom: const TabBar(isScrollable: false, tabs: [
                Tab(text: 'Expenses'),
                Tab(text: 'Balances'),
                Tab(text: 'People'),
                Tab(text: 'More'),
              ]),
            ),
            floatingActionButton: FloatingActionButton.extended(
              onPressed: () => openExpense(context, g, null),
              icon: const Icon(Icons.add),
              label: const Text('Add expense'),
            ),
            body: TabBarView(children: [
              _ExpensesTab(g: g, me: me),
              _BalancesTab(g: g, me: me),
              _PeopleTab(g: g, me: me),
              _MoreTab(g: g, me: me),
            ]),
          ),
        );
      },
    );
  }
}

void openExpense(BuildContext context, GroupController g, ExpenseView? x) {
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => ExpenseFormScreen(g: g, expense: x)));
}

class _NotReady extends StatelessWidget {
  final GroupController g;
  const _NotReady({required this.g});

  @override
  Widget build(BuildContext context) {
    final (title, body) = switch (g.status) {
      SyncStatus.notFound => ('Group not found', 'Check the link. Groups only exist on the server they were created on.'),
      SyncStatus.offline => ("You're offline", 'Open this group once while online to download it. After that it works offline.'),
      SyncStatus.error => ("Couldn't load the group", g.error ?? ''),
      _ => ('Downloading group…', ''),
    };
    return Scaffold(
      appBar: AppBar(),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(title, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(body, textAlign: TextAlign.center),
            if (g.status == SyncStatus.error || g.status == SyncStatus.offline) ...[
              const SizedBox(height: 16),
              OutlinedButton(onPressed: g.sync, child: const Text('Try again')),
            ],
          ]),
        ),
      ),
    );
  }
}

class _WhoAreYou extends StatefulWidget {
  final GroupController g;
  const _WhoAreYou({required this.g});
  @override
  State<_WhoAreYou> createState() => _WhoAreYouState();
}

class _WhoAreYouState extends State<_WhoAreYou> {
  final _name = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final g = widget.g;
    return Scaffold(
      appBar: AppBar(title: Text(g.group.name)),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Who are you?', style: Theme.of(context).textTheme.headlineSmall),
        const Text("Pick your name so we know who's adding expenses. No account needed."),
        const SizedBox(height: 12),
        for (final m in g.members)
          ListTile(
            leading: Avatar(name: m.name),
            title: Text(m.name),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => g.setMe(m.id),
          ),
        const Divider(),
        Row(children: [
          Expanded(child: TextField(controller: _name, decoration: const InputDecoration(hintText: "I'm not on the list: my name"))),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: () async {
              final name = _name.text.trim();
              if (name.isEmpty) return;
              final id = newId();
              await g.setMe(id);
              await g.edit('member', id, {'name': name});
            },
            child: const Text('Join'),
          ),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------

class _ExpensesTab extends StatelessWidget {
  final GroupController g;
  final String me;
  const _ExpensesTab({required this.g, required this.me});

  @override
  Widget build(BuildContext context) {
    final base = g.group.baseCurrency;
    final list = g.expenses;
    final my = g.ledger.balances[me] ?? 0;
    final conflicted = list.where((x) => x.conflicts.isNotEmpty).length;
    final scheme = Theme.of(context).colorScheme;

    return ListView(padding: const EdgeInsets.only(bottom: 96), children: [
      Card(
        margin: const EdgeInsets.all(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Group spending'),
                Text(formatMoney(g.ledger.total, base), style: Theme.of(context).textTheme.titleLarge),
              ]),
            ),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              const Text('You'),
              Text(
                my == 0 ? 'Settled' : '${my > 0 ? 'are owed' : 'owe'} ${formatMoney(my.abs(), base)}',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(color: moneyColor(context, my)),
              ),
            ]),
          ]),
        ),
      ),
      if (conflicted > 0)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Card(
            color: scheme.tertiaryContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text('$conflicted expense(s) were edited by two people at once. Both versions are kept. Open them to pick the right one.'),
            ),
          ),
        ),
      if (list.isEmpty)
        const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('No expenses yet. Tap "Add expense".'))),
      for (final x in list) _expenseTile(context, x, base),
    ]);
  }

  Widget _expenseTile(BuildContext context, ExpenseView x, String base) {
    final shares = expenseShares(x, base);
    final total = shares.values.fold<int>(0, (a, b) => a + b);
    final net = (x.paidBy == me ? total : 0) - (shares[me] ?? 0);
    final isTransfer = x.kind == 'transfer';
    final to = x.split.entries.keys.firstOrNull ?? '';
    return ListTile(
      leading: SizedBox(width: 44, child: Center(child: Text(shortDate(x.date), textAlign: TextAlign.center))),
      title: Row(children: [
        Flexible(
          child: Text(
            isTransfer ? '${g.nameOf(x.paidBy)} paid ${g.nameOf(to)}' : (x.description.isEmpty ? 'Expense' : x.description),
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (x.conflicts.isNotEmpty) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.warning_amber, size: 18)),
      ]),
      subtitle: Text(isTransfer ? 'Payment' : '${x.paidBy == me ? 'You' : g.nameOf(x.paidBy)} paid ${formatMoney(x.amount, x.currency)}'),
      trailing: isTransfer
          ? null
          : Text(
              net == 0 ? 'not involved' : '${net > 0 ? 'you lent' : 'you owe'}\n${formatMoney(net.abs(), base)}',
              textAlign: TextAlign.right,
              style: TextStyle(color: moneyColor(context, net)),
            ),
      onTap: () => openExpense(context, g, x),
    );
  }
}

class _BalancesTab extends StatelessWidget {
  final GroupController g;
  final String me;
  const _BalancesTab({required this.g, required this.me});

  @override
  Widget build(BuildContext context) {
    final l = g.ledger;
    final base = l.baseCurrency;
    final people = g.allMembers.where((m) => !m.deleted || (l.balances[m.id] ?? 0) != 0).toList();
    final today = DateTime.now().toIso8601String().substring(0, 10);
    return ListView(padding: const EdgeInsets.all(12), children: [
      Text('Suggested payments', style: Theme.of(context).textTheme.titleMedium),
      if (l.transfers.isEmpty)
        const Padding(padding: EdgeInsets.all(16), child: Text('Everyone is settled up. 🎉'))
      else
        Text('The fewest payments that settle everyone (${l.transfers.length}).'),
      for (final t in l.transfers)
        Card(
          child: ListTile(
            title: Text('${t.from == me ? 'You' : g.nameOf(t.from)} → ${t.to == me ? 'you' : g.nameOf(t.to)}'),
            subtitle: Text(formatMoney(t.amount, base), style: Theme.of(context).textTheme.titleMedium),
            trailing: OutlinedButton(
              onPressed: () => g.edit('expense', newId(), {
                'kind': 'transfer',
                'description': 'Payment',
                'amount': t.amount,
                'currency': base,
                'rate': 1,
                'paidBy': t.from,
                'split': Split('exact', {t.to: t.amount}),
                'date': today,
              }),
              child: const Text('Mark paid'),
            ),
          ),
        ),
      const SizedBox(height: 16),
      Text('Balances', style: Theme.of(context).textTheme.titleMedium),
      for (final m in people)
        ListTile(
          leading: Avatar(name: m.name),
          title: Text(m.id == me ? '${m.name} (you)' : m.name),
          trailing: Text(
            (l.balances[m.id] ?? 0) == 0
                ? 'settled'
                : '${(l.balances[m.id] ?? 0) > 0 ? '+' : '−'}${formatMoney((l.balances[m.id] ?? 0).abs(), base)}',
            style: TextStyle(color: moneyColor(context, l.balances[m.id] ?? 0), fontWeight: FontWeight.w600),
          ),
        ),
    ]);
  }
}

class _PeopleTab extends StatelessWidget {
  final GroupController g;
  final String me;
  const _PeopleTab({required this.g, required this.me});

  Future<String?> _ask(BuildContext context, String title, [String initial = '']) {
    final c = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: TextField(controller: c, autofocus: true, maxLength: 60),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('Save')),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(12), children: [
      for (final m in g.members)
        ListTile(
          leading: Avatar(name: m.name),
          title: Text(m.id == me ? '${m.name} (you)' : m.name),
          trailing: PopupMenuButton<String>(
            onSelected: (a) async {
              if (a == 'rename') {
                final n = await _ask(context, 'Rename', m.name);
                if (n != null && n.isNotEmpty) await g.edit('member', m.id, {'name': n});
              } else if (a == 'remove') {
                await g.edit('member', m.id, {'deleted': true});
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'rename', child: Text('Rename')),
              if (m.id != me && (g.ledger.balances[m.id] ?? 0) == 0)
                const PopupMenuItem(value: 'remove', child: Text('Remove')),
            ],
          ),
        ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: () async {
          final n = await _ask(context, 'Add a person');
          if (n != null && n.isNotEmpty) await g.edit('member', newId(), {'name': n});
        },
        icon: const Icon(Icons.person_add),
        label: const Text('Add a person'),
      ),
    ]);
  }
}

class _MoreTab extends StatelessWidget {
  final GroupController g;
  final String me;
  const _MoreTab({required this.g, required this.me});

  @override
  Widget build(BuildContext context) {
    final deleted = g.deletedExpenses;
    return ListView(padding: const EdgeInsets.all(12), children: [
      Card(
        child: ListTile(
          leading: const Icon(Icons.share),
          title: const Text('Invite people'),
          subtitle: const Text('Anyone with the link can view and edit this group.'),
          onTap: () => Share.share(g.link, subject: g.group.name),
          trailing: IconButton(
            icon: const Icon(Icons.copy),
            onPressed: () {
              Clipboard.setData(ClipboardData(text: g.link));
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Link copied')));
            },
          ),
        ),
      ),
      Card(
        child: ListTile(
          leading: const Icon(Icons.table_view),
          title: const Text('Export CSV'),
          subtitle: const Text('Expenses, shares, balances and suggested payments'),
          onTap: () {
            final bytes = utf8.encode('﻿${exportCsv(g.state)}');
            final name = g.group.name.replaceAll(RegExp(r'[^A-Za-z0-9 _-]'), '').trim();
            Share.shareXFiles([
              XFile.fromData(bytes, mimeType: 'text/csv', name: '${name.isEmpty ? 'group' : name}.csv'),
            ], fileNameOverrides: ['${name.isEmpty ? 'group' : name}.csv']);
          },
        ),
      ),
      if (deleted.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('Recently deleted', style: Theme.of(context).textTheme.titleMedium),
        for (final x in deleted.take(20))
          ListTile(
            title: Text(x.description.isEmpty ? 'Payment' : x.description),
            subtitle: Text(formatMoney(x.amount, x.currency)),
            trailing: TextButton(onPressed: () => g.edit('expense', x.id, {'deleted': false}), child: const Text('Restore')),
          ),
      ],
      const SizedBox(height: 8),
      Card(
        child: ListTile(
          leading: const Icon(Icons.person),
          title: Text('You are ${g.nameOf(me)}'),
          subtitle: Text(g.meta?.lastSyncAt == null
              ? 'Not synced yet'
              : 'Last synced ${DateTime.fromMillisecondsSinceEpoch(g.meta!.lastSyncAt!).toLocal()}'),
          trailing: TextButton(onPressed: () => g.setMe(null), child: const Text('Switch')),
        ),
      ),
    ]);
  }
}
