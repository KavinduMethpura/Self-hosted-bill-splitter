// Port of packages/core/src/splits.ts.

const splitModes = ['equal', 'exact', 'percent', 'shares'];

class Split {
  final String mode;
  final Map<String, num> entries;
  const Split(this.mode, this.entries);

  static Split? fromJson(Object? j) {
    if (j is! Map) return null;
    final mode = j['mode'];
    final e = j['entries'];
    if (mode is! String || !splitModes.contains(mode) || e is! Map) return null;
    final entries = <String, num>{};
    for (final kv in e.entries) {
      final v = kv.value;
      if (kv.key is! String || v is! num || !v.isFinite || v < 0) return null;
      entries[kv.key as String] = v;
    }
    return Split(mode, entries);
  }

  Map<String, Object?> toJson() => {
        'mode': mode,
        'entries': {for (final e in entries.entries) e.key: _tidy(e.value)},
      };
}

/// 2.0 -> 2 so the JSON looks the same as what the web client produces.
num _tidy(num v) => v is double && v == v.truncateToDouble() && v.abs() < 1e15 ? v.toInt() : v;

String? validateSplit(Split split, int amountMinor) {
  final vals = split.entries.values.where((v) => v > 0).toList();
  if (vals.isEmpty) return 'Pick at least one person to split with';
  if (split.mode == 'exact') {
    if (!vals.every((v) => v == v.truncate())) return 'Exact amounts must be whole minor units';
    final sum = vals.fold<num>(0, (a, b) => a + b);
    if (sum != amountMinor) return 'Exact amounts add up to $sum, not $amountMinor';
  }
  if (split.mode == 'percent') {
    double sum = 0;
    for (final k in (split.entries.keys.toList()..sort())) {
      sum += split.entries[k]!.toDouble();
    }
    if ((sum - 100).abs() > 0.0001) return 'Percentages add up to ${(sum * 10000).round() / 10000}%, not 100%';
  }
  return null;
}

List<MapEntry<String, double>> splitWeights(Split split) {
  final ids = split.entries.keys.toList()..sort();
  final out = <MapEntry<String, double>>[];
  for (final id in ids) {
    final v = split.entries[id]!;
    if (!(v > 0)) continue;
    out.add(MapEntry(id, split.mode == 'equal' ? 1.0 : v.toDouble()));
  }
  return out;
}

class _Row {
  final String id;
  int floor;
  final double frac;
  _Row(this.id, this.floor, this.frac);
}

Map<String, int> allocate(int total, List<MapEntry<String, double>> weights) {
  final result = <String, int>{};
  if (weights.isEmpty) return result;
  double w = 0;
  for (final e in weights) {
    w += e.value;
  }
  if (!(w > 0)) return result;

  final sign = total < 0 ? -1 : 1;
  final abs = total.abs();
  final rows = weights.map((e) {
    final quota = (abs * e.value) / w;
    final floor = quota.floor();
    return _Row(e.key, floor, quota - floor);
  }).toList();
  var remaining = abs - rows.fold<int>(0, (a, r) => a + r.floor);
  final order = [...rows]..sort((a, b) {
      final c = b.frac.compareTo(a.frac);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  for (var i = 0; remaining > 0; i = (i + 1) % order.length) {
    order[i].floor += 1;
    remaining -= 1;
  }
  for (final r in rows) {
    result[r.id] = sign * r.floor;
  }
  return result;
}

Map<String, int> computeShares(int totalMinor, Split split) => allocate(totalMinor, splitWeights(split));
