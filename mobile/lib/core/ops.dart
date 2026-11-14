// Port of packages/core/src/ops.ts: the op log and its order-independent
// reducer (per-field multi-value registers). See that file for the design.

import 'dart:convert';
import 'dart:math';

import 'hlc.dart';
import 'splits.dart';

const entityTypes = ['group', 'member', 'expense'];

class FieldWrite {
  final Object? v;
  final List<String> b;
  const FieldWrite(this.v, this.b);
}

class Op {
  final String id;
  final String groupId;
  final String entity;
  final String entityId;
  final String hlc;
  final String actor;
  final String? by;
  final Map<String, FieldWrite> set;

  const Op({
    required this.id,
    required this.groupId,
    required this.entity,
    required this.entityId,
    required this.hlc,
    required this.actor,
    this.by,
    required this.set,
  });

  Map<String, Object?> toJson() => {
        'id': id,
        'groupId': groupId,
        'entity': entity,
        'entityId': entityId,
        'hlc': hlc,
        'actor': actor,
        if (by != null) 'by': by,
        'set': {for (final e in set.entries) e.key: {'v': e.value.v, 'b': e.value.b}},
      };

  static Op fromJson(Map<String, dynamic> j) {
    final set = <String, FieldWrite>{};
    for (final e in (j['set'] as Map<String, dynamic>).entries) {
      final w = e.value as Map<String, dynamic>;
      set[e.key] = FieldWrite(w['v'], (w['b'] as List).cast<String>());
    }
    return Op(
      id: j['id'] as String,
      groupId: j['groupId'] as String,
      entity: j['entity'] as String,
      entityId: j['entityId'] as String,
      hlc: j['hlc'] as String,
      actor: j['actor'] as String,
      by: j['by'] as String?,
      set: set,
    );
  }

  String encode() => jsonEncode(toJson());
}

bool isId(Object? v) => v is String && RegExp(r'^[A-Za-z0-9_-]{8,64}$').hasMatch(v);

const _alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
final _rng = Random.secure();
String newId() => String.fromCharCodes(List.generate(22, (_) => _alphabet.codeUnitAt(_rng.nextInt(62))));

// ---------------------------------------------------------------------------

class Version {
  final Object? v;
  final String hlc;
  final String actor;
  final String? by;
  const Version(this.v, this.hlc, this.actor, this.by);
}

class Register {
  List<Version> heads = [];
  final Set<String> superseded = {};
}

class EntityState {
  final String id;
  String createdHlc;
  String updatedHlc;
  final Map<String, Register> fields = {};
  EntityState(this.id, this.createdHlc, this.updatedHlc);
}

class GroupState {
  final String groupId;
  final Set<String> opIds = {};
  final Map<String, Map<String, EntityState>> entities = {
    for (final t in entityTypes) t: <String, EntityState>{},
  };
  GroupState(this.groupId);
}

bool applyOp(GroupState state, Op op) {
  if (state.opIds.contains(op.id)) return false;
  final table = state.entities[op.entity];
  if (table == null) return false;
  state.opIds.add(op.id);
  final ent = table.putIfAbsent(op.entityId, () => EntityState(op.entityId, op.hlc, op.hlc));
  if (op.hlc.compareTo(ent.createdHlc) < 0) ent.createdHlc = op.hlc;
  if (op.hlc.compareTo(ent.updatedHlc) > 0) ent.updatedHlc = op.hlc;

  for (final e in op.set.entries) {
    final reg = ent.fields.putIfAbsent(e.key, Register.new);
    reg.superseded.addAll(e.value.b);
    reg.heads = reg.heads.where((h) => !reg.superseded.contains(h.hlc)).toList();
    if (!reg.superseded.contains(op.hlc)) {
      reg.heads.add(Version(e.value.v, op.hlc, op.actor, op.by));
      reg.heads.sort((a, b) => b.hlc.compareTo(a.hlc));
    }
  }
  return true;
}

GroupState buildState(String groupId, Iterable<Op> ops) {
  final s = GroupState(groupId);
  for (final op in ops) {
    applyOp(s, op);
  }
  return s;
}

List<String> headsOf(GroupState s, String entity, String id, String field) =>
    s.entities[entity]?[id]?.fields[field]?.heads.map((h) => h.hlc).toList() ?? [];

// ---------------------------------------------------------------------------
// Views

class Conflict {
  final String field;
  final List<Version> versions;
  const Conflict(this.field, this.versions);
}

class GroupView {
  final String id, name, baseCurrency;
  const GroupView(this.id, this.name, this.baseCurrency);
}

class MemberView {
  final String id, name, createdHlc;
  final bool deleted;
  const MemberView(this.id, this.name, this.deleted, this.createdHlc);
}

class ExpenseView {
  final String id;
  final String description;
  final int amount;
  final String currency;
  final double rate;
  final String paidBy;
  final Split split;
  final String date;
  final String kind;
  bool deleted;
  final String createdHlc, updatedHlc;
  List<Conflict> conflicts;

  ExpenseView({
    required this.id,
    required this.description,
    required this.amount,
    required this.currency,
    required this.rate,
    required this.paidBy,
    required this.split,
    required this.date,
    required this.kind,
    required this.deleted,
    required this.createdHlc,
    required this.updatedHlc,
    required this.conflicts,
  });
}

Object? _val(EntityState? e, String field) {
  final h = e?.fields[field]?.heads;
  return (h == null || h.isEmpty) ? null : h.first.v;
}

T _v<T>(EntityState? e, String field, T fallback) {
  final v = _val(e, field);
  return v is T ? v : fallback;
}

List<Conflict> _conflictsOf(EntityState e) {
  final out = [
    for (final f in e.fields.entries)
      if (f.value.heads.length > 1) Conflict(f.key, f.value.heads),
  ];
  out.sort((a, b) => a.field.compareTo(b.field));
  return out;
}

GroupView groupView(GroupState s) {
  final g = s.entities['group']![s.groupId];
  return GroupView(s.groupId, _v(g, 'name', 'Untitled group'), _v(g, 'baseCurrency', 'USD'));
}

List<MemberView> memberViews(GroupState s, {bool includeDeleted = false}) {
  final out = <MemberView>[];
  for (final e in s.entities['member']!.values) {
    final m = MemberView(e.id, _v(e, 'name', '?'), _v(e, 'deleted', false), e.createdHlc);
    if (includeDeleted || !m.deleted) out.add(m);
  }
  out.sort((a, b) => a.createdHlc.compareTo(b.createdHlc));
  return out;
}

List<ExpenseView> expenseViews(GroupState s, {bool includeDeleted = false}) {
  final base = groupView(s).baseCurrency;
  final out = <ExpenseView>[];
  for (final e in s.entities['expense']!.values) {
    final x = ExpenseView(
      id: e.id,
      description: _v(e, 'description', ''),
      amount: _v<num>(e, 'amount', 0).toInt(),
      currency: _v(e, 'currency', base),
      rate: _v<num>(e, 'rate', 1).toDouble(),
      paidBy: _v(e, 'paidBy', ''),
      split: Split.fromJson(_val(e, 'split')) ?? const Split('equal', {}),
      date: _v(e, 'date', ''),
      kind: _v(e, 'kind', 'expense'),
      deleted: _v(e, 'deleted', false),
      createdHlc: e.createdHlc,
      updatedHlc: e.updatedHlc,
      conflicts: _conflictsOf(e),
    );
    final del = e.fields['deleted']?.heads.firstOrNull;
    if (x.deleted && del != null) {
      Version? newest;
      for (final f in e.fields.entries) {
        if (f.key == 'deleted') continue;
        for (final h in f.value.heads) {
          if (h.hlc.compareTo(del.hlc) > 0 && (newest == null || h.hlc.compareTo(newest.hlc) > 0)) newest = h;
        }
      }
      if (newest != null) {
        x.deleted = false;
        x.conflicts = [
          Conflict('deleted', [Version(false, newest.hlc, newest.actor, newest.by), del]),
          ...x.conflicts.where((c) => c.field != 'deleted'),
        ];
      }
    }
    if (includeDeleted || !x.deleted) out.add(x);
  }
  out.sort((a, b) {
    if (a.date != b.date) return b.date.compareTo(a.date);
    return b.createdHlc.compareTo(a.createdHlc);
  });
  return out;
}

/// Validation mirror of the server rules, used before writing locally.
bool isValidHlcBase(List<String> b, String hlc) => b.every((h) => isHlc(h) && h.compareTo(hlc) < 0);
