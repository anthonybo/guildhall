import Foundation

/// Bringing a session's terminal to the front.
///
/// The only thing this app asks of cmux, and it is a read-only sort of write: it
/// selects a workspace and types nothing. That distinction matters here — driving
/// cmux by hand has twice typed test text into a live session in this project,
/// both times because a target was empty or ignored and the call fell back to
/// whatever surface was focused.
///
/// So the workspace id is checked before it is used. `select-workspace` accepts
/// `<id|ref|index>`, which means a malformed value is not refused: it is
/// interpreted as something else and acts on the wrong tab. A UUID is the only
/// form this passes.
enum Cmux {
	static func focus(workspace id: String) {
		// `UUID(uuidString:)` accepts exactly the 8-4-4-4-12 hex form and nothing else,
		// which is the whole check — no regex to build and no static to initialise.
		guard UUID(uuidString: id) != nil else { return }
		guard let bin = binary() else { return }
		let task = Process()
		task.executableURL = URL(fileURLWithPath: bin)
		task.arguments = ["select-workspace", "--workspace", id]
		// Quiet, and detached: this is a fire-and-forget request to another app, and
		// nothing here wants its output or its exit code.
		task.standardOutput = FileHandle.nullDevice
		task.standardError = FileHandle.nullDevice
		// The inherited environment plus one variable, not a replacement for it.
		// Replacing it dropped TMPDIR — the per-user Darwin directory macOS CLIs use
		// for their sockets — so a cmux that reaches its app that way would fail with
		// both streams pointed at /dev/null and nothing to show for it.
		var env = ProcessInfo.processInfo.environment
		env["CMUX_QUIET"] = "1"
		task.environment = env
		try? task.run()
	}

	/// Where cmux is.
	///
	/// Searched rather than assumed because launchd gives this app almost no
	/// environment, so PATH is not usable — the same reason the node path is baked
	/// into Info.plist. GUILDHALL_CMUX first, since guildhall itself honours it.
	private static func binary() -> String? {
		if let set = ProcessInfo.processInfo.environment["GUILDHALL_CMUX"],
			FileManager.default.isExecutableFile(atPath: set)
		{
			return set
		}
		let candidates = [
			"/Applications/cmux.app/Contents/Resources/cmux",
			"/Applications/cmux.app/Contents/MacOS/cmux",
			"/usr/local/bin/cmux",
			"/opt/homebrew/bin/cmux",
			FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/cmux").path,
		]
		return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
	}
}
