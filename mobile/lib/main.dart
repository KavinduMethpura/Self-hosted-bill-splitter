import 'package:flutter/material.dart';

import 'data/repository.dart';
import 'ui/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final services = await AppServices.open();
  runApp(SplitterApp(services: services));
}

class SplitterApp extends StatelessWidget {
  final AppServices services;
  const SplitterApp({super.key, required this.services});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFF0F766E);
    return MaterialApp(
      title: 'Splitter',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: seed, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: seed, brightness: Brightness.dark, useMaterial3: true),
      home: HomeScreen(services: services),
    );
  }
}
