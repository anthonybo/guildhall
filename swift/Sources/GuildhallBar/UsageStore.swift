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
enum UsageStore {
	private static var file: String { Config.dir + "/usage.json" }
	/// Matches the server's own window. Anything fresher is not more correct: the
	/// limits it describes are five hours and a week long.
	private static let ttl: TimeInterval = 5 * 60
	private static var refreshing = false

	static func load() -> Usage? {
		guard let data = FileManager.default.contents(atPath: file) else {
			refreshIfNeeded(age: .infinity)
			return nil
		}
		let usage = try? JSONDecoder().decode(Usage.self, from: data)
		let age = Date().timeIntervalSince1970 - ((usage?.at ?? 0) / 1000)
		refreshIfNeeded(age: age)
		return usage
	}

	private static func refreshIfNeeded(age: TimeInterval) {
		guard age > ttl, !refreshing else { return }
		guard let node = Bundle.main.object(forInfoDictionaryKey: "GHNode") as? String,
			let entry = Bundle.main.object(forInfoDictionaryKey: "GHEntry") as? String
		else { return }
		refreshing = true
		let task = Process()
		task.executableURL = URL(fileURLWithPath: node)
		task.arguments = [entry, "--usage"]
		task.standardOutput = FileHandle.nullDevice
		task.standardError = FileHandle.nullDevice
		// The flag cleared when it exits, so a slow fetch cannot pile up behind
		// itself. ccusage takes seconds and the poll is every five, which without
		// this would be a queue of Node processes.
		task.terminationHandler = { _ in refreshing = false }
		do { try task.run() } catch { refreshing = false }
	}
}
