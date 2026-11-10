/// Filesystem half of Bundle v1 (spec §4/§5③/§6): the per-app backend
/// directory under `<backendsDir>/<appId>/` —
///
/// ```
/// <appId>/
/// ├── current/    # code dir: the unpacked backend/ slice + bundle.json
/// ├── previous/   # the previous code dir, kept for rollback (§6)
/// ├── data/       # app data — survives upgrade/rollback/remove (§4)
/// └── logs/       # app logs — same contract as data/
/// ```
///
/// Only code dirs (`current/`, `previous/`) are ever deleted; data/logs/DB
/// outlive every lifecycle action so a reinstall picks up where it left off.
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:path/path.dart' as p;

import 'bundle.dart';

/// Fixed locations for one app's backend directory.
class BackendPaths {
  BackendPaths(this.root);

  final String root;

  String get current => p.join(root, 'current');
  String get previous => p.join(root, 'previous');
  String get data => p.join(root, 'data');
  String get logs => p.join(root, 'logs');

  bool get exists => Directory(root).existsSync();
  bool get hasPrevious => Directory(previous).existsSync();
}

/// Unpacked the `backend/` slice of [archive] into
/// `<backendsRoot>/<appId>/current`, moving any existing code dir to
/// `previous/` first (§5③). `data/` and `logs/` are created if missing and
/// never touched. Returns the number of bytes written.
///
/// Throws [BackendFsException] on anything unsafe (path escape, symlink
/// entries) or any I/O failure — the caller keeps the market row and must
/// answer with an error; previous/ still holds the last good version (§6
/// upgrade failure semantics at directory level).
Future<int> installBackendDir({
  required Archive archive,
  required BundleManifest manifest,
  required String backendsRoot,
}) async {
  final BackendPaths paths = BackendPaths(p.join(backendsRoot, manifest.appId));
  await Directory(paths.root).create(recursive: true);
  await Directory(paths.data).create(recursive: true);
  await Directory(paths.logs).create(recursive: true);

  // Rotate: last good code dir becomes previous/ (delete an older previous).
  if (await Directory(paths.previous).exists()) {
    await Directory(paths.previous).delete(recursive: true);
  }
  if (await Directory(paths.current).exists()) {
    await Directory(paths.current).rename(paths.previous);
  }
  final Directory current = Directory(paths.current);
  await current.create(recursive: true);

  int written = 0;
  try {
    for (final ArchiveFile entry in archive.files) {
      // Only the backend slice lands here; main/ + manifest are the frontend
      // side and live in the package store.
      if (entry.name == 'backend/' ) continue;
      if (!entry.name.startsWith('backend/')) continue;

      if (entry.isSymbolicLink) {
        throw BackendFsException('symlink entries are rejected: ${entry.name}');
      }
      final String rel = entry.name.substring('backend/'.length);
      if (rel.isEmpty) continue; // the trailing-slash dir marker
      if (!isSafeZipEntryName(entry.name)) {
        throw BackendFsException('unsafe zip entry path "${entry.name}"');
      }
      final String target = p.join(paths.current, rel);
      if (!p.isWithin(paths.current, target)) {
        throw BackendFsException('entry escapes backend/: ${entry.name}');
      }
      if (entry.isFile) {
        final File file = File(target);
        await file.parent.create(recursive: true);
        await file.writeAsBytes(Uint8List.fromList(entry.content as List<int>),
            flush: true);
        written += entry.size;
      } else {
        await Directory(target).create(recursive: true);
      }
    }
    // The manifest describing this code dir rides along — rollback reads the
    // previous dir's copy to re-register its routes (§6).
    final ArchiveFile? manifestEntry = bundleEntry(archive, 'bundle.json');
    if (manifestEntry != null) {
      final File manifestCopy = File(p.join(paths.current, 'bundle.json'));
      await manifestCopy.writeAsBytes(
          Uint8List.fromList(manifestEntry.content as List<int>),
          flush: true);
    }
  } catch (_) {
    // Leave the half-written current/ in place for diagnosis; previous/ is
    // intact so an operator rollback still works.
    rethrow;
  }
  return written;
}

/// Swaps current/ ↔ previous/ (§6 rollback). Throws when there is nothing to
/// roll back to.
Future<void> rollbackBackendDir(BackendPaths paths) async {
  if (!paths.exists || !paths.hasPrevious) {
    throw BackendFsException('no previous backend to roll back to');
  }
  final String swap = p.join(paths.root, '.swap');
  if (await Directory(swap).exists()) {
    await Directory(swap).delete(recursive: true);
  }
  await Directory(paths.current).rename(swap);
  try {
    await Directory(paths.previous).rename(paths.current);
    await Directory(swap).rename(paths.previous);
  } catch (_) {
    // Put current back so a failed swap never leaves the app dir headless.
    if (!await Directory(paths.current).exists() &&
        await Directory(swap).exists()) {
      await Directory(swap).rename(paths.current);
    }
    rethrow;
  }
}

/// Removes the code dirs only — data/, logs/ and the per-app DB stay (§6,
/// "重装即恢复"). Missing dirs are fine (pure-frontend apps never had any).
Future<void> removeBackendDirs(BackendPaths paths) async {
  for (final String dir in <String>[paths.current, paths.previous]) {
    final Directory d = Directory(dir);
    if (await d.exists()) await d.delete(recursive: true);
  }
}

/// Thrown by the fs layer; message is safe to surface to the CLI.
class BackendFsException implements Exception {
  BackendFsException(this.message);

  final String message;

  @override
  String toString() => message;
}
