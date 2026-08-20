import Foundation

/// Reading and writing guildhall's own settings file.
///
/// The app edits `~/.config/guildhall/config.json` directly rather than asking
/// the server to do it. Two reasons, and the second is the important one:
///
/// It runs as the same user on the same machine, which is the trust boundary the
/// whole design already uses — the control password is set from this machine and
/// never accepted over the network for exactly this reason.
///
/// And a settings endpoint would be a write surface reachable by anything that
/// got past the passcode. The passcode guards reading session summaries; it
/// should not also be the only thing between a visitor and this machine's port,
/// its passcode and whether control is armed.
///
/// Changing the port or the passcode needs the service restarted to take effect,
/// which the caller does — the app already owns that button.
struct Config {
	// These mirror src/config.ts, which owns them. They disagreed: node defaulted
	// `serve` to false and this to TRUE, so with no config file the two halves of the
	// same program held opposite beliefs about whether the machine was serving. And
	// `host` defaulted to every interface here too.
	//
	// They are only reached when config.json is missing or unreadable; the file is the
	// source of truth whenever it exists.
	var serve = false
	var port = 4318
	var host = "127.0.0.1"
	var labels = "vertical"
	var awakeDisplay = true
	var control = false

	static var dir: String {
		ProcessInfo.processInfo.environment["GUILDHALL_CONFIG_DIR"]
			?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/guildhall").path
	}
	private static var file: String { dir + "/config.json" }
	private static var passcodeFile: String { dir + "/passcode" }
	/// Only ever read, never written. See `setControlPassword` below.
	private static var controlFile: String { dir + "/control-pass" }

	/// Whether the file on disk could not be parsed.
	///
	/// Carried on the value rather than in a static, both because a mutable global is
	/// a data race the compiler now rejects, and because it belongs to the snapshot
	/// that was read — not to the type.
	///
	/// Distinguished from absent, because `save()` does a read-modify-write and
	/// writing over an unparseable file would destroy real settings, including the
	/// unknown keys the merge exists to preserve. Opening Settings and pressing Apply
	/// after a corrupt read used to do exactly that.
	var unreadable = false

	static func load() -> Config {
		var c = Config()
		guard let data = FileManager.default.contents(atPath: file) else { return c }
		guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			c.unreadable = true
			return c
		}
		c.serve = o["serve"] as? Bool ?? c.serve
		c.port = o["port"] as? Int ?? c.port
		c.host = o["host"] as? String ?? c.host
		c.labels = o["labels"] as? String ?? c.labels
		c.awakeDisplay = o["awakeDisplay"] as? Bool ?? c.awakeDisplay
		c.control = o["control"] as? Bool ?? c.control
		return c
	}

	/// Write the whole file back.
	///
	/// Read-modify-write of the parsed object rather than a patch, so a key this
	/// app does not know about is preserved instead of being dropped — a future
	/// setting added on the server side must not be erased by an older bar app.
	func save() throws {
		if unreadable { throw Failure.unreadable }
		var o: [String: Any] = [:]
		if let data = FileManager.default.contents(atPath: Config.file),
			let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		{
			o = existing
		}
		o["serve"] = serve
		o["port"] = port
		o["host"] = host
		o["labels"] = labels
		o["awakeDisplay"] = awakeDisplay
		o["control"] = control
		let data = try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])
		try Config.write(data, to: Config.file)
	}

	static func passcode() -> String {
		(try? String(contentsOfFile: passcodeFile, encoding: .utf8))?
			.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
	}

	/// Set the view passcode, by handing it to guildhall.
	///
	/// It used to write the file directly, which looked equivalent and was not.
	/// `setPasscode` on the other side also refuses a list of weak codes and rotates
	/// the session key — so a code set here was accepted when the terminal would have
	/// refused it (`1234` included, which was this field's own placeholder), and every
	/// paired device stayed signed in while the panel said "signs every device out".
	/// Cookies survive a restart by design, so the restart did not cover for it.
	static func setPasscode(_ code: String) async throws {
		guard code.count == 4, code.allSatisfy(\.isNumber) else { throw Failure.badPasscode }
		try await guildhall(["--set-passcode"], stdin: code)
	}

	/// Whether a control password exists. Its VALUE is never read here.
	///
	/// Only ever a yes or no: the file holds an scrypt hash, and there is nothing in
	/// it this app could show or check even if it wanted to.
	static func controlPasswordIsSet() -> Bool {
		guard let s = try? String(contentsOfFile: controlFile, encoding: .utf8) else { return false }
		return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	/// Set the control password, by handing it to guildhall to hash.
	///
	/// The password is written to the child's STDIN and nowhere else. Not an
	/// argument — argv is readable by every process on the machine through `ps` —
	/// not a temporary file, and not this app's memory for any longer than the call.
	///
	/// The hashing, the length rule and the "too few different characters" rule all
	/// stay in `setControlPass`, which is the only place they have ever been. This
	/// app deliberately does not know how the credential is stored; it just types it
	/// in on the person's behalf, which is what the terminal key handler does too.
	/// Async, because this blocks for as long as node takes to boot and scrypt takes
	/// to run — and scrypt is deliberately slow. Called inline from a @MainActor view
	/// it froze the whole app for something like a second on every "Set".
	static func setControlPassword(_ password: String) async throws {
		try await guildhall(["--set-control-password"], stdin: password)
	}

	/// Where node and guildhall are, resolved at RUN time.
	///
	/// The build bakes both paths into Info.plist, and that path is a hint rather
	/// than an answer. `command -v node` on a machine using nvm gives something like
	/// `~/.nvm/versions/node/v22.0.0/bin/node`, which stops existing the next time
	/// anybody runs `nvm install` — on the same machine, never mind a different one.
	/// And the entry point lives in `dist/`, which is gitignored, so on a fresh
	/// checkout it does not exist until something builds it.
	///
	/// So: an environment override first, then the baked hint, then the same kind of
	/// candidate search `Cmux.binary()` already does. Nothing here is allowed to
	/// assume one machine's layout.
	static func tools() -> (node: String, entry: String)? {
		let env = ProcessInfo.processInfo.environment
		let baked = { (key: String) in Bundle.main.object(forInfoDictionaryKey: key) as? String }

		let nodeCandidates = [
			env["GUILDHALL_NODE"], baked("GHNode"),
			"/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
		].compactMap { $0 }
		// Any nvm version, newest first, so an upgrade is picked up rather than fatal.
		let nvm = (try? FileManager.default.contentsOfDirectory(atPath: home + "/.nvm/versions/node"))?
			.sorted(by: >)
			.map { home + "/.nvm/versions/node/\($0)/bin/node" } ?? []
		guard let node = (nodeCandidates + nvm).first(where: { FileManager.default.isExecutableFile(atPath: $0) })
		else { return nil }

		let entryCandidates = [env["GUILDHALL_ENTRY"], baked("GHEntry")].compactMap { $0 }
		guard let entry = entryCandidates.first(where: { FileManager.default.fileExists(atPath: $0) })
		else { return nil }
		return (node, entry)
	}

	private static var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

	/// Run guildhall with a secret on stdin, and surface its own words on refusal.
	private static func guildhall(_ args: [String], stdin secret: String) async throws {
		guard let found = tools() else { throw Failure.noCLI }

		let task = Process()
		task.executableURL = URL(fileURLWithPath: found.node)
		task.arguments = [found.entry] + args
		let input = Pipe(), output = Pipe()
		task.standardInput = input
		task.standardOutput = output
		task.standardError = output
		// `waitUntilExit()` would add ~64ms of run-loop sleep on top; the termination
		// handler gives the same exit status for the child's real cost.
		let result: (Int32, String) = try await withCheckedThrowingContinuation { continuation in
			task.terminationHandler = { finished in
				let said = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
				continuation.resume(returning: (finished.terminationStatus, said))
			}
			do {
				try task.run()
					// The throwing overload: the non-throwing one raises an Objective-C
				// NSFileHandleOperationException on EPIPE, which Swift cannot catch — a
				// crash, not an error — and EPIPE is reachable whenever the child exits
				// before reading stdin.
				try input.fileHandleForWriting.write(contentsOf: Data(secret.utf8))
				// Closed so the child's read of stdin ends; without this it waits forever.
				try? input.fileHandleForWriting.close()
			} catch {
				continuation.resume(throwing: error)
			}
		}
		guard result.0 == 0 else {
			// guildhall's own words, which already explain what was wrong with it.
			throw Failure.refused(result.1.trimmingCharacters(in: .whitespacesAndNewlines))
		}
	}

	enum Failure: Error, LocalizedError {
		case badPasscode
		case unreadable
		case noCLI
		case refused(String)
		var errorDescription: String? {
			switch self {
			case .badPasscode: return "A passcode is exactly four digits."
			case .unreadable:
				return "~/.config/guildhall/config.json could not be read, so saving would overwrite real settings. Fix or delete it first."
			case .noCLI:
				// Names both halves, because they fail for different reasons: node moves
				// when nvm upgrades, and dist/ is gitignored so a fresh checkout has none
				// until something builds it. Telling somebody to rebuild the Swift app
				// when the real problem is a missing dist/ sends them the wrong way.
				return "Can't find node or guildhall's dist/main.mjs. Run `guildhall --upgrade`, or set GUILDHALL_NODE and GUILDHALL_ENTRY."
			case .refused(let why): return why.isEmpty ? "Refused." : why
			}
		}
	}

	/// Write via a temporary file and rename, at 0600.
	///
	/// Atomic because a half-written config is a config guildhall cannot parse, and
	/// it is read at startup — so the failure would be a service that no longer
	/// starts. 0600 because two of these files are credentials.
	private static func write(_ data: Data, to path: String) throws {
		// The directory first. On a machine where guildhall has never run, every save
		// threw a raw Cocoa error about a missing folder; node's own save does
		// mkdirSync(recursive, 0o700) and this did not.
		try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		let tmp = path + ".tmp"
		do {
			try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
			try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp)
			// `.usingNewMetadataOnly`, or the replace PRESERVES THE DESTINATION'S mode
			// and the 0600 above is silently discarded. Measured: replacing a file that
			// was already 0644 left a credential at 0644. It only looks fine because
			// node happens to create these at 0600 — it fails in exactly the recovery
			// cases, a restore or an `echo 1234 >`.
			_ = try FileManager.default.replaceItemAt(
				URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp), options: .usingNewMetadataOnly)
		} catch {
			// Never leave a temp file holding a credential behind.
			try? FileManager.default.removeItem(atPath: tmp)
			throw error
		}
	}
}
