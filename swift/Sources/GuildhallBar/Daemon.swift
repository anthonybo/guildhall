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
///
/// **Every call here is async, and none of it waits on a run loop.** Two measured
/// reasons:
///
/// `waitUntilExit()` costs about **64ms of sleeping**, whatever the child does —
/// it is Foundation's run-loop polling interval on Darwin, not launchctl. Raw
/// `launchctl print` from a shell is 8.7ms, which is where an earlier comment's
/// "9-10ms" came from: that number measured the child and missed 87% of the call.
/// Using the termination handler instead gets the same exit status for the child's
/// real cost.
///
/// And these ran on the main actor. `act()` invoked its closure inline from a
/// `@MainActor` type, so pressing Start, Stop or Restart froze the UI for 64ms
/// plus whatever launchd actually did — which is precisely the "the button did
/// nothing" report.
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

	/// A file check, 0.18ms. Cheap enough for the main thread, unlike everything else.
	static var installed: Bool { FileManager.default.fileExists(atPath: plist) }

	/// Whether launchd currently holds the job.
	///
	/// `print` rather than `list` because `list` exits 0 for an unknown label on
	/// some releases, which reads as loaded.
	///
	/// Only worth asking when the HTTP fetch has FAILED. A successful fetch already
	/// proves the service is up, and asking anyway spawned a process every poll —
	/// about 30 a minute with the panel open — whose answer was then overwritten.
	static func loaded() async -> Bool {
		await run("/bin/launchctl", ["print", "\(domain)/\(label)"]).status == 0
	}

	static func state() async -> State {
		guard installed else { return .notInstalled }
		return await loaded() ? .loadedNotServing : .stopped
	}

	@discardableResult static func start() async -> String? { await act(["bootstrap", domain, plist]) }
	@discardableResult static func stop() async -> String? { await act(["bootout", "\(domain)/\(label)"]) }

	/// Restart in place. `kickstart -k` kills and relaunches in one step, which is
	/// what "restart" has to mean here — bootout then bootstrap races, because the
	/// old process has not released the port by the time the new one binds.
	@discardableResult static func restart() async -> String? { await act(["kickstart", "-k", "\(domain)/\(label)"]) }

	/// Run a mutating subcommand, and return what launchctl said if it failed.
	///
	/// The output was being thrown away — `bootstrap` failing with
	/// `Bootstrap failed: 5: Input/output error` is the most common launchd outcome
	/// there is, and the panel showed nothing at all.
	private static func act(_ args: [String]) async -> String? {
		let r = await run("/bin/launchctl", args)
		guard r.status != 0 else { return nil }
		let said = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
		return said.isEmpty ? "launchctl exited \(r.status)" : said
	}

	/// Spawn, collect output, and resume when the child actually exits.
	///
	/// `terminationHandler` rather than `waitUntilExit()`, which sleeps ~64ms on a
	/// run loop no matter how fast the child is.
	///
	/// Not private any more: Client reads the room through `guildhall --sessions` and
	/// needs exactly this, including the concurrent drain below. A second copy would
	/// be a second chance to reintroduce the deadlock described there.
	static func run(_ path: String, _ args: [String]) async -> (status: Int32, out: String) {
		let task = Process()
		task.executableURL = URL(fileURLWithPath: path)
		task.arguments = args
		let pipe = Pipe()
		task.standardOutput = pipe
		task.standardError = pipe

		// The pipe is drained WHILE the child runs, on its own task.
		//
		// The previous version read it inside `terminationHandler`, with a comment
		// claiming that avoided a deadlock — it caused one. Nothing read while the
		// child was alive, so a child that filled the 64KB pipe buffer would block on
		// write, never exit, never fire the handler, and leave the continuation
		// unresumed forever: a permanently frozen call rather than a slow one. It does
		// not bite today only because `launchctl print` emits about 2KB.
		let draining = Task.detached { pipe.fileHandleForReading.readDataToEndOfFile() }

		let status: Int32 = await withCheckedContinuation { continuation in
			task.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
			do { try task.run() } catch { continuation.resume(returning: -1) }
		}
		let data = await draining.value
		return (status, String(data: data, encoding: .utf8) ?? "")
	}
}
