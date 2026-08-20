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
		// `Resources/bin/cmux`, which is what `cmux` on PATH resolves to. This list
		// disagreed with src/data/cmux-bin.ts and every entry was wrong in a way that
		// failed silently:
		//
		//   - `Resources/cmux` (first choice) does not exist
		//   - `MacOS/cmux` DOES exist and is the app bundle's GUI executable, confirmed
		//     with `plutil -extract CFBundleExecutable`. So focus() ran the GUI binary
		//     with `select-workspace --workspace <uuid>`, which does not bring a tab to
		//     the front and may launch a second copy of the app
		//   - both streams go to /dev/null, so none of it was reported
		//
		// That is why clicking a session row did nothing. The node side has had the
		// right path all along; the two are kept in the same order now.
		let home = FileManager.default.homeDirectoryForCurrentUser
		let candidates = [
			"/Applications/cmux.app/Contents/Resources/bin/cmux",
			home.appendingPathComponent("Applications/cmux.app/Contents/Resources/bin/cmux").path,
			"/usr/local/bin/cmux",
			"/opt/homebrew/bin/cmux",
			home.appendingPathComponent(".local/bin/cmux").path,
		]
		return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
	}
}
