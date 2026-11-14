// Drift (SQLite) schema. Run `dart run build_runner build` to generate
// database.g.dart.
//
// Ops are stored as their JSON exactly as they go over the wire. `pending`
// marks ops created on this device that the server hasn't acknowledged yet.
// An op and its pending flag are written in one transaction, so an edit made
// offline survives app restarts until it has been pushed.

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'database.g.dart';

@DataClassName('OpRow')
class Ops extends Table {
  TextColumn get id => text()();
  TextColumn get groupId => text()();
  TextColumn get json => text()();
  BoolColumn get pending => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('GroupRow')
class Groups extends Table {
  TextColumn get id => text()();
  TextColumn get serverUrl => text()();
  TextColumn get name => text().withDefault(const Constant(''))();
  IntColumn get cursor => integer().withDefault(const Constant(0))();
  BoolColumn get creating => boolean().withDefault(const Constant(false))();
  TextColumn get me => text().nullable()();
  IntColumn get lastSyncAt => integer().nullable()();
  IntColumn get openedAt => integer()();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('KeyValueRow')
class KeyValues extends Table {
  TextColumn get key => text()();
  TextColumn get value => text()();

  @override
  Set<Column> get primaryKey => {key};
}

@DriftDatabase(tables: [Ops, Groups, KeyValues])
class AppDatabase extends _$AppDatabase {
  AppDatabase([QueryExecutor? executor]) : super(executor ?? driftDatabase(name: 'splitter'));

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) async {
          await m.createAll();
          await customStatement('CREATE INDEX IF NOT EXISTS ops_group ON ops (group_id)');
        },
      );

  Future<String?> getValue(String key) async =>
      (await (select(keyValues)..where((t) => t.key.equals(key))).getSingleOrNull())?.value;

  Future<void> setValue(String key, String value) =>
      into(keyValues).insertOnConflictUpdate(KeyValuesCompanion.insert(key: key, value: value));

  Stream<List<GroupRow>> watchGroups() =>
      (select(groups)..orderBy([(t) => OrderingTerm.desc(t.openedAt)])).watch();

  Future<GroupRow?> getGroup(String id) => (select(groups)..where((t) => t.id.equals(id))).getSingleOrNull();

  Future<List<OpRow>> opsFor(String groupId) => (select(ops)..where((t) => t.groupId.equals(groupId))).get();

  Future<List<OpRow>> pendingOps(String groupId, int limit) => (select(ops)
        ..where((t) => t.groupId.equals(groupId) & t.pending.equals(true))
        ..limit(limit))
      .get();

  Future<int> pendingCount(String groupId) async {
    final c = ops.id.count();
    final q = selectOnly(ops)
      ..addColumns([c])
      ..where(ops.groupId.equals(groupId) & ops.pending.equals(true));
    return (await q.getSingle()).read(c) ?? 0;
  }

  Future<void> forgetGroup(String groupId) => transaction(() async {
        await (delete(ops)..where((t) => t.groupId.equals(groupId))).go();
        await (delete(groups)..where((t) => t.id.equals(groupId))).go();
      });
}
