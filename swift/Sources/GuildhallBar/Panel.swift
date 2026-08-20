import SwiftUI

/// The dropdown: what every session is doing, grouped by project.
///
/// Shaped after so-agentbar, which does this well — grouped rows, a status face,
/// badges for the things you want without reading a sentence, and a number that
/// tells you how much room is left. Two of its numbers are not ours to show:
/// per-session cost and the plan quota come from Claude's own billing, which
/// guildhall never reads. Context fullness is the equivalent here and arguably the
/// more useful one, because it is the number that decides whether a session is
/// about to compact and lose the thread.
struct Panel: View {
	@ObservedObject var model: Model
	@State private var showSettings = false
	@State private var collapsed: Set<String> = []

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
					VStack(alignment: .leading, spacing: 2) {
						ForEach(groups, id: \.name) { group in
							GroupHeader(
								name: group.name,
								count: group.sessions.count,
								open: !collapsed.contains(group.name)
							) {
								if collapsed.contains(group.name) { collapsed.remove(group.name) } else { collapsed.insert(group.name) }
							}
							if !collapsed.contains(group.name) {
								ForEach(group.sessions) { Row(session: $0) }
							}
						}
					}
					.padding(.vertical, 4)
				}
				// A minimum, not just a maximum. `maxHeight` alone let it collapse to
				// nothing: a ScrollView has no intrinsic content height, so inside a menu
				// bar window that sizes itself to its content the list rendered at zero
				// and the panel showed a header and some buttons with the sessions
				// missing entirely — while the app was holding all ten of them.
				.frame(minHeight: 140, maxHeight: 360)
			}
			if let u = model.usage, !u.limits.isEmpty || u.cost != nil {
				Divider()
				quota(u)
			}
			Divider()
			controls
		}
		.frame(width: 360)
		// Instrumentation, temporary: whether the popover gets mouse events at all.
		// "Nothing responds" and "the handler is wrong" need completely different
		// fixes, and hover is the cheapest way to tell them apart.
		.onHover { inside in model.note("panel hover \(inside ? "in" : "out")") }
		.onAppear { model.start(open: true) }
		.onDisappear { model.start(open: false) }
		// A sheet rather than a separate window: the settings belong to this panel and
		// should not outlive it or turn up in the window list of an app that has no
		// windows.
		.sheet(isPresented: $showSettings) { SettingsView(model: model) }
	}

	/// Sessions by project, each group sorted the way the room sorts.
	///
	/// Projects that need something come first, so a group you must act on is never
	/// below one you can ignore.
	private var groups: [(name: String, sessions: [Session])] {
		let byProject = Dictionary(grouping: model.sessions) { $0.label }
		return byProject
			.map { (name: $0.key, sessions: $0.value.sorted(by: rank)) }
			.sorted { a, b in
				let an = a.sessions.contains(where: \.needsYou), bn = b.sessions.contains(where: \.needsYou)
				if an != bn { return an }
				let aw = a.sessions.contains(where: \.working), bw = b.sessions.contains(where: \.working)
				if aw != bw { return aw }
				// Then most recently active first. This fell back to the project NAME,
				// which is why the list looked arbitrary: alphabetical order has nothing
				// to do with what you were last working on, and a project you touched
				// two minutes ago could sit below one untouched for a week.
				return (a.sessions.map(\.stale).min() ?? .infinity) < (b.sessions.map(\.stale).min() ?? .infinity)
			}
	}

	private func rank(_ a: Session, _ b: Session) -> Bool {
		if a.needsYou != b.needsYou { return a.needsYou }
		if a.working != b.working { return a.working }
		return a.stale < b.stale
	}

	private var header: some View {
		HStack(spacing: 8) {
			Image(systemName: "building.columns.fill").foregroundStyle(.secondary)
			Text("guildhall").font(.headline)
			Spacer()
			Text(summary).font(.caption).foregroundStyle(.secondary)
			Button { Task { await model.refresh() } } label: {
				Image(systemName: "arrow.clockwise").font(.system(size: 11))
			}
			.buttonStyle(.plain).help("Refresh now")
			Button { showSettings = true } label: {
				Image(systemName: "gearshape").font(.system(size: 12))
			}
			.buttonStyle(.plain).help("Settings")
		}
		.padding(.horizontal, 12).padding(.vertical, 8)
	}

	private var summary: String {
		if !model.reachable { return "not running" }
		let needs = model.needsYou.count, working = model.working.count
		if needs > 0 { return "\(needs) need you · \(working) active" }
		return working > 0 ? "\(working) active" : "all idle"
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

	/// The plan, and what today has cost.
	///
	/// Both come from outside guildhall — the quota from Anthropic's OAuth usage
	/// endpoint, the spend from ccusage — and the server caches them, so this view
	/// is only ever reading numbers that are already on this machine.
	private func quota(_ u: Usage) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack {
				Text("Plan").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
				Spacer()
				if let cost = u.cost {
					Text("today $\(cost, specifier: "%.2f")").font(.system(size: 11)).foregroundStyle(.secondary)
				}
			}
			ForEach(u.limits) { limit in
				if let percent = limit.percent {
					VStack(alignment: .leading, spacing: 2) {
						HStack(spacing: 4) {
							Text(limit.title).font(.system(size: 11))
							Spacer()
							Text("\(Int(percent))% used")
								.font(.system(size: 11))
								.foregroundStyle(percent > 85 ? .red : percent > 60 ? .orange : .green)
							if let resets = limit.resets {
								Text("· \(resets)").font(.system(size: 10)).foregroundStyle(.secondary)
							}
						}
						GeometryReader { geo in
							ZStack(alignment: .leading) {
								Capsule().fill(Color.secondary.opacity(0.22))
								Capsule()
									.fill(percent > 85 ? Color.red : percent > 60 ? Color.orange : Color.green)
									.frame(width: geo.size.width * min(1, percent / 100))
							}
						}
						.frame(height: 4)
					}
				}
			}
			// Said plainly rather than hidden: a stale quota shown as if it were current
			// is the one failure this must not have, and the note there is that an
			// error payload must never blank the numbers.
			if let why = u.error {
				Text("quota may be stale — \(why)").font(.system(size: 10)).foregroundStyle(.orange)
			}
		}
		.padding(.horizontal, 12).padding(.vertical, 8)
	}

	private var controls: some View {
		VStack(alignment: .leading, spacing: 2) {
			MenuItem(title: model.daemon == .stopped ? "Start the service" : "Stop the service", enabled: model.daemon != .notInstalled) {
				model.act { model.daemon == .stopped ? Daemon.start() : Daemon.stop() }
			}
			MenuItem(title: "Restart the service", enabled: model.daemon != .notInstalled && model.daemon != .stopped) {
				model.act { Daemon.restart() }
			}
			MenuItem(title: "Open the browser view", enabled: model.reachable) { model.openBrowser() }
			Divider().padding(.vertical, 4)
			HStack {
				Text(model.reachable ? "Watching \(model.sessions.count) sessions" : "Not watching")
					.font(.caption).foregroundStyle(.secondary)
				Spacer()
				Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain)
			}
			.padding(.horizontal, 6).padding(.vertical, 2)
		}
		.padding(.horizontal, 8).padding(.vertical, 6)
	}
}

/// A project heading you can fold away.
private struct GroupHeader: View {
	let name: String
	let count: Int
	let open: Bool
	let toggle: () -> Void
	@State private var hovering = false

	var body: some View {
		Button(action: toggle) {
			HStack(spacing: 6) {
				Image(systemName: open ? "chevron.down" : "chevron.right")
					.font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
				Image(systemName: "folder.fill").font(.system(size: 10)).foregroundStyle(.secondary)
				Text(name).font(.system(size: 12, weight: .semibold))
				Text("(\(count))").font(.system(size: 11)).foregroundStyle(.secondary)
				Spacer()
			}
			.padding(.horizontal, 8).padding(.vertical, 4)
			.contentShape(Rectangle())
			.background(RoundedRectangle(cornerRadius: 4).fill(hovering ? Color.accentColor.opacity(0.18) : .clear))
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
	}
}

/// One session: what it is, what it is doing, and how much room it has left.
private struct Row: View {
	let session: Session
	@State private var hovering = false

	var body: some View {
		Button {
			// Clicking a row brings its terminal to the front. The workspace UUID comes
			// from the payload, so this needs no position lookup — unlike the room's own
			// jump, which maps a tab NUMBER through `workspace list` and is therefore
			// wrong the moment the order changes.
			if let ws = session.workspace { Cmux.focus(workspace: ws) }
		} label: {
			HStack(alignment: .top, spacing: 8) {
				Text(face).font(.system(size: 15)).frame(width: 20)
				VStack(alignment: .leading, spacing: 2) {
					HStack(spacing: 5) {
						Text(session.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
						if session.unread == true { Circle().fill(.blue).frame(width: 5, height: 5) }
						if let level = session.level { Badge(text: "lv\(level)", tint: .purple) }
						if let kind = session.toolKind, session.working { Badge(text: kind, tint: .green) }
						Spacer(minLength: 0)
						Text(ago).font(.system(size: 10)).foregroundStyle(.secondary)
					}
					Text(session.doing?.isEmpty == false ? session.doing! : (session.title ?? state))
						.font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
					HStack(spacing: 6) {
						Text(state).font(.system(size: 10)).foregroundStyle(color)
						if let agents = session.agents, !agents.isEmpty {
							Text("· \(agents)").font(.system(size: 10)).foregroundStyle(.secondary)
						}
						if let tab = session.tab {
							Text("· tab \(tab)").font(.system(size: 10)).foregroundStyle(.secondary)
						}
						Spacer(minLength: 0)
						if let ctx = session.context { context(ctx) }
					}
				}
			}
			.padding(.horizontal, 10).padding(.vertical, 5)
			.contentShape(Rectangle())
			.background(RoundedRectangle(cornerRadius: 4).fill(hovering ? Color.accentColor.opacity(0.14) : .clear))
		}
		.buttonStyle(.plain)
		.onHover { hovering = $0 }
		.help(session.workspace == nil ? session.name : "Click to bring this session's tab to the front")
	}

	/// The context bar: how full the window is, and red once compaction is close.
	private func context(_ fraction: Double) -> some View {
		HStack(spacing: 4) {
			GeometryReader { geo in
				ZStack(alignment: .leading) {
					Capsule().fill(Color.secondary.opacity(0.25))
					Capsule().fill(fraction > 0.85 ? Color.red : fraction > 0.6 ? Color.orange : Color.green)
						.frame(width: geo.size.width * fraction)
				}
			}
			.frame(width: 44, height: 4)
			Text("\(Int(fraction * 100))%").font(.system(size: 10)).foregroundStyle(.secondary)
		}
	}

	/// A face per state, which is readable before any of the words are.
	private var face: String {
		switch session.state {
		case "needs": return "🙋"
		case "working": return "⚡"
		case "shell": return "⚙️"
		case "review": return "📩"
		case "error": return "⚠️"
		case "done": return "✅"
		default: return "😴"
		}
	}

	private var state: String {
		switch session.state {
		case "needs": return "needs you"
		case "shell": return "running a command"
		case "review": return "finished, unread"
		case "done": return "your turn"
		case "parked": return "idle"
		default: return session.state
		}
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

/// A small pill. Deliberately dull: the badges are for scanning, and a row with
/// four loud colours in it is slower to read than one with none.
private struct Badge: View {
	let text: String
	let tint: Color
	var body: some View {
		Text(text)
			.font(.system(size: 9, weight: .medium))
			.padding(.horizontal, 4).padding(.vertical, 1)
			.background(RoundedRectangle(cornerRadius: 3).fill(tint.opacity(0.2)))
			.foregroundStyle(tint)
	}
}

/// A row that behaves like a menu item.
///
/// `.buttonStyle(.plain)` is needed to stop SwiftUI drawing a bordered button in
/// a popover, but it also removes every trace of hover and press — so a working
/// row is indistinguishable from a dead one, which is how this panel came to be
/// described as "only visual". The highlight is the whole difference between a
/// list of words and something that looks like it can be used.
struct MenuItem: View {
	let title: String
	var enabled: Bool = true
	let action: () -> Void
	@State private var hovering = false

	var body: some View {
		Button(action: action) {
			Text(title)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, 6).padding(.vertical, 4)
				// The shape is what gets hit. Without it only the glyphs of the text are
				// clickable and the gaps between words are not, which feels broken even
				// when every click that lands does the right thing.
				.contentShape(Rectangle())
				.background(
					RoundedRectangle(cornerRadius: 4)
						.fill(hovering && enabled ? Color.accentColor.opacity(0.25) : .clear)
				)
		}
		.buttonStyle(.plain)
		.disabled(!enabled)
		.opacity(enabled ? 1 : 0.4)
		.onHover { hovering = $0 }
	}
}
