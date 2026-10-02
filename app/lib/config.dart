library;

const int kBridgeVersion = 1;

const String kBridgeHandlerName = 'ddd_shell_v1';

const int kLoopbackPort = 41847;

Uri get kLoopbackOrigin => Uri.parse('http://127.0.0.1:$kLoopbackPort');

const Duration kBootWatchdog = Duration(seconds: 25);

const int kMaxFailedBoots = 2;

const Duration kUpdateCheckInterval = Duration(minutes: 15);

class ShellConfig {
  const ShellConfig({
    required this.serverBaseUrl,
    this.loopbackPort = kLoopbackPort,
  });

  final Uri serverBaseUrl;

  final int loopbackPort;

  Uri api(String path) => serverBaseUrl.resolve('/api$path');

  Uri get loopbackOrigin => Uri.parse('http://127.0.0.1:$loopbackPort');
}
