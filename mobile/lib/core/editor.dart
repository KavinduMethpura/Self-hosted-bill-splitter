// Port of packages/core/src/editor.ts.

import 'hlc.dart';
import 'ops.dart';
import 'splits.dart';

/// Deep equality where 1 == 1.0 (JSON numbers may decode as int or double).
bool sameValue(Object? a, Object? b) {
  if (a is Split) a = a.toJson();
  if (b is Split) b = b.toJson();
  if (a is num && b is num) return a == b;
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if (!b.containsKey(k) || !sameValue(a[k], b[k])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

Op? makeOp(
  GroupState state,
  Clock clock,
  String entity,
  String entityId,
  Map<String, Object?> changes, {
  List<String> force = const [],
  String? by,
}) {
  final ent = state.entities[entity]![entityId];
  final set = <String, FieldWrite>{};
  for (final e in changes.entries) {
    if (e.value == null) continue;
    final v = e.value is Split ? (e.value as Split).toJson() : e.value;
    final heads = ent?.fields[e.key]?.heads ?? const <Version>[];
    if (heads.length == 1 && sameValue(heads.first.v, v) && !force.contains(e.key)) continue;
    set[e.key] = FieldWrite(v, headsOf(state, entity, entityId, e.key));
  }
  if (set.isEmpty) return null;
  return Op(
    id: newId(),
    groupId: state.groupId,
    entity: entity,
    entityId: entityId,
    hlc: tick(clock),
    actor: clock.node,
    by: by,
    set: set,
  );
}
