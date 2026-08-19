import SwiftUI

/// The dropdown: what every session is doing, and the controls for the service.
struct Panel: View {
	@ObservedObject var model: Model
	@State private var showSettings = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			header
			Divider()
			if !model.reachable {
				unreachable
			} else if model.sessions.isEmpty {
				Text("No sessions").foregroundStyle(.secondary).padding(12)
			} else {
				ScrollView {
					VStack(alignment: .leading, spacing: 0) {
						// Sorted the way the room sorts: whoever is waiting on you first,
						// then whoever is working, then everyone else. A list in registry
						// order buries the one row that needed a person.
						ForEach(model.sessions.sorted(by: rank)) { Row(session: $0) }
					}
				}
				// A minimum, not just a maximum. `maxHeight` alone let it collapse to
				// nothing: a ScrollView has no intrinsic content height, so inside a menu
				// bar window that sizes itself to its content the list rendered at zero
				// and the panel showed a header and some buttons with the sessions
				// missing entirely — while the app was holding all ten of them.
				.frame(minHeight: 120, maxHeight: 320)
			}
			Divider()
			controls
		}
		.frame(width: 320)
		.onAppear { model.start(open: true) }
		.onDisappear { model.start(open: false) }
		// A sheet rather than a separate window: the settings belong to this panel and
		// should not outlive it or turn up in the window list of an app that has no
		// windows.
		.sheet(isPresented: $showSettings) { SettingsView(model: model) }
	}

	private func rank(_ a: Session, _ b: Session) -> Bool {
		if a.needsYou != b.needsYou { return a.needsYou }
		if a.working != b.working { return a.working }
		return a.stale < b.stale
	}

	private var header: some View {
		HStack {
			Text("guildhall").font(.headline)
			Spacer()
			Text(summary).font(.caption).foregroundStyle(.secondary)
		}
		.padding(.horizontal, 12).padding(.vertical, 8)
	}

	private var summary: String {
		if !model.reachable { return "not running" }
		let needs = model.needsYou.count
		let working = model.working.count
		if needs > 0 { return "\(needs) need you · \(working) working" }
		return working > 0 ? "\(working) working" : "all idle"
	}

	/// Shown instead of an empty list, because "no sessions" and "cannot reach the
	/// server" look identical otherwise and have completely different fixes.
	private var unreachable: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("Can't reach guildhall").font(.callout)
			Text(hint).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
		}
		.padding(12)
	}

	private var hint: String {
		switch model.daemon {
		case .notInstalled:
			return "The service isn't installed. Copy contrib/dev.guildhall.headless.plist into ~/Library/LaunchAgents and load it."
		case .stopped:
			return "The service is installed but not running. Start it below."
		default:
			return "The service is loaded but nothing is answering — usually something else is holding the port. Check /tmp/guildhall-headless.log."
		}
	}

	private var controls: some View {
		// Each row full width and left aligned. `.frame(alignment: .leading)` on the
		// stack does not do that — a Button centres its own label inside whatever
		// width it is given, which is why these came out centred down the middle
		// looking like a dialog rather than a menu.
		VStack(alignment: .leading, spacing: 2) {
			item(model.daemon == .stopped ? "Start the service" : "Stop the service", enabled: model.daemon != .notInstalled) {
				model.act { model.daemon == .stopped ? Daemon.start() : Daemon.stop() }
			}
			item("Restart the service", enabled: model.daemon != .notInstalled && model.daemon != .stopped) {
				model.act { Daemon.restart() }
			}
			item("Open the browser view", enabled: model.reachable) { model.openBrowser() }
			item("Settings…") { showSettings = true }
			Divider().padding(.vertical, 4)
			item("Quit") { NSApplication.shared.terminate(nil) }
		}
		.padding(.horizontal, 8).padding(.vertical, 6)
	}

	private func item(_ title: String, enabled: Bool = true, _ action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, 4).padding(.vertical, 3)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.disabled(!enabled)
		.opacity(enabled ? 1 : 0.4)
	}
}

/// One session: the project, what it is doing, and how long since it last did it.
private struct Row: View {
	let session: Session

	var body: some View {
		HStack(alignment: .top, spacing: 8) {
			Circle().fill(color).frame(width: 7, height: 7).padding(.top, 5)
			VStack(alignment: .leading, spacing: 1) {
				HStack(spacing: 6) {
					Text(session.label).font(.system(size: 12, weight: .medium))
					Spacer()
					Text(ago).font(.system(size: 10)).foregroundStyle(.secondary)
				}
				// `doing` is the current tool where there is one, and the last thing said
				// otherwise — which is the sentence a person actually wants.
				if let doing = session.doing ?? session.title, !doing.isEmpty {
					Text(doing).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
				}
			}
		}
		.padding(.horizontal, 12).padding(.vertical, 5)
	}

	/// The room's own colours, so the two views agree about what a state looks like.
	private var color: Color {
		switch session.state {
		case "needs": return .orange
		case "working": return .green
		case "shell": return .teal
		case "review": return .blue
		case "error": return .red
		default: return .gray
		}
	}

	private var ago: String {
		let m = Int((session.stale / 60000).rounded())
		if m < 1 { return "now" }
		if m < 60 { return "\(m)m" }
		let h = Int((Double(m) / 60).rounded())
		return h < 48 ? "\(h)h" : "\(Int((Double(h) / 24).rounded()))d"
	}
}
