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

	var needsYou: [Session] { sessions.filter(\.needsYou) }
	var working: [Session] { sessions.filter(\.working) }

	/// Start polling as soon as the app exists.
	///
	/// This was only started from the panel's `onAppear`, which fires when the
	/// dropdown is OPENED — so until somebody clicked the icon, nothing was ever
	/// fetched and the label sat on its empty-state glyph. An icon whose entire job
	/// is to be correct without being clicked cannot wait to be clicked.
	init() { start() }

	func start(open: Bool = false) {
		timer?.invalidate()
		timer = Timer.scheduledTimer(withTimeInterval: open ? watching : idle, repeats: true) { [weak self] _ in
			Task { await self?.refresh() }
		}
		Task { await refresh() }
	}

	func refresh() async {
		daemon = !Daemon.installed ? .notInstalled : Daemon.loaded() ? .loadedNotServing : .stopped
		do {
			sessions = try await client.sessions()
			reachable = true
			// Loaded AND answering. Distinguished because "the service is running" and
			// "the browser view works" are different claims, and the gap between them —
			// loaded but unable to bind — is exactly the case that used to go unnoticed.
			if daemon == .loadedNotServing { daemon = .running }
			log("ok: \(sessions.count) sessions, \(needsYou.count) need you, \(working.count) working")
			// Its own cache on the server, so asking every poll costs a local request and
			// no third-party call.
			usage = try? await client.usage()
		} catch {
			sessions = []
			reachable = false
			log("failed: \(error)")
		}
	}

	/// One line per poll, to stderr — which the LaunchAgent sends to
	/// /tmp/guildhall-bar.log.
	///
	/// A menu bar app has one glyph to say everything with, so when it says the
	/// wrong thing there is nowhere to look. This existed as nothing at all, and the
	/// first time the icon disagreed with the server there was no way to tell
	/// "cannot reach it" from "reached it and it said zero" — which are the same
	/// picture and completely different faults.
	///
	/// Repeats are collapsed so an idle machine does not write a line every five
	/// seconds forever.
	/// Log a one-off line, for working out whether the panel is alive.
	func note(_ line: String) { log(line) }

	private var lastLine = ""
	private func log(_ line: String) {
		guard line != lastLine else { return }
		lastLine = line
		FileHandle.standardError.write("\(Date().formatted(date: .omitted, time: .standard))  \(line)\n".data(using: .utf8)!)
	}

	func act(_ change: () -> Void) {
		change()
		// launchd is not synchronous; a read straight after a bootstrap reports the
		// old state. One short delay, then ask.
		Task {
			try? await Task.sleep(nanoseconds: 900_000_000)
			await client.reload()
			await refresh()
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
			// The label is the whole point of the app: the number of sessions that want
			// a person, at a glance, without opening anything. A count of what is
			// WORKING is second, because that answers "is it safe to close the lid".
			//
			// The resting glyph is a hall with columns, which is the app's own name and
			// the thing it draws — a room full of workers at desks. It was a plain
			// circle, which is what every other status item in a menu bar looks like:
			// nothing about it said which app it belonged to or what it was for.
			//
			// The glyph changes with state rather than only the number, because the
			// count is unreadable at a glance and the shape is not. Filled means
			// somebody is working; hollow means the room is quiet.
			//
			// The one exception to the family is "needs you". That is the state you must
			// not miss, so it gets the shape everything else on the system uses for
			// exactly that, rather than a subtler version of the hall.
			if !model.reachable {
				// A dash, not a dimmed hall. Dimming was the first attempt and it is
				// indistinguishable from the quiet state at menu bar size, which makes
				// the two conditions that most need telling apart — "nothing is
				// happening" and "I cannot see anything" — look the same.
				Image(systemName: "building.columns")
				Text("—")
			} else if !model.needsYou.isEmpty {
				Image(systemName: "exclamationmark.triangle.fill")
				Text("\(model.needsYou.count)")
			} else if !model.working.isEmpty {
				Image(systemName: "building.columns.fill")
				Text("\(model.working.count)")
			} else {
				Image(systemName: "building.columns")
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
