import Foundation

/// One session, as the server already describes it.
///
/// Deliberately a subset. The payload carries a dozen more fields — context
/// counts, transcript excerpts, cmux workspace ids — and decoding only what is
/// shown means a new field on the server cannot break this app.
struct Session: Decodable, Identifiable, Equatable {
	let id: String
	let name: String
	let proj: String?
	let state: String
	let stale: Double
	let title: String?
	let doing: String?
	let tab: Int?
	/// cmux workspace UUID, which is what focusing a tab actually needs.
	let workspace: String?
	let level: Int?
	let turns: Int?
	let unread: Bool?
	/// "59 dispatched", already worded by the server.
	let agents: String?
	let toolKind: String?
	let ctxUsed: Double?
	let ctxLimit: Double?

	/// How full the context window is, 0 to 1, or nil when the server did not say.
	///
	/// This is guildhall's answer to the cost and quota numbers other menu bar apps
	/// show: it is the number that actually changes what happens next, because a
	/// session near its limit is about to compact and lose the thread.
	var context: Double? {
		guard let used = ctxUsed, let limit = ctxLimit, limit > 0 else { return nil }
		return min(1, used / limit)
	}

	/// What the room calls this, which is the project rather than the session id.
	var label: String { proj.flatMap { $0.isEmpty ? nil : $0 } ?? name }

	/// Whether this one is waiting on a person. The room draws a placard for it and
	/// the menu bar exists mostly to answer this question without opening anything.
	var needsYou: Bool { state == "needs" }
	var working: Bool { state == "working" || state == "shell" }
}

private struct Payload: Decodable { let sessions: [Session] }

/// One of the plan's limits, as guildhall's /api/usage reports it.
struct Limit: Decodable, Identifiable {
	let kind: String
	let model: String?
	let percent: Double?
	let resetsAt: String?
	var id: String { kind + (model ?? "") }

	/// "Session (5h)", "Weekly", and so on — the API's own kind, made readable.
	var title: String {
		switch kind {
		case "session": return "Session (5h)"
		case "weekly_all": return "Weekly"
		case "weekly_scoped": return model.map { "Weekly · \($0)" } ?? "Weekly (scoped)"
		default: return kind.replacingOccurrences(of: "_", with: " ")
		}
	}

	/// Two shared parsers, built once.
	///
	/// `nonisolated(unsafe)` rather than `@MainActor`: they are read from a computed
	/// property on a value type that view bodies use, so main-actor isolation makes
	/// the property itself unusable from anywhere else. `ISO8601DateFormatter` is
	/// documented as thread-safe for parsing, and nothing here mutates it after
	/// construction — the unsafe marker is the accurate statement of that, rather
	/// than a claim the compiler can check.
	///
	/// The point of hoisting them at all:
	///
	/// Built once, at module scope. `ISO8601DateFormatter()` is expensive to create —
	/// milliseconds, not microseconds — and these were constructed inside a computed
	/// property read from a SwiftUI view body, so every render of the quota section
	/// built two of them per limit.
	nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return f
	}()
	nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

	/// How long until this window rolls over, worded the way the room words ages.
	var resets: String? {
		guard let iso = resetsAt else { return nil }
		guard let date = Limit.fractional.date(from: iso) ?? Limit.plain.date(from: iso) else { return nil }
		let secs = date.timeIntervalSinceNow
		if secs <= 0 { return "now" }
		let h = Int(secs / 3600), m = Int(secs / 60) % 60
		return h > 24 ? "in \(h / 24)d" : h > 0 ? "in \(h)h \(m)m" : "in \(m)m"
	}
}

struct Usage: Decodable {
	let limits: [Limit]
	let cost: Double?
	let at: Double
	let error: String?
}

/// Where guildhall keeps its settings, and what it is listening on.
///
/// Read from the config file rather than hardcoded, because the port is a setting
/// that can be changed from the help panel — an app that assumed 4318 would
/// silently stop working the moment somebody moved it.
struct Settings {
	var port: Int = 4318
	var passcode: String = ""

	static func load() -> Settings {
		var s = Settings()
		let dir = ProcessInfo.processInfo.environment["GUILDHALL_CONFIG_DIR"]
			?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/guildhall").path
		if let data = FileManager.default.contents(atPath: dir + "/config.json"),
			let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let p = obj["port"] as? Int
		{
			s.port = p
		}
		// The passcode is required here exactly as it is everywhere else — there is no
		// localhost exemption in the server and this app does not ask for one. It reads
		// the code the same way a person sitting at this machine reads it off the help
		// panel: a 0600 file owned by the same user. The gate is unchanged for anything
		// arriving over the network.
		if let code = try? String(contentsOfFile: dir + "/passcode", encoding: .utf8) {
			s.passcode = code.trimmingCharacters(in: .whitespacesAndNewlines)
		}
		return s
	}
}

/// Talks to the local guildhall.
///
/// Polls rather than holding the server's SSE stream open. The stream is the
/// better fit for a page that is being looked at; a menu bar item is usually not
/// being looked at, and a poll that stops when the machine sleeps and resumes
/// when it wakes needs no reconnection logic at all. `collect()` is measured at
/// about 4 cpu-ms, so a request every few seconds is not a cost worth optimising
/// away with code that can get stuck half-connected.
actor Client {
	private var settings = Settings.load()

	/// Re-read the config, in case the port moved while this was running.
	func reload() { settings = Settings.load() }

	/// Clamped, because the port is read off disk and nothing else validates it. A
	/// junk value would otherwise force-unwrap a nil URL and crash the app.
	var baseURL: URL {
		let port = (1024...65535).contains(settings.port) ? settings.port : 4318
		return URL(string: "http://127.0.0.1:\(port)")!
	}

	enum Failure: Error, Equatable {
		case notRunning
		case refused
		case badResponse
		/// guildhall itself could not be located, which is a different problem from it
		/// not answering — and a different sentence for the panel to show.
		case noCLI
	}

	/// The room, read by running `guildhall --sessions`.
	///
	/// This was an HTTP GET to `127.0.0.1:<port>/api/sessions`, behind the view
	/// passcode, which meant the icon only worked while an HTTP server was listening.
	/// So installing the menu bar app installed a server, and the machine began
	/// answering on every interface for data it only ever showed to itself. Serving
	/// the browser view is now a setting that is off until somebody turns it on, and
	/// this reads the same snapshot the HTTP route would have served — `snapshot()` in
	/// serve.ts, one definition, two callers.
	///
	/// It also removes the passcode from this path entirely. UsageStore already read
	/// its half this way, for a related reason written down there: depending on the
	/// port meant depending on which guildhall happened to be holding it.
	func sessions() async throws -> [Session] {
		guard let (node, entry) = Config.tools() else { throw Failure.noCLI }
		let (status, out) = await Daemon.run(node, [entry, "--sessions"])
		guard status == 0 else { throw Failure.notRunning }
		guard let data = out.data(using: .utf8), !data.isEmpty else { throw Failure.badResponse }
		do {
			return try JSONDecoder().decode(Payload.self, from: data).sessions
		} catch {
			// stdout is not JSON. Almost always a node that printed a warning first, and
			// worth distinguishing from "nothing is running" so the panel can say which.
			throw Failure.badResponse
		}
	}
}
