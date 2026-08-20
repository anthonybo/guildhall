import Foundation

/// The plan quota and today's spend, read straight off disk.
///
/// Not fetched over HTTP. It was, and that made the numbers depend on which
/// guildhall happened to be holding the port: a room left running since before
/// `/api/usage` existed answered "not found", so the whole section stayed
/// invisible with nothing to explain why. The cache is a file both sides already
/// share, and reading it needs no server at all.
///
/// Refreshing is still guildhall's job — it owns the token and the backoff — so
/// this runs `guildhall --usage` when the file is old, and only ever one at a
/// time. That is a Node process, which is why it is gated on the file's age and
/// not on the poll.
actor UsageStore {
	static let shared = UsageStore()

	private static var file: String { Config.dir + "/usage.json" }
	/// Matches the server's own window. Anything fresher is not more correct: the
	/// limits it describes are five hours and a week long.
	private static let ttl: TimeInterval = 5 * 60
	/// When a refresh was last ATTEMPTED, as opposed to when the file was last
	/// written. The two differ exactly when the fetch is failing, which is when a
	/// retry storm would otherwise start.
	private var lastTried = Date.distantPast
	/// Guarded by the actor. It was a mutable static written from the main thread and
	/// from `terminationHandler` — which Foundation calls on an arbitrary queue — so a
	/// lost update either stranded it `true` (usage never refreshes again for the life
	/// of the process) or `false` (overlapping node spawns).
	private var refreshing = false

	nonisolated static func load() -> Usage? {
		guard let data = FileManager.default.contents(atPath: file) else {
			Task { await shared.refreshIfNeeded(age: .infinity) }
			return nil
		}
		let usage = try? JSONDecoder().decode(Usage.self, from: data)
		let age = Date().timeIntervalSince1970 - ((usage?.at ?? 0) / 1000)
		Task { await shared.refreshIfNeeded(age: age) }
		return usage
	}

	private func refreshIfNeeded(age: TimeInterval) {
		guard age > Self.ttl, !refreshing, Date().timeIntervalSince(lastTried) > Self.ttl else { return }
		// The server's own backoff after a failure is 15 minutes, longer than this
		// 5-minute window, so a quota that is erroring left the file's timestamp
		// unchanged and every poll spawned another node — about 120 of them, 0.26
		// cpu-s each, per 15-minute cycle. Only one at a time, and never faster than
		// the window, whatever the file says.
		lastTried = Date()
		// Resolved at run time rather than trusting the baked path: see Config.tools().
		guard let found = Config.tools() else { return }
		let (node, entry) = found
		refreshing = true
		let task = Process()
		task.executableURL = URL(fileURLWithPath: node)
		task.arguments = [entry, "--usage"]
		task.standardOutput = FileHandle.nullDevice
		task.standardError = FileHandle.nullDevice
		// The flag cleared when it exits, so a slow fetch cannot pile up behind
		// itself. ccusage takes seconds and the poll is every five, which without
		// this would be a queue of Node processes.
		task.terminationHandler = { _ in Task { await UsageStore.shared.done() } }
		do { try task.run() } catch { refreshing = false }
	}

	private func done() { refreshing = false }
}
