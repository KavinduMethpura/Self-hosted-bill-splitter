// Port of packages/core/src/hlc.ts (hybrid logical clock).

final _hlcRe = RegExp(r'^(\d{15}):([0-9a-z]{5}):([A-Za-z0-9_-]{1,64})$');

class Clock {
  int wall;
  int counter;
  final String node;
  Clock(this.wall, this.counter, this.node);

  Map<String, Object> toJson() => {'wall': wall, 'counter': counter, 'node': node};
  static Clock fromJson(Map<String, dynamic> j) => Clock(j['wall'] as int, j['counter'] as int, j['node'] as String);
}

String formatHlc(Clock c) =>
    '${c.wall.toString().padLeft(15, '0')}:${c.counter.toRadixString(36).padLeft(5, '0')}:${c.node}';

bool isHlc(Object? s) => s is String && _hlcRe.hasMatch(s);

Clock parseHlc(String s) {
  final m = _hlcRe.firstMatch(s);
  if (m == null) throw FormatException('Invalid HLC: $s');
  return Clock(int.parse(m.group(1)!), int.parse(m.group(2)!, radix: 36), m.group(3)!);
}

String tick(Clock c, [int? now]) {
  now ??= DateTime.now().millisecondsSinceEpoch;
  if (now > c.wall) {
    c.wall = now;
    c.counter = 0;
  } else {
    c.counter += 1;
  }
  return formatHlc(c);
}

void receive(Clock c, String remote, [int? now]) {
  now ??= DateTime.now().millisecondsSinceEpoch;
  final r = parseHlc(remote);
  final wall = [c.wall, r.wall, now].reduce((a, b) => a > b ? a : b);
  if (wall == c.wall && wall == r.wall) {
    c.counter = (c.counter > r.counter ? c.counter : r.counter) + 1;
  } else if (wall == c.wall) {
    c.counter += 1;
  } else if (wall == r.wall) {
    c.counter = r.counter + 1;
  } else {
    c.counter = 0;
  }
  c.wall = wall;
}
