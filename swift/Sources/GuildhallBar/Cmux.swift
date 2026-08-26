import AppKit
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
	/// Why the last click did not do what it looked like it would.
	///
	/// A click that silently does nothing is the bug this whole file is about, and it
	/// survived two fixes precisely because every failure went to `/dev/null`. So the
	/// refusal is now a value the panel can render, and it follows the rule the browser
	/// side already follows in `src/cmuxreach.ts`: say what is wrong AND what to do.
	@MainActor final class Status: ObservableObject {
		static let shared = Status()
		@Published var note: String?
		private init() {}
	}

	/// Set the note from any queue. The refusal is discovered on a background queue and
	/// `@Published` must be touched on the main one.
	private static func note(_ text: String?) {
		Task { @MainActor in Status.shared.note = text }
	}

	static func focus(workspace id: String) {
		// `UUID(uuidString:)` accepts exactly the 8-4-4-4-12 hex form and nothing else,
		// which is the whole check — no regex to build and no static to initialise.
		guard UUID(uuidString: id) != nil else { return }
		guard let bin = binary() else {
			note("Can't find the cmux command, so there is no tab to open.")
			return
		}
		// Off the main thread. Selecting takes ~60ms measured here, which is small but
		// is a round trip to another app's socket, and the panel must not stall on it.
		DispatchQueue.global(qos: .userInitiated).async {
			// Nothing to raise if cmux is not running, and `open` would LAUNCH it —
			// a click on a stale row would start a terminal nobody asked for.
			guard let app = appURL(cli: bin), running(app: app) else {
				note("cmux isn't running, so there is no window to bring forward.")
				return
			}
			switch select(bin: bin, workspace: id) {
			case .ok:
				note(nil)
				raise(app: app)
			case .denied:
				// Still raise. Landing in cmux on the wrong tab beats a click that does
				// nothing at all, and the note says why the tab did not change.
				raise(app: app)
				note(
					"cmux was brought to the front, but it only takes control from processes it started "
						+ "and this app is started by launchd, so the tab could not be switched. "
						+ "Set automation.socketControlMode to \"allowAll\" in ~/.config/cmux/cmux.json, "
						+ "then run: cmux reload-config"
				)
			case let .failed(why):
				note(why.isEmpty ? "cmux refused to switch tab." : why)
			}
		}
	}

	private enum Selected {
		case ok
		/// cmux is running and reachable, and will not take orders from this process.
		case denied
		case failed(String)
	}

	/// Switch cmux to that workspace.
	private static func select(bin: String, workspace id: String) -> Selected {
		let task = Process()
		task.executableURL = URL(fileURLWithPath: bin)
		task.arguments = ["select-workspace", "--workspace", id]
		// CAPTURED, not discarded. Both streams went to `/dev/null` here, which is why
		// "Access denied - only processes started inside cmux can connect" — the one
		// sentence that explains the whole bug — was never seen by anybody.
		let out = Pipe(), err = Pipe()
		task.standardOutput = out
		task.standardError = err
		task.environment = childEnv()
		do {
			try task.run()
		} catch {
			return .failed("Could not run cmux: \(error.localizedDescription)")
		}
		// Read before waiting. A pipe holds 64KB and cmux writes far less, but waiting
		// first on a child that filled one is a deadlock, and this is the pattern that
		// does not have to be re-reasoned about later.
		let e = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
		_ = out.fileHandleForReading.readDataToEndOfFile()
		task.waitUntilExit()
		if task.terminationStatus == 0 { return .ok }
		// cmux's own words for this refusal, matched loosely so a reworded message still
		// lands in the branch that explains itself rather than the generic one.
		if e.contains("Access denied") || e.contains("started inside cmux") { return .denied }
		return .failed(e.trimmingCharacters(in: .whitespacesAndNewlines))
	}

	/// The environment for a cmux child, with whatever authorization this app has.
	///
	/// The app is started by launchd, so it can never inherit `CMUX_SOCKET_CAPABILITY`
	/// from a pane the way a process started inside cmux does — measured here as ppid 1
	/// and no capability, against a shell in a cmux pane which has both.
	///
	/// The password is sent because cmux documents it ("Socket Auth: --password takes
	/// precedence, then CMUX_SOCKET_PASSWORD, then the password saved in Settings") and
	/// `src/cmuxreach.ts` reads the same file for the server. But do not assume it is
	/// the way out of `cmuxOnly`: with no password configured in cmux, a launchd child
	/// supplying one was refused with the same "only processes started inside cmux"
	/// error, byte for byte. Whether it works once one IS configured in cmux's own
	/// settings has not been tested here — setting it is the owner's decision.
	///
	/// Passed as an ENVIRONMENT VARIABLE, never as `--password`: argv is readable by
	/// every process on this machine through `ps`.
	private static func childEnv() -> [String: String] {
		// The inherited environment plus additions, not a replacement for it. Replacing
		// it dropped TMPDIR — the per-user Darwin directory macOS CLIs use for their
		// sockets — so cmux could not reach its own app.
		var env = ProcessInfo.processInfo.environment
		env["CMUX_QUIET"] = "1"
		if env["CMUX_SOCKET_CAPABILITY"] == nil, let pass = socketPassword() {
			env["CMUX_SOCKET_PASSWORD"] = pass
		}
		return env
	}

	/// The cmux socket password, if one has been stored. Never logged, never in argv.
	private static func socketPassword() -> String? {
		let dir = ProcessInfo.processInfo.environment["GUILDHALL_CONFIG_DIR"]
			?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/guildhall").path
		guard let raw = try? String(contentsOfFile: dir + "/cmux-password", encoding: .utf8) else { return nil }
		let pass = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		// A file somebody created and never filled in is not a password — the same rule
		// the node side keeps, so the two cannot disagree about what counts as set.
		return pass.isEmpty ? nil : pass
	}

	/// Whether cmux is up, so a click never launches it.
	private static func running(app: URL) -> Bool {
		NSWorkspace.shared.runningApplications.contains { $0.bundleURL == app }
	}

	/// Bring cmux's window in front of whatever the person is looking at.
	///
	/// The second half of a click, and its absence is why clicking a row appeared to do
	/// nothing at all. `select-workspace` changes which tab is current INSIDE cmux and
	/// does not touch window ordering, so from the menu bar — where cmux is by
	/// definition behind something else — the tab silently switched and no window ever
	/// came forward. From the room it looked fine, because that runs inside cmux and
	/// cmux was already frontmost.
	///
	/// Measured on this machine with Chrome deliberately in front:
	///
	///   select-workspace            exit 0, front stayed Google Chrome
	///   focus-window --window …     exit 0 and prints "OK", front stayed Google Chrome
	///   LaunchServices activation   front became cmux
	///
	/// `focus-window` is the trap: it is documented as "bring to front", reports
	/// success, and does nothing visible — macOS does not let a background process
	/// reorder another app's windows. LaunchServices is the route that is allowed to,
	/// and `NSWorkspace` is that same route without spawning `open`.
	private static func raise(app: URL) {
		let cfg = NSWorkspace.OpenConfiguration()
		cfg.activates = true
		NSWorkspace.shared.openApplication(at: app, configuration: cfg)
	}

	/// The cmux application bundle.
	///
	/// Derived from whatever `binary()` resolved, so this cannot name a second path that
	/// drifts from it. Bundle id only as a fallback, for a cmux reached through
	/// /usr/local/bin or a homebrew shim that is not inside a bundle.
	private static func appURL(cli bin: String) -> URL? {
		bundle(containing: bin) ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.cmuxterm.app")
	}

	/// The enclosing `.app`, walking up from a path inside it.
	private static func bundle(containing path: String) -> URL? {
		var url = URL(fileURLWithPath: path)
		while url.pathComponents.count > 1 {
			if url.pathExtension == "app" { return url }
			url = url.deletingLastPathComponent()
		}
		return nil
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
		// The node side has had the right path all along; the two are kept in the same
		// order now.
		//
		// This was written as "that is why clicking a session row did nothing", and it
		// was not. It shipped, the path was genuinely wrong and genuinely fixed, and
		// clicking still did nothing — because selecting a workspace never raised the
		// window either. See `raise(cli:)`, and MISTAKES.md.
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
