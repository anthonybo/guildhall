import Foundation

/// Start, stop and restart the headless service.
///
/// This is the thing the comparable menu bar apps cannot do. They watch Claude
/// Code and have nothing to control, so their menus are read-only; guildhall has
/// a service, so the same menu that reports the state can also change it.
///
/// Everything goes through `launchctl` rather than spawning a node process
/// directly. launchd already owns the service — it starts it at login and
/// restarts it when it dies — and a second copy started behind its back would
/// fight it for the port and lose, or win and confuse it.
enum Daemon {
	static let label = "dev.guildhall.headless"

	/// The user's own launchd domain: `gui/<uid>`. LaunchAgents live here, and
	/// omitting the domain makes the modern subcommands fail with a usage error
	/// rather than guessing.
	private static var domain: String { "gui/\(getuid())" }

	private static var plist: String {
		FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library/LaunchAgents/\(label).plist").path
	}

	enum State: Equatable {
		/// loaded, and something is listening
		case running
		/// loaded but not answering: usually the port is held by something else
		case loadedNotServing
		/// the plist is installed but not loaded
		case stopped
		/// no plist at all — the service has never been set up on this machine
		case notInstalled
	}

	static var installed: Bool { FileManager.default.fileExists(atPath: plist) }

	/// Whether launchd currently holds the job. `print` rather than `list` because
	/// `list` exits 0 for an unknown label on some releases, which reads as loaded.
	static func loaded() -> Bool {
		run("/bin/launchctl", ["print", "\(domain)/\(label)"]).status == 0
	}

	static func start() { _ = run("/bin/launchctl", ["bootstrap", domain, plist]) }
	static func stop() { _ = run("/bin/launchctl", ["bootout", "\(domain)/\(label)"]) }

	/// Restart in place. `kickstart -k` kills and relaunches in one step, which is
	/// what "restart" has to mean here — bootout then bootstrap races, because the
	/// old process has not released the port by the time the new one binds.
	static func restart() { _ = run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(label)"]) }

	@discardableResult
	private static func run(_ path: String, _ args: [String]) -> (status: Int32, out: String) {
		let task = Process()
		task.executableURL = URL(fileURLWithPath: path)
		task.arguments = args
		let pipe = Pipe()
		task.standardOutput = pipe
		task.standardError = pipe
		do { try task.run() } catch { return (-1, "\(error)") }
		let data = pipe.fileHandleForReading.readDataToEndOfFile()
		task.waitUntilExit()
		return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
	}
}
