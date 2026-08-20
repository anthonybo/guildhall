import Foundation

/// One session, as the server already describes it.
///
/// Deliberately a subset. The payload carries a dozen more fields — context
/// counts, transcript excerpts, cmux workspace ids — and decoding only what is
/// shown means a new field on the server cannot break this app.
struct Session: Decodable, Identifiable {
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
	var label: String { proj?.isEmpty == false ? proj! : name }

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

	/// How long until this window rolls over, worded the way the room words ages.
	var resets: String? {
		guard let iso = resetsAt else { return nil }
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		guard let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
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
	private var cookie: String?

	/// Re-read the config, in case the port moved while this was running.
	func reload() { settings = Settings.load() }

	var baseURL: URL { URL(string: "http://127.0.0.1:\(settings.port)")! }

	enum Failure: Error, Equatable {
		case notRunning
		case refused
		case badResponse
	}

	/// Plan quota and today's spend, from guildhall's cache.
	///
	/// A separate request from the sessions one because the server keeps them apart:
	/// this is fetched from Anthropic's API on a five-minute cache, and putting it in
	/// the two-second session poll would have tied a third-party call to guildhall's
	/// own tick.
	func usage() async throws -> Usage {
		if cookie == nil { try await authenticate() }
		var req = URLRequest(url: baseURL.appendingPathComponent("api/usage"))
		req.timeoutInterval = 5
		if let cookie { req.setValue("gh_sid=\(cookie)", forHTTPHeaderField: "Cookie") }
		let (data, response) = try await send(req)
		guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw Failure.badResponse }
		return try JSONDecoder().decode(Usage.self, from: data)
	}

	func sessions() async throws -> [Session] {
		do {
			return try await fetch()
		} catch Failure.refused {
			// The cookie is a session id and the server issues a new signing key on every
			// start, so a restarted daemon invalidates it. One silent re-auth rather than
			// surfacing an error the person can do nothing about.
			cookie = nil
			return try await fetch()
		}
	}

	private func fetch() async throws -> [Session] {
		if cookie == nil { try await authenticate() }
		var req = URLRequest(url: baseURL.appendingPathComponent("api/sessions"))
		req.timeoutInterval = 5
		if let cookie { req.setValue("gh_sid=\(cookie)", forHTTPHeaderField: "Cookie") }
		let (data, response) = try await send(req)
		guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
		if http.statusCode == 401 || http.statusCode == 403 { throw Failure.refused }
		guard http.statusCode == 200 else { throw Failure.badResponse }
		return try JSONDecoder().decode(Payload.self, from: data).sessions
	}

	private func authenticate() async throws {
		var req = URLRequest(url: baseURL.appendingPathComponent("auth"))
		req.httpMethod = "POST"
		req.timeoutInterval = 5
		req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
		req.httpBody = "code=\(settings.passcode)".data(using: .utf8)
		let (_, response) = try await send(req)
		guard let http = response as? HTTPURLResponse,
			let header = http.value(forHTTPHeaderField: "Set-Cookie"),
			let value = header.split(separator: ";").first?.split(separator: "=").last
		else { throw Failure.refused }
		cookie = String(value)
	}

	/// URLSession, with redirects left alone.
	///
	/// `/auth` answers 303 to `/`, and following it would fetch the whole HTML page
	/// to learn something the Set-Cookie header already said.
	private func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
		do {
			return try await URLSession.noRedirects.data(for: req)
		} catch let error as URLError where error.code == .cannotConnectToHost || error.code == .networkConnectionLost {
			throw Failure.notRunning
		}
	}
}

extension URLSession {
	fileprivate static let noRedirects: URLSession = {
		final class Stop: NSObject, URLSessionTaskDelegate {
			func urlSession(
				_ session: URLSession, task: URLSessionTask,
				willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest,
				completionHandler: @escaping (URLRequest?) -> Void
			) { completionHandler(nil) }
		}
		let config = URLSessionConfiguration.ephemeral
		config.requestCachePolicy = .reloadIgnoringLocalCacheData
		return URLSession(configuration: config, delegate: Stop(), delegateQueue: nil)
	}()
}
