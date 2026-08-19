import Foundation

/// Reading and writing guildhall's own settings file.
///
/// The app edits `~/.config/guildhall/config.json` directly rather than asking
/// the server to do it. Two reasons, and the second is the important one:
///
/// It runs as the same user on the same machine, which is the trust boundary the
/// whole design already uses — the control password is typed HERE and never
/// accepted over the network for exactly this reason.
///
/// And a settings endpoint would be a write surface reachable by anything that
/// got past the passcode. The passcode guards reading session summaries; it
/// should not also be the only thing between a visitor and this machine's port,
/// its passcode and whether control is armed.
///
/// Changing the port or the passcode needs the service restarted to take effect,
/// which the caller does — the app already owns that button.
struct Config {
	var serve = true
	var port = 4318
	var host = "0.0.0.0"
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

	static func load() -> Config {
		var c = Config()
		guard let data = FileManager.default.contents(atPath: file),
			let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return c }
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

	/// Four digits, and only four digits.
	///
	/// The same rule the terminal enforces. It is not the security — the throttle
	/// is — but a code of a different length would simply never match.
	static func setPasscode(_ code: String) throws {
		guard code.count == 4, code.allSatisfy(\.isNumber) else {
			throw Failure.badPasscode
		}
		try write(Data(code.utf8), to: passcodeFile)
	}

	/// Whether a control password exists. Its VALUE is never read or written here.
	///
	/// It is stored as an scrypt hash, and `setControlPass` in the app refuses to
	/// write the live file unless the caller passes `{ live: true }` — a guard that
	/// exists because a throwaway script once replaced the real password with a test
	/// string. Reimplementing scrypt in Swift to write that file from a second place
	/// would defeat the guard and duplicate the one credential in this project that
	/// must not be got wrong. So this reports whether it is set and nothing more; it
	/// is changed by typing it into the terminal, which is also the trust boundary
	/// the feature is documented to have.
	static func controlPasswordIsSet() -> Bool {
		guard let s = try? String(contentsOfFile: controlFile, encoding: .utf8) else { return false }
		return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	enum Failure: Error, LocalizedError {
		case badPasscode
		var errorDescription: String? {
			switch self {
			case .badPasscode: return "A passcode is exactly four digits."
			}
		}
	}

	/// Write via a temporary file and rename, at 0600.
	///
	/// Atomic because a half-written config is a config guildhall cannot parse, and
	/// it is read at startup — so the failure would be a service that no longer
	/// starts. 0600 because two of these files are credentials.
	private static func write(_ data: Data, to path: String) throws {
		let tmp = path + ".tmp"
		try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
		try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp)
		_ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
	}
}
