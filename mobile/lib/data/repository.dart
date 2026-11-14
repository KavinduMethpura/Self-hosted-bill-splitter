// Local-first group controller: same protocol as web/src/store.ts.

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../core/editor.dart';
import '../core/hlc.dart';
import '../core/ledger.dart';
import '../core/ops.dart';
import 'database.dart';

/// Device-wide state: database + hybrid logical clock.
class AppServices {
  final AppDatabase db;
  final Clock clock;
  AppServices._(this.db, this.clock);

  static Future<AppServices> open([AppDatabase? db]) async {
    db ??= AppDatabase();
    final saved = await db.getValue('clock');
    Clock clock;
    if (saved != null) {
      clock = Clock.fromJson(jsonDecode(saved) as Map<String, dynamic>);
    } else {
      final r = Random.secure();
      clock = Clock(0, 0, 'm${List.generate(9, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}');
      await db.setValue('clock', jsonEncode(clock.toJson()));
    }
    return AppServices._(db, clock);
  }

  Future<void> saveClock() => db.setValue('clock', jsonEncode(clock.toJson()));

  String? lastServerUrl;
  Future<String?> getLastServerUrl() async => lastServerUrl ??= await db.getValue('lastServerUrl');
  Future<void> setLastServerUrl(String url) async {
    lastServerUrl = url;
    await db.setValue('lastServerUrl', url);
  }

  final Map<String, GroupController> _controllers = {};
  GroupController controller(String groupId) =>
      _controllers.putIfAbsent(groupId, () => GroupController(this, groupId)..load());

  void dispose(String groupId) => _controllers.remove(groupId)?.close();

  /// Create a new group on this device. Works offline; it is created on the
  /// server on the first successful sync.
  Future<String> createGroup({
    required String serverUrl,
    required String name,
    required String baseCurrency,
    required String myName,
    required List<String> others,
  }) async {
    final groupId = newId();
    final meId = newId();
    final state = GroupState(groupId);
    final ops = <Op>[];
    void add(String entity, String id, Map<String, Object?> changes) {
      final op = makeOp(state, clock, entity, id, changes, by: meId)!;
      applyOp(state, op);
      ops.add(op);
    }

    add('group', groupId, {'name': name, 'baseCurrency': baseCurrency});
    add('member', meId, {'name': myName});
    for (final o in others) {
      add('member', newId(), {'name': o});
    }
    await db.transaction(() async {
      await db.into(db.groups).insert(GroupsCompanion.insert(
            id: groupId,
            serverUrl: serverUrl,
            name: Value(name),
            creating: const Value(true),
            me: Value(meId),
            openedAt: DateTime.now().millisecondsSinceEpoch,
          ));
      for (final op in ops) {
        await db.into(db.ops).insert(OpsCompanion.insert(id: op.id, groupId: groupId, json: op.encode(), pending: const Value(true)));
      }
    });
    await saveClock();
    await setLastServerUrl(serverUrl);
    return groupId;
  }

  /// Register a group from a share link like https://host/g/<id>.
  Future<String?> joinLink(String link) async {
    final uri = Uri.tryParse(link.trim());
    if (uri == null || !uri.hasScheme) return null;
    final seg = uri.pathSegments;
    final i = seg.indexOf('g');
    if (i < 0 || i + 1 >= seg.length || !isId(seg[i + 1])) return null;
    final groupId = seg[i + 1];
    final server = uri.replace(path: seg.sublist(0, i).join('/'), query: null, fragment: null).toString();
    final serverUrl = server.endsWith('/') ? server.substring(0, server.length - 1) : server;
    if (await db.getGroup(groupId) != null) return groupId;
    await db.into(db.groups).insert(GroupsCompanion.insert(
          id: groupId,
          serverUrl: serverUrl,
          openedAt: DateTime.now().millisecondsSinceEpoch,
        ));
    await setLastServerUrl(serverUrl);
    return groupId;
  }
}

enum SyncStatus { synced, syncing, offline, error, notFound }

class GroupController extends ChangeNotifier {
  final AppServices app;
  final String groupId;
  GroupController(this.app, this.groupId);

  AppDatabase get db => app.db;

  GroupState state = GroupState('');
  GroupRow? meta;
  bool loaded = false;
  SyncStatus status = SyncStatus.syncing;
  String? error;
  int pending = 0;

  Timer? _timer;
  StreamSubscription<List<ConnectivityResult>>? _conn;
  Future<void>? _syncing;
  bool _again = false;
  bool _closed = false;

  // cached views
  GroupView? _group;
  List<MemberView>? _members, _allMembers;
  List<ExpenseView>? _expenses, _deleted;
  Ledger? _ledger;

  GroupView get group => _group ??= groupView(state);
  List<MemberView> get members => _members ??= memberViews(state);
  List<MemberView> get allMembers => _allMembers ??= memberViews(state, includeDeleted: true);
  List<ExpenseView> get expenses => _expenses ??= expenseViews(state);
  List<ExpenseView> get deletedExpenses =>
      _deleted ??= expenseViews(state, includeDeleted: true).where((x) => x.deleted).toList();
  Ledger get ledger => _ledger ??= computeLedger(state);
  bool get exists => state.entities['group']!.isNotEmpty;
  String? get me => meta?.me;
  String get link => '${meta?.serverUrl ?? ''}/g/$groupId';

  String nameOf(String id) {
    for (final m in allMembers) {
      if (m.id == id) return m.name;
    }
    return 'Someone';
  }

  void _changed() {
    _group = null;
    _members = _allMembers = _expenses = _deleted = null;
    _ledger = null;
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    state = GroupState(groupId);
    meta = await db.getGroup(groupId);
    for (final row in await db.opsFor(groupId)) {
      final op = Op.fromJson(jsonDecode(row.json) as Map<String, dynamic>);
      applyOp(state, op);
      receive(app.clock, op.hlc);
    }
    pending = await db.pendingCount(groupId);
    await app.saveClock();
    if (meta != null) {
      await (db.update(db.groups)..where((t) => t.id.equals(groupId)))
          .write(GroupsCompanion(openedAt: Value(DateTime.now().millisecondsSinceEpoch)));
    }
    loaded = true;
    _changed();
    _start();
  }

  Future<void> setMe(String? memberId) async {
    await (db.update(db.groups)..where((t) => t.id.equals(groupId))).write(GroupsCompanion(me: Value(memberId)));
    meta = await db.getGroup(groupId);
    _changed();
  }

  /// Record a change locally (works offline) and queue it for sync.
  Future<void> edit(String entity, String entityId, Map<String, Object?> changes, {List<String> force = const []}) async {
    final op = makeOp(state, app.clock, entity, entityId, changes, force: force, by: me);
    await app.saveClock();
    if (op == null) return;
    await db.into(db.ops).insert(OpsCompanion.insert(id: op.id, groupId: groupId, json: op.encode(), pending: const Value(true)));
    applyOp(state, op);
    pending++;
    _changed();
    unawaited(sync());
  }

  // --- sync -----------------------------------------------------------------

  void _start() {
    unawaited(sync());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => sync());
    _conn = Connectivity().onConnectivityChanged.listen((r) {
      if (!r.contains(ConnectivityResult.none)) sync();
    });
  }

  void close() {
    _closed = true;
    _timer?.cancel();
    _conn?.cancel();
  }

  Future<void> sync() {
    if (_syncing != null) {
      _again = true;
      return _syncing!;
    }
    _syncing = _runSync().whenComplete(() {
      _syncing = null;
      if (_again && !_closed) {
        _again = false;
        sync();
      }
    });
    return _syncing!;
  }

  void _setStatus(SyncStatus s, [String? err]) {
    if (status == s && error == err) return;
    status = s;
    error = err;
    _changed();
  }

  Future<void> _runSync() async {
    final m = meta ?? await db.getGroup(groupId);
    if (m == null) return;
    _setStatus(SyncStatus.syncing);
    try {
      for (var round = 0; round < 50; round++) {
        final current = (await db.getGroup(groupId))!;
        final rows = await db.pendingOps(groupId, 500);
        final res = await http
            .post(
              Uri.parse('${current.serverUrl}/api/groups/$groupId/sync'),
              headers: {'Content-Type': 'application/json'},
              body: '{"since":${current.cursor},"create":${current.creating},"ops":[${rows.map((r) => r.json).join(',')}]}',
            )
            .timeout(const Duration(seconds: 20));
        if (res.statusCode == 404) return _setStatus(SyncStatus.notFound, 'This group does not exist on the server.');
        if (res.statusCode != 200) throw Exception('Server error ${res.statusCode}');
        final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
        final remote = (body['ops'] as List).cast<Map<String, dynamic>>();

        var changed = false;
        await db.transaction(() async {
          for (final j in remote) {
            final op = Op.fromJson(j);
            receive(app.clock, op.hlc);
            if (applyOp(state, op)) {
              changed = true;
              await db.into(db.ops).insert(
                    OpsCompanion.insert(id: op.id, groupId: groupId, json: op.encode()),
                    mode: InsertMode.insertOrIgnore,
                  );
            }
          }
          // Pushed ops are acknowledged (or permanently rejected) either way.
          for (final r in rows) {
            await (db.update(db.ops)..where((t) => t.id.equals(r.id))).write(const OpsCompanion(pending: Value(false)));
          }
          await (db.update(db.groups)..where((t) => t.id.equals(groupId))).write(GroupsCompanion(
                cursor: Value((body['cursor'] as num).toInt()),
                creating: const Value(false),
                lastSyncAt: Value(DateTime.now().millisecondsSinceEpoch),
                name: exists ? Value(groupView(state).name) : const Value.absent(),
              ));
        });
        await app.saveClock();
        meta = await db.getGroup(groupId);
        pending = await db.pendingCount(groupId);
        if (changed) _changed();
        if (body['more'] != true && pending == 0) break;
      }
      _setStatus(SyncStatus.synced);
    } on Exception catch (e) {
      final offline = (await Connectivity().checkConnectivity()).contains(ConnectivityResult.none);
      _setStatus(offline ? SyncStatus.offline : SyncStatus.error, e.toString());
    }
  }
}
