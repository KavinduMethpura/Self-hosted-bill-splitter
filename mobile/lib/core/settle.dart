// Port of packages/core/src/settle.ts: fewest payments to settle a group.

class Transfer {
  final String from;
  final String to;
  final int amount;
  const Transfer(this.from, this.to, this.amount);
}

const exactLimit = 18;

List<Transfer> settle(Map<String, int> balances) {
  final people = balances.keys.where((id) => balances[id] != 0).toList()..sort();
  if (people.isEmpty) return [];
  final total = people.fold<int>(0, (s, id) => s + balances[id]!);
  if (total != 0) throw StateError('Balances do not sum to zero ($total)');
  final groups = people.length <= exactLimit ? _zeroSumPartition(people, balances) : [people];
  return [for (final g in groups) ..._greedy(g, balances)];
}

List<List<String>> _zeroSumPartition(List<String> people, Map<String, int> balances) {
  final n = people.length;
  final full = (1 << n) - 1;
  final sum = List<int>.filled(1 << n, 0);
  final dp = List<int>.filled(1 << n, 0);
  final pick = List<int>.filled(1 << n, 0);
  for (var mask = 1; mask <= full; mask++) {
    final low = (mask & -mask).bitLength - 1;
    sum[mask] = sum[mask & (mask - 1)] + balances[people[low]]!;
    var best = -1;
    var bestI = 0;
    for (var i = 0; i < n; i++) {
      if (mask & (1 << i) == 0) continue;
      final v = dp[mask ^ (1 << i)];
      if (v > best) {
        best = v;
        bestI = i;
      }
    }
    dp[mask] = best + (sum[mask] == 0 ? 1 : 0);
    pick[mask] = bestI;
  }
  final order = <int>[];
  for (var mask = full; mask != 0; mask ^= 1 << pick[mask]) {
    order.add(pick[mask]);
  }
  final groups = <List<String>>[];
  var cur = <String>[];
  var run = 0;
  for (final i in order.reversed) {
    cur.add(people[i]);
    run += balances[people[i]]!;
    if (run == 0) {
      groups.add(cur);
      cur = [];
    }
  }
  if (cur.isNotEmpty) groups.add(cur);
  return groups;
}

class _Bal {
  final String id;
  int v;
  _Bal(this.id, this.v);
}

List<Transfer> _greedy(List<String> group, Map<String, int> balances) {
  final bal = [for (final id in group) _Bal(id, balances[id]!)];
  final out = <Transfer>[];
  while (true) {
    final debtors = bal.where((b) => b.v < 0).toList()
      ..sort((a, b) => a.v != b.v ? a.v.compareTo(b.v) : a.id.compareTo(b.id));
    final creditors = bal.where((b) => b.v > 0).toList()
      ..sort((a, b) => a.v != b.v ? b.v.compareTo(a.v) : a.id.compareTo(b.id));
    if (debtors.isEmpty || creditors.isEmpty) break;
    final d = debtors.first, c = creditors.first;
    final amount = -d.v < c.v ? -d.v : c.v;
    out.add(Transfer(d.id, c.id, amount));
    d.v += amount;
    c.v -= amount;
  }
  return out;
}
