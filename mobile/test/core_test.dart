// Runs the same fixtures as packages/core/test so mobile and web agree on
// every number. Run with: flutter test

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:splitter/core/editor.dart';
import 'package:splitter/core/hlc.dart';
import 'package:splitter/core/ledger.dart';
import 'package:splitter/core/money.dart';
import 'package:splitter/core/ops.dart';
import 'package:splitter/core/settle.dart';
import 'package:splitter/core/splits.dart';

dynamic fixture(String name) => jsonDecode(File('../spec/fixtures/$name').readAsStringSync());

const g = 'group0000000001';

List<Op> seed() {
  final c = Clock(0, 0, 'setupdevice');
  final s = GroupState(g);
  final ops = <Op>[];
  void push(Op? op) {
    if (op != null) {
      ops.add(op);
      applyOp(s, op);
    }
  }

  push(makeOp(s, c, 'group', g, {'name': 'Trip', 'baseCurrency': 'AUD'}));
  push(makeOp(s, c, 'member', 'alice0000001', {'name': 'Alice'}));
  push(makeOp(s, c, 'member', 'bob000000001', {'name': 'Bob'}));
  push(makeOp(s, c, 'member', 'carol0000001', {'name': 'Carol'}));
  push(makeOp(s, c, 'expense', 'dinner000001', {
    'description': 'Dinner', 'amount': 9000, 'currency': 'AUD', 'rate': 1, 'paidBy': 'alice0000001',
    'split': const Split('equal', {'alice0000001': 1, 'bob000000001': 1, 'carol0000001': 1}),
    'date': '2026-11-01', 'kind': 'expense',
  }));
  return ops;
}

void main() {
  group('money fixtures', () {
    final f = fixture('money.json');
    for (final c in f['parse']) {
      test('parse ${c['input']} ${c['currency']}', () => expect(parseAmount(c['input'], c['currency']), c['minor']));
    }
    for (final c in f['convert']) {
      test('convert ${c['amount']} ${c['from']}->${c['to']}', () {
        expect(convertMinor(c['amount'], c['from'], c['to'], (c['rate'] as num).toDouble()), c['result']);
      });
    }
  });

  group('split fixtures', () {
    for (final c in fixture('splits.json')) {
      test(c['name'], () {
        final s = Split.fromJson(c['split'])!;
        expect(computeShares(c['total'], s), Map<String, int>.from(c['shares']));
      });
    }
  });

  group('settle fixtures', () {
    for (final c in fixture('settle.json')) {
      test(c['name'], () {
        final bal = Map<String, int>.from(c['balances']);
        final t = settle(bal);
        expect(t.length, c['count']);
        for (final x in t) {
          bal[x.from] = bal[x.from]! + x.amount;
          bal[x.to] = bal[x.to]! - x.amount;
        }
        expect(bal.values.every((v) => v == 0), isTrue);
      });
    }
  });

  group('offline merge', () {
    test('concurrent edits to the same field are both kept and converge', () {
      final base = seed();
      final sa = buildState(g, base), sb = buildState(g, base);
      final ca = Clock(0, 0, 'deviceAAAA'), cb = Clock(0, 0, 'deviceBBBB');
      for (final op in base) {
        receive(ca, op.hlc);
        receive(cb, op.hlc);
      }
      final a = makeOp(sa, ca, 'expense', 'dinner000001', {'amount': 9900})!;
      final b = makeOp(sb, cb, 'expense', 'dinner000001', {'amount': 9300, 'description': 'Dinner!'})!;
      final all = [...base, a, b];
      final ref = expenseViews(buildState(g, all)).first;
      expect(ref.conflicts.single.field, 'amount');
      expect(ref.description, 'Dinner!');
      final rnd = Random(1);
      for (var i = 0; i < 20; i++) {
        final x = expenseViews(buildState(g, [...all, ...all]..shuffle(rnd))).first;
        expect(x.amount, ref.amount);
        expect(x.conflicts.single.versions.length, 2);
      }
    });

    test('ops round-trip through JSON', () {
      for (final op in seed()) {
        final back = Op.fromJson(jsonDecode(op.encode()) as Map<String, dynamic>);
        expect(back.encode(), op.encode());
      }
    });

    test('ledger and csv', () {
      final s = buildState(g, seed());
      final l = computeLedger(s);
      expect(l.balances, {'alice0000001': 6000, 'bob000000001': -3000, 'carol0000001': -3000});
      expect(exportCsv(s), contains('Dinner,expense,Alice,90.00,AUD,1,90.00,equal,30.00,30.00,30.00'));
    });
  });
}
