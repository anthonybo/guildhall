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
	private static let uuid = try! NSRegularExpression(
		pattern: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")

	static func focus(workspace id: String) {
		let range = NSRange(id.startIndex..<id.endIndex, in: id)
		guard uuid.firstMatch(in: id, range: range) != nil else { return }
		guard let bin = binary() else { return }
		let task = Process()
		task.executableURL = URL(fileURLWithPath: bin)
		task.arguments = ["select-workspace", "--workspace", id]
		// Quiet, and detached: this is a fire-and-forget request to another app, and
		// nothing here wants its output or its exit code.
		task.standardOutput = FileHandle.nullDevice
		task.standardError = FileHandle.nullDevice
		task.environment = ["CMUX_QUIET": "1", "HOME": FileManager.default.homeDirectoryForCurrentUser.path]
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
