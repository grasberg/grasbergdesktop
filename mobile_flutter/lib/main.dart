import 'package:flutter/material.dart';

import 'screens/chat_screen.dart';
import 'screens/home_screen.dart';
import 'screens/pair_screen.dart';
import 'screens/full_app_screen.dart';
import 'state/app_store.dart';
import 'state/tunnel.dart';

/// The app palette — lifted from src/mobile/mobile.css so the native app and
/// the desktop-hosted web client read as the same product.
class Palette {
  static const background = Color(0xFF14171B);
  static const surface = Color(0xFF1D2228);
  static const deep = Color(0xFF0F1216);
  static const text = Color(0xFFE6E8EB);
  static const muted = Color(0xFF8B949E);
  static const accent = Color(0xFF2F6FEB);
  static const online = Color(0xFF3FB950);
  static const waiting = Color(0xFFD29922);
  static const errorColor = Color(0xFFF85149);
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const GrasbergApp());
}

class GrasbergApp extends StatefulWidget {
  const GrasbergApp({super.key});

  @override
  State<GrasbergApp> createState() => _GrasbergAppState();
}

class _GrasbergAppState extends State<GrasbergApp> {
  final AppStore _store = AppStore();

  @override
  void initState() {
    super.initState();
    _store.init();
  }

  @override
  void dispose() {
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Grasberg',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: Palette.background,
        colorScheme: ColorScheme.fromSeed(
          seedColor: Palette.accent,
          brightness: Brightness.dark,
          surface: Palette.surface,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Palette.surface,
          foregroundColor: Palette.text,
          elevation: 0,
        ),
        cardTheme: const CardThemeData(color: Palette.surface),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Palette.deep,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFF30363D)),
          ),
          hintStyle: const TextStyle(color: Palette.muted),
        ),
      ),
      home: RootView(store: _store),
    );
  }
}

/// Routes between the pairing gate and the app surfaces, and floats the
/// store's toast above everything (same behavior as the web client's toast).
class RootView extends StatelessWidget {
  const RootView({super.key, required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: store,
      builder: (context, _) {
        final gated =
            store.tunnelState == TunnelState.unpaired ||
            store.tunnelState == TunnelState.pairing ||
            store.tunnelState == TunnelState.error;
        Widget child;
        if (gated) {
          child = PairScreen(store: store);
        } else if (store.hasFullAccess && !store.showCompact) {
          child = FullAppScreen(
            key: ValueKey(store.identity?.deviceId),
            store: store,
          );
        } else if (store.currentId != null) {
          child = ChatScreen(store: store);
        } else {
          child = HomeScreen(store: store);
        }
        final toast = store.toast;
        return Stack(
          children: [
            child,
            if (toast != null)
              Positioned(
                left: 16,
                right: 16,
                bottom: 24,
                child: ToastCard(
                  message: toast,
                  onDismiss: () => store.setToast(null),
                ),
              ),
          ],
        );
      },
    );
  }
}

class ToastCard extends StatelessWidget {
  const ToastCard({super.key, required this.message, this.onDismiss});

  final String message;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xCC1D2228),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                message,
                style: const TextStyle(color: Palette.text, fontSize: 13),
              ),
            ),
            IconButton(
              onPressed: onDismiss,
              tooltip: 'Dismiss message',
              icon: const Icon(Icons.close),
            ),
          ],
        ),
      ),
    );
  }
}
