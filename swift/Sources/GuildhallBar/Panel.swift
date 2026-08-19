import SwiftUI

/// The dropdown: what every session is doing, and the controls for the service.
struct Panel: View {
	@ObservedObject var model: Model

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
				.frame(maxHeight: 320)
			}
			Divider()
			controls
		}
		.frame(width: 320)
		.onAppear { model.start(open: true) }
		.onDisappear { model.start(open: false) }
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
		VStack(spacing: 0) {
			Button(model.daemon == .stopped ? "Start the service" : "Stop the service") {
				model.act { model.daemon == .stopped ? Daemon.start() : Daemon.stop() }
			}
			.disabled(model.daemon == .notInstalled)
			Button("Restart the service") { model.act { Daemon.restart() } }
				.disabled(model.daemon == .notInstalled || model.daemon == .stopped)
			Button("Open the browser view") { model.openBrowser() }
				.disabled(!model.reachable)
			Divider().padding(.vertical, 4)
			Button("Quit") { NSApplication.shared.terminate(nil) }
		}
		.buttonStyle(.plain)
		.padding(.horizontal, 12).padding(.vertical, 8)
		.frame(maxWidth: .infinity, alignment: .leading)
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
