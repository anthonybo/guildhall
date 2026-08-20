import AppKit
import SwiftUI

/// What the menu bar knows, refreshed on a timer.
@MainActor
final class Model: ObservableObject {
	@Published var sessions: [Session] = []
	@Published var reachable = false
	@Published var daemon: Daemon.State = .notInstalled
	@Published var usage: Usage?

	private let client = Client()
	private var timer: Timer?

	/// Idle cadence.
	///
	/// Slow on purpose. This is a status light, not a dashboard: the states it
	/// reports change on the scale of a turn, and the server does real work —
	/// `collect()` walks the registry — for every request. Faster is not more
	/// correct, it is only more expensive on a machine somebody is trying to use.
	private let idle: TimeInterval = 5
	/// While the panel is open, where a person is actually looking at it.
	private let watching: TimeInterval = 2
	/// When the launchd state was last read, and how long that is good for.
	///
	/// Asking costs a process spawn — measured at 43-45ms from inside this app — and
	/// the answer changes only when somebody starts or stops the service, which is
	/// something this app is told about because it does it. Polling it every two
	/// seconds was pure waste: thirty spawns a minute to watch a value that changes
	/// once a day.
	private var daemonCheckedAt = Date.distantPast
	private let daemonTTL: TimeInterval = 30

	/// What the icon should say.
	var mood: BarIcon.Mood {
		if !reachable { return .unknown }
		if !needsYou.isEmpty { return .needsYou }
		return working.isEmpty ? .quiet : .active
	}

	/// The number beside it, or nothing when there is nothing to count. A "0" next
	/// to a quiet icon is noise; the icon already said it.
	var badge: Int? {
		if !reachable { return nil }
		if !needsYou.isEmpty { return needsYou.count }
		return working.isEmpty ? nil : working.count
	}

	var needsYou: [Session] { sessions.filter(\.needsYou) }
	var working: [Session] { sessions.filter(\.working) }

	/// Start polling as soon as the app exists.
	///
	/// This was only started from the panel's `onAppear`, which fires when the
	/// dropdown is OPENED — so until somebody clicked the icon, nothing was ever
	/// fetched and the label sat on its empty-state glyph. An icon whose entire job
	/// is to be correct without being clicked cannot wait to be clicked.
	init() {
		start()
		heartbeat()
	}

	/// A tick on the main actor, purely to detect when it is blocked.
	///
	/// Temporary instrumentation. A gap much larger than the interval means something
	/// ran long on the main thread, which is exactly what "it takes seconds to open"
	/// looks like from the inside and what no amount of reading the code has settled.
	private func heartbeat() {
		Task { [weak self] in
			var last = Date()
			while !Task.isCancelled {
				try? await Task.sleep(nanoseconds: 250_000_000)
				let now = Date()
				let gap = now.timeIntervalSince(last) * 1000
				if gap > 900 { self?.note("MAIN BLOCKED ~\(Int(gap - 250))ms") }
				last = now
			}
		}
	}

	/// The polling loop, as a Task rather than a Timer.
	///
	/// `Timer.scheduledTimer` only fires in the run loop's `.default` mode, so polls
	/// were suppressed while the list was being scrolled and then all landed at once
	/// when the gesture ended — the stall arriving exactly when the hand stopped
	/// moving. A sleeping Task is mode-insensitive.
	private var loop: Task<Void, Never>?
	/// The refresh in flight, so overlapping ones cannot queue up behind each other.
	private var current: Task<Void, Never>?

	func start(open: Bool = false) {
		loop?.cancel()
		let every = open ? watching : idle
		loop = Task { [weak self] in
			// Refresh once immediately, then on the cadence. `start()` used to fire an
			// extra refresh on EVERY call — from init, from onAppear and from
			// onDisappear — so opening the popover always cost a full extra round trip
			// landing during the appear animation.
			while !Task.isCancelled {
				await self?.refresh()
				try? await Task.sleep(nanoseconds: UInt64(every * 1_000_000_000))
			}
		}
	}

	func refresh() async {
		// Single flight. The cadence is 2s and the HTTP timeout is 5s, so up to three
		// refreshes could overlap; they serialised on the actor and their main-actor
		// segments queued behind one another, which is felt as lag rather than seen.
		if let current { return await current.value }
		let task = Task { await reload() }
		current = task
		await task.value
		current = nil
	}

	private func reload() async {
		// Only ask launchd when it might matter. A successful fetch already proves the
		// service is up, and asking every poll spawned ~30 processes a minute whose
		// answer was then immediately overwritten by `.running`.
		if !Daemon.installed {
			set(daemon: .notInstalled)
		}
		do {
			let fetched = try await client.sessions()
			if fetched != sessions { sessions = fetched }
			if !reachable { reachable = true }
			if Daemon.installed, daemon != .running { set(daemon: .running) }
			log("ok: \(sessions.count) sessions, \(needsYou.count) need you, \(working.count) working")
		} catch {
			// One dropped request is not "nothing is running". The list is kept and only
			// cleared after a few consecutive failures, so the label does not flash to a
			// dash during the second-long window of a restart this app itself triggered.
			failures += 1
            if failures >= 3 {
				if reachable { reachable = false }
				if !sessions.isEmpty { sessions = [] }
				if Daemon.installed { set(daemon: await Daemon.state()) }
			}
			log("failed (\(failures)): \(error)")
		}
		if reachable { failures = 0 }
		// Off the main actor. Wrapping this in `await timed(…)` did NOT move it — the
		// closure is non-Sendable so it inherits @MainActor and runs inline — and it
		// re-read and re-decoded a file that changes every five minutes, on every poll.
		let fresh = await Task.detached { UsageStore.load() }.value
		if fresh?.at != usage?.at || fresh?.cost != usage?.cost { usage = fresh }
	}

	private var failures = 0
	private func set(daemon next: Daemon.State) { if daemon != next { daemon = next } }

	/// One line per change, to stderr — which the LaunchAgent sends to
	/// ~/Library/Logs/guildhall-bar.log.
	///
	/// A menu bar app has one glyph to say everything with, so when it says the
	/// wrong thing there is nowhere to look. Repeats are collapsed so an idle machine
	/// does not write a line every few seconds forever.
	private var lastLine = ""
	private func log(_ line: String) {
		guard line != lastLine else { return }
		lastLine = line
		FileHandle.standardError.write("\(Date().formatted(date: .omitted, time: .standard))  \(line)\n".data(using: .utf8)!)
	}

	/// A one-off line that is never deduped — for things a person did.
	func note(_ line: String) {
		lastLine = ""
		log(line)
	}

	/// Run a launchd change off the main thread, then re-read the truth.
	///
	/// The closure used to be called inline from this @MainActor type, so every
	/// Start/Stop/Restart froze the UI for launchctl's whole duration — 64ms of
	/// Foundation sleep plus the real work of parsing a plist or killing a process.
	/// Those are the buttons that "did nothing".
	///
	/// It polls for the expected state instead of sleeping a guessed 900ms, and
	/// surfaces what launchctl said when it refused.
	func act(_ change: @escaping () async -> String?) {
		Task {
			if let complaint = await change() { note("launchctl: \(complaint)") }
			await client.reload()
			// launchd is not synchronous, so the state right after a change is the old
			// one. Poll briefly rather than guessing a delay.
			for _ in 0..<10 {
				await refresh()
                if reachable || daemon == .stopped { break }
				try? await Task.sleep(nanoseconds: 300_000_000)
			}
		}
	}

	func openBrowser() {
		Task {
			let url = await client.baseURL
			await MainActor.run { _ = NSWorkspace.shared.open(url) }
		}
	}
}

@main
struct GuildhallBarApp: App {
	@StateObject private var model = Model()

	var body: some Scene {
		MenuBarExtra {
			Panel(model: model)
		} label: {
			// The label answers one question without being clicked: does anything want
			// me. Colour carries it, and the count is the detail underneath.
			//
			// Colour rather than shape alone because the shape is 14 points wide in a
			// row of other people's icons — green against grey is legible at a glance in
			// a way a filled versus hollow building is not. The shape still changes too,
			// so this does not depend on colour vision.
			if let icon = BarIcon.image(for: model.mood) {
				Image(nsImage: icon)
					.accessibilityLabel(BarIcon.label(for: model.mood))
			} else {
				// If a symbol is ever missing, say something rather than showing nothing:
				// an absent status item looks exactly like an app that failed to start.
				Text("gh")
			}
			if let count = model.badge {
				Text("\(count)")
			} else if model.mood == .unknown {
				// Quiet and unreachable are the same glyph now that both are templates, so
				// the dash is what separates "nothing is happening" from "I cannot see".
				Text("—")
			}
		}
		// .window, not .menu: the content is a list of sessions with two lines each,
		// which a stack of NSMenuItems renders badly and cannot scroll.
		.menuBarExtraStyle(.window)

		// NO second Scene here, deliberately.
		//
		// A `WindowGroup` was added to render the dropdown in a plain window so it
		// could be screenshotted. It never came to the front, and it broke the app:
		// declaring a window scene in an accessory app (LSUIElement) gives SwiftUI a
		// window that can take key status, and a menu bar popover that is not the key
		// window draws normally and accepts nothing. Reported as "I cannot click
		// anything in that menu, it is only visual".
		//
		// Being unable to screenshot the panel is a testing inconvenience. Shipping a
		// panel that cannot be clicked is the product not working, and the fix for the
		// first must not cause the second.
	}
}
