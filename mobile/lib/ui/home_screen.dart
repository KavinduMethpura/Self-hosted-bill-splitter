import 'package:flutter/material.dart';

import '../core/money.dart';
import '../data/database.dart';
import '../data/repository.dart';
import 'group_screen.dart';

class HomeScreen extends StatelessWidget {
  final AppServices services;
  const HomeScreen({super.key, required this.services});

  void _open(BuildContext context, String groupId) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => GroupScreen(services: services, groupId: groupId)));
  }

  Future<void> _join(BuildContext context) async {
    final ctrl = TextEditingController();
    final link = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Open a group link'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'https://your-server/g/…'),
          keyboardType: TextInputType.url,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, ctrl.text), child: const Text('Open')),
        ],
      ),
    );
    if (link == null || !context.mounted) return;
    final id = await services.joinLink(link);
    if (!context.mounted) return;
    if (id == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("That doesn't look like a group link")));
    } else {
      _open(context, id);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Splitter'), actions: [
        IconButton(onPressed: () => _join(context), icon: const Icon(Icons.link), tooltip: 'Open a link'),
      ]),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final id = await Navigator.of(context).push<String>(
            MaterialPageRoute(builder: (_) => CreateGroupScreen(services: services)),
          );
          if (id != null && context.mounted) _open(context, id);
        },
        icon: const Icon(Icons.add),
        label: const Text('New group'),
      ),
      body: StreamBuilder<List<GroupRow>>(
        stream: services.db.watchGroups(),
        builder: (context, snap) {
          final groups = snap.data ?? [];
          if (groups.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text('Split group expenses', style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  const Text(
                    'Create a group or open a link someone shared with you. No account needed, and it works offline.',
                    textAlign: TextAlign.center,
                  ),
                ]),
              ),
            );
          }
          return ListView(children: [
            for (final g in groups)
              ListTile(
                leading: const CircleAvatar(child: Icon(Icons.group)),
                title: Text(g.name.isEmpty ? 'Group' : g.name),
                subtitle: Text(Uri.tryParse(g.serverUrl)?.host ?? g.serverUrl),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _open(context, g.id),
              ),
          ]);
        },
      ),
    );
  }
}

class CreateGroupScreen extends StatefulWidget {
  final AppServices services;
  const CreateGroupScreen({super.key, required this.services});

  @override
  State<CreateGroupScreen> createState() => _CreateGroupScreenState();
}

class _CreateGroupScreenState extends State<CreateGroupScreen> {
  final _form = GlobalKey<FormState>();
  final _server = TextEditingController();
  final _name = TextEditingController();
  final _me = TextEditingController();
  final _others = <TextEditingController>[TextEditingController()];
  String _currency = 'AUD';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    widget.services.getLastServerUrl().then((u) {
      if (u != null && _server.text.isEmpty) _server.text = u;
    });
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    var server = _server.text.trim();
    if (server.endsWith('/')) server = server.substring(0, server.length - 1);
    final id = await widget.services.createGroup(
      serverUrl: server,
      name: _name.text.trim(),
      baseCurrency: _currency,
      myName: _me.text.trim(),
      others: _others.map((c) => c.text.trim()).where((s) => s.isNotEmpty).toList(),
    );
    if (mounted) Navigator.of(context).pop(id);
  }

  String? _required(String? v) => (v == null || v.trim().isEmpty) ? 'Required' : null;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New group')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          TextFormField(
            controller: _server,
            decoration: const InputDecoration(labelText: 'Server address', hintText: 'https://split.example.com'),
            keyboardType: TextInputType.url,
            validator: (v) {
              final u = Uri.tryParse(v?.trim() ?? '');
              return (u == null || !(u.scheme == 'http' || u.scheme == 'https') || u.host.isEmpty)
                  ? 'Enter the address of your Splitter server'
                  : null;
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Group name', hintText: 'Tasmania trip'),
            maxLength: 100,
            validator: _required,
          ),
          DropdownButtonFormField<String>(
            value: _currency,
            decoration: const InputDecoration(labelText: 'Main currency'),
            items: [for (final c in commonCurrencies) DropdownMenuItem(value: c, child: Text(c))],
            onChanged: (v) => setState(() => _currency = v ?? _currency),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _me,
            decoration: const InputDecoration(labelText: 'Your name'),
            maxLength: 60,
            validator: _required,
          ),
          Text('Other people', style: Theme.of(context).textTheme.titleSmall),
          for (var i = 0; i < _others.length; i++)
            TextField(
              controller: _others[i],
              decoration: InputDecoration(hintText: 'Person ${i + 2}'),
              maxLength: 60,
              onChanged: (v) {
                if (i == _others.length - 1 && v.isNotEmpty) setState(() => _others.add(TextEditingController()));
              },
            ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _busy ? null : _submit, child: const Text('Create group')),
        ]),
      ),
    );
  }
}
