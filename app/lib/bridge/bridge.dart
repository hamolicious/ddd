library;

import 'dart:async';
import 'dart:convert';

import '../config.dart';

enum BridgeErrorCode {
  unsupported,

  denied,

  cancelled,

  invalid,

  timeout,

  failed;

  String get wire => name;
}

class BridgeException implements Exception {
  BridgeException(this.code, this.message);

  BridgeException.invalid(this.message) : code = BridgeErrorCode.invalid;
  BridgeException.denied(this.message) : code = BridgeErrorCode.denied;
  BridgeException.cancelled([this.message = 'the user cancelled'])
    : code = BridgeErrorCode.cancelled;

  final BridgeErrorCode code;
  final String message;

  @override
  String toString() => 'BridgeException(${code.wire}): $message';
}

class BridgeRequest {
  const BridgeRequest({
    required this.version,
    required this.id,
    required this.capability,
    required this.method,
    required this.params,
  });

  factory BridgeRequest.fromJson(Object? raw) {
    if (raw is! Map) {
      throw BridgeException.invalid('the envelope must be an object');
    }
    final Object? version = raw['v'];
    final Object? id = raw['id'];
    final Object? capability = raw['capability'];
    final Object? method = raw['method'];
    final Object? params = raw['params'];
    if (version is! int ||
        id is! String ||
        capability is! String ||
        method is! String) {
      throw BridgeException.invalid(
        'v, id, capability and method are required',
      );
    }
    final Map<String, Object?> decoded;
    if (params == null) {
      decoded = const <String, Object?>{};
    } else if (params is Map) {
      decoded = Map<String, Object?>.from(params);
    } else {
      throw BridgeException.invalid('params must be an object when present');
    }
    return BridgeRequest(
      version: version,
      id: id,
      capability: capability,
      method: method,
      params: decoded,
    );
  }

  final int version;
  final String id;
  final String capability;
  final String method;
  final Map<String, Object?> params;

  String get key => '$capability.$method';
}

class BridgeResponse {
  const BridgeResponse.ok(this.id, this.result) : code = null, message = null;

  const BridgeResponse.error(
    this.id,
    BridgeErrorCode this.code,
    String this.message,
  ) : result = null;

  final String id;
  final Object? result;
  final BridgeErrorCode? code;
  final String? message;

  bool get isOk => code == null;

  Map<String, Object?> toJson() => <String, Object?>{
    'v': kBridgeVersion,
    'id': id,
    'ok': isOk,
    if (isOk) 'result': result,
    if (!isOk)
      'error': <String, Object?>{'code': code!.wire, 'message': message},
  };
}

typedef BridgeHandler = Future<Object?> Function(Map<String, Object?> params);

class ShellBridge {
  ShellBridge({this.callTimeout = const Duration(seconds: 120), this.log});

  final Duration callTimeout;

  final void Function(String)? log;
  final Map<String, BridgeHandler> _handlers = <String, BridgeHandler>{};

  List<String> get methods => _handlers.keys.toList()..sort();

  List<String> get capabilities =>
      (_handlers.keys
            .map((String key) => key.split('.').first)
            .toSet()
            .toList())
        ..sort();

  void register(String capability, String method, BridgeHandler handler) {
    final String key = '$capability.$method';
    if (_handlers.containsKey(key)) {
      throw StateError('bridge method $key is already registered');
    }
    _handlers[key] = handler;
  }

  Future<Map<String, Object?>> dispatch(Object? raw) async {
    BridgeRequest request;
    try {
      request = BridgeRequest.fromJson(raw);
    } on BridgeException catch (error) {
      return BridgeResponse.error('', error.code, error.message).toJson();
    }

    if (request.version > kBridgeVersion) {
      return BridgeResponse.error(
        request.id,
        BridgeErrorCode.unsupported,
        'this shell speaks bridge v$kBridgeVersion; the page asked for v${request.version}',
      ).toJson();
    }

    final BridgeHandler? handler = _handlers[request.key];
    if (handler == null) {
      return BridgeResponse.error(
        request.id,
        BridgeErrorCode.unsupported,
        'no bridge method ${request.key}',
      ).toJson();
    }

    try {
      final Object? result = await handler(request.params).timeout(callTimeout);
      return BridgeResponse.ok(request.id, result).toJson();
    } on BridgeException catch (error) {
      log?.call(
        'bridge ${request.key} failed: ${error.code.wire} ${error.message}',
      );
      return BridgeResponse.error(
        request.id,
        error.code,
        error.message,
      ).toJson();
    } on TimeoutException {
      log?.call('bridge ${request.key} timed out');
      return BridgeResponse.error(
        request.id,
        BridgeErrorCode.timeout,
        'the shell did not answer within ${callTimeout.inSeconds}s',
      ).toJson();
    } catch (error) {
      log?.call('bridge ${request.key} threw: $error');
      return BridgeResponse.error(
        request.id,
        BridgeErrorCode.failed,
        '$error',
      ).toJson();
    }
  }

  String bootstrapScript({
    required Uri serverBaseUrl,
    required String? bearerToken,
    required String notificationPermission,
  }) {
    final String available = jsonEncode(methods);
    final String caps = jsonEncode(capabilities);
    final String server = jsonEncode(serverBaseUrl.toString());
    final String token = jsonEncode(bearerToken);
    final String permission = jsonEncode(notificationPermission);
    return '''
(function () {
  var V = $kBridgeVersion;
  var HANDLER = ${jsonEncode(kBridgeHandlerName)};
  var METHODS = $available;
  var seq = 0;
  var permission = $permission;
  var token = $token;
  var has = function (m) { return METHODS.indexOf(m) !== -1; };
  var call = function (capability, method, params) {
    return window.flutter_inappwebview
      .callHandler(HANDLER, { v: V, id: String(++seq), capability: capability, method: method, params: params || {} })
      .then(function (envelope) {
        if (!envelope || envelope.ok !== true) {
          var info = (envelope && envelope.error) || {};
          var error = new Error(info.message || 'the shell bridge failed');
          error.name = 'ShellBridgeError';
          error.code = info.code || 'failed';
          throw error;
        }
        return envelope.result;
      });
  };
  var define = function (target, name, method, fn) { if (has(method)) { target[name] = fn; } };

  var auth = {};
  define(auth, 'getToken', 'auth.getToken', function () {
    return call('auth', 'getToken', {}).then(function (t) { token = t || null; return token; });
  });
  define(auth, 'setToken', 'auth.setToken', function (t) {
    token = t || null;
    return call('auth', 'setToken', { token: t });
  });
  define(auth, 'clearToken', 'auth.clearToken', function () {
    token = null;
    return call('auth', 'clearToken', {});
  });

  var filesystem = {};
  define(filesystem, 'export', 'filesystem.export', function (file) {
    return call('filesystem', 'export', file);
  });
  define(filesystem, 'pick', 'filesystem.pick', function (options) {
    return call('filesystem', 'pick', options || {}).then(function (files) {
      return Array.isArray(files) ? files : [];
    });
  });
  define(filesystem, 'exportWorkspace', 'filesystem.exportWorkspace', function () {
    return call('filesystem', 'exportWorkspace', {});
  });
  define(filesystem, 'importFile', 'filesystem.importFile', function (options) {
    return call('filesystem', 'importFile', options || {});
  });

  var folder = {};
  define(folder, 'current', 'folder.current', function () { return call('folder', 'current', {}); });
  define(folder, 'choose', 'folder.choose', function () { return call('folder', 'choose', {}); });
  define(folder, 'forget', 'folder.forget', function () { return call('folder', 'forget', {}); });
  define(folder, 'list', 'folder.list', function () {
    return call('folder', 'list', {}).then(function (entries) {
      return Array.isArray(entries) ? entries : [];
    });
  });
  define(folder, 'read', 'folder.read', function (p) { return call('folder', 'read', p || {}); });
  define(folder, 'write', 'folder.write', function (p) { return call('folder', 'write', p || {}); });
  define(folder, 'move', 'folder.move', function (p) { return call('folder', 'move', p || {}); });
  define(folder, 'remove', 'folder.remove', function (p) { return call('folder', 'remove', p || {}); });

  var notifications = {};
  if (has('notifications.permission')) {
    notifications.permission = function () { return permission; };
  }
  define(notifications, 'request', 'notifications.request', function () {
    return call('notifications', 'request', {}).then(function (state) {
      permission = state || 'denied';
      return permission;
    });
  });
  define(notifications, 'notify', 'notifications.notify', function (n) {
    return call('notifications', 'notify', n);
  });
  define(notifications, 'schedule', 'notifications.schedule', function (n, at) {
    var when = typeof at === 'number' ? new Date(at) : new Date(n && n.atIso);
    return call('notifications', 'schedule', {
      id: (n && (n.id || n.tag)) || null,
      title: n && n.title,
      body: (n && n.body) || null,
      tag: (n && n.tag) || null,
      route: (n && n.route) || null,
      atIso: when.toISOString()
    });
  });
  define(notifications, 'cancel', 'notifications.cancel', function (id) {
    return call('notifications', 'cancel', { id: String(id) });
  });
  define(notifications, 'scheduled', 'notifications.list', function () {
    return call('notifications', 'list', {}).then(function (list) {
      return Array.isArray(list) ? list : [];
    });
  });
  if (notifications.scheduled) { notifications.list = notifications.scheduled; }

  var shell = {
    version: V,
    bridgeVersion: V,
    capabilities: $caps,
    methods: METHODS,
    platform: 'android',
    serverBaseUrl: $server,
    bearerToken: token,
    setBearerToken: function (t) {
      token = t || null;
      return t === null || t === undefined ? call('auth', 'clearToken', {}) : call('auth', 'setToken', { token: t });
    },
    bootOk: function () { return call('boot', 'ok', {}); },
    bootFailed: function (reason) { return call('boot', 'failed', { reason: String(reason || '') }); },
    auth: auth,
    filesystem: filesystem,
    folder: folder,
    notifications: notifications
  };
  Object.defineProperty(window, 'shell', { value: Object.freeze(shell), writable: false, configurable: true });
})();
''';
  }
}
