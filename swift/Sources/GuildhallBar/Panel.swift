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
	/// Why the last click on a row did nothing. Observed, not read once — the refusal
	/// arrives after the click, from a background queue.
	@ObservedObject private var cmux = Cmux.Status.shared
	@State private var showSettings = false
	@State private var collapsed: Set<String> = []
	/// Other guildhalls serving, refreshed each time the panel appears. A readdir plus a
	/// kill(0) per entry, so checking is free; see src/servers.ts for why it is a registry.
	@State private var otherServers: [(pid: Int32, port: Int)] = []

	var body: some View {
		// Settings are a PAGE, not a sheet.
		//
		// As a sheet it took several clicks to appear — a popover is not a real window
		// and sheets over one are unreliable — and worse, dismissing it did not clear
		// this flag, so the next time the icon was clicked the popover came back
		// straight into settings and had to be dismissed again to reach the list.
		//
		// Swapping the content keeps one window, one piece of state, and no
		// presentation machinery that can disagree with it.
		Group {
			if showSettings {
				SettingsView(model: model, done: { showSettings = false })
			} else {
				list
			}
		}
		// Width only. A fixed height was tried while chasing the lag and reverted: it
		// leaves a tall empty panel when few sessions are running, and the lag was
		// never layout — see the note in MISTAKES.md.
		.frame(width: 380)
		.onAppear {
			model.start(open: true)
			// NOTHING ELSE HERE, deliberately.
			//
			// This called `NSApplication.shared.activate(ignoringOtherApps: true)` to fix
			// the first click being spent activating an accessory app. It is deprecated,
			// and on macOS 14+ cooperative activation makes `ignoringOtherApps` advisory
			// — the system decides — so it asks the window server to deactivate whatever
			// is frontmost at the exact moment the popover is trying to appear. The
			// report immediately after adding it was that opening the menu took seconds.
			//
			// A popover that opens instantly and costs one extra click is a better trade
			// than one that swallows the click by taking three seconds to arrive.
		}
		// A separate modifier, NOT added to the onAppear above — that block carries its own
		// warning about staying empty, and the reason is real. This is a readdir plus a
		// kill(0) per entry: no window server, no activation, nothing that can delay the
		// popover appearing.
		.task { otherServers = Config.otherServers(configuredPort: Config.load().port) }
		.onDisappear {
			model.start(open: false)
			// Back to the list when the popover closes. SwiftUI keeps this view alive
			// between openings, so without it the panel reopened on whatever page it was
			// left on — which is how closing settings and clicking the icon landed
			// straight back in settings.
			showSettings = false
		}
	}

	private var list: some View {
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
			// Why the last click did not open a tab.
			//
			// Clicking a row was silent for two releases: cmux refuses control from a
			// process it did not start, this app is started by launchd, and the refusal
			// went to /dev/null. Whatever the reason, it is said here now.
			if let note = cmux.note {
				Divider()
				HStack(alignment: .top, spacing: 6) {
					Image(systemName: "exclamationmark.triangle.fill")
						.font(.system(size: 10)).foregroundStyle(.orange)
					Text(note).font(.system(size: 10)).foregroundStyle(.secondary)
						.fixedSize(horizontal: false, vertical: true)
				}
				.padding(.horizontal, 10).padding(.vertical, 6)
			}
			if let u = model.usage, !u.limits.isEmpty || u.cost != nil {
				Divider()
				quota(u)
			}
			Divider()
			controls
		}
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
			return "The service is loaded but nothing is answering — usually something else is holding the port. Check ~/Library/Logs/guildhall-headless.log."
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
						// Same again: a known width, measured anyway.
						ZStack(alignment: .leading) {
							Capsule().fill(Color.secondary.opacity(0.22)).frame(width: 330)
							Capsule()
								.fill(percent > 85 ? Color.red : percent > 60 ? Color.orange : Color.green)
								.frame(width: 330 * min(1, percent / 100))
						}
						.frame(height: 4)
					}
				}
			}
			// Said plainly rather than hidden: a stale quota shown as if it were current
			// is the one failure this must not have, and that tool's note is that an
			// error payload must never blank the numbers.
			if let why = u.error {
				Text("quota may be stale — \(why)").font(.system(size: 10)).foregroundStyle(.orange)
			}
		}
		.padding(.horizontal, 12).padding(.vertical, 8)
	}

	private var controls: some View {
		VStack(alignment: .leading, spacing: 2) {
			// A second guildhall serving, here on the main panel and not only behind the
			// gear. It was in Settings first and the report was "why does the taskbar not
			// show this anywhere" — which is right: a server you have forgotten is exactly
			// the thing you will not go looking for. This is the surface that gets opened.
			//
			// Read from the registry directory, which is a readdir and a kill(0) per entry,
			// so it costs nothing to check each time the panel appears. See src/servers.ts.
			do {
				// Only servers on OTHER ports are reported here.
				//
				// One on the configured port is a handover, not a fault: something is serving
				// the browser view and it works. service.ts settled that already — "a port
				// held by another guildhall is not a conflict and must not be reported as
				// one" — and this row broke the rule, alarming about the only server that was
				// actually working. Settings states that case quietly instead.
				let elsewhere = otherServers.filter { $0.port != Config.load().port }
				if !elsewhere.isEmpty {
					let which = elsewhere.map { ":\($0.port)" }.joined(separator: ", ")
					HStack(spacing: 6) {
						Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
						Text("Another guildhall is also serving on \(which) — Settings can kill it")
							.font(.system(size: 11))
							.fixedSize(horizontal: false, vertical: true)
					}
					.foregroundStyle(.orange)
					.padding(.horizontal, 12).padding(.vertical, 4)
				}
			}
			MenuItem(title: model.daemon == .stopped ? "Start the service" : "Stop the service", enabled: model.daemon != .notInstalled) {
				let starting = model.daemon == .stopped
				model.act { starting ? await Daemon.start() : await Daemon.stop() }
			}
			MenuItem(title: "Restart the service", enabled: model.daemon != .notInstalled && model.daemon != .stopped) {
				model.act { await Daemon.restart() }
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
						// Which harness, for EVERY row.
						//
						// This was a badge on Codex rows only, so Claude Code was identified by
						// absence — which is not a mark anybody can read beside a row that simply
						// has nothing to say. Two Claude sessions and a Codex session in one
						// project was the case that showed it.
						//
						// A symbol rather than either vendor's logo: those are somebody else's
						// trademark, and a shipped app embedding them is a different decision from
						// a one-glyph marker. Coral and teal are the colours the room paints that
						// desk's mug, so the two halves of the app say it the same way.
						Image(systemName: session.agent == "codex" ? "diamond.fill" : "asterisk")
							.font(.system(size: 9, weight: .bold))
							.foregroundStyle(session.agent == "codex"
								? Color(red: 110 / 255, green: 186 / 255, blue: 196 / 255)
								: Color(red: 226 / 255, green: 118 / 255, blue: 96 / 255))
							.help(session.agent == "codex" ? "Codex" : "Claude Code")
						if let level = session.level { Badge(text: "lv\(level)", tint: .purple) }
						if let kind = session.toolKind, session.working { Badge(text: kind, tint: .green) }
						Spacer(minLength: 0)
						Text(ago).font(.system(size: 10)).foregroundStyle(.secondary)
					}
					// TRUNCATED BEFORE Text, not by it.
					//
					// `lineLimit(1)` limits what is DRAWN; SwiftUI still lays out the whole
					// string to work out where to cut. These are transcript excerpts — the
					// live payload has one at 2,577 characters and another at 970 — so ten
					// rows of that is a lot of text measurement on every render, on the main
					// thread, and the heartbeat caught it as a 1,042ms stall.
					//
					// A 380pt row shows about 60 characters. 90 is generous and bounded.
					Text(oneLine)
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
			// A fixed width needs no GeometryReader. It was measuring a 44pt bar it
			// already knew the size of, once per row, and a GeometryReader inside a
			// ScrollView forces extra layout passes for the whole scroll content.
			ZStack(alignment: .leading) {
				Capsule().fill(Color.secondary.opacity(0.25)).frame(width: 44)
				Capsule().fill(fraction > 0.85 ? Color.red : fraction > 0.6 ? Color.orange : Color.green)
					.frame(width: 44 * fraction)
			}
			.frame(height: 4)
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

	/// The row's second line, cut to something a row can actually show.
	private var oneLine: String {
		let raw = session.doing?.isEmpty == false ? session.doing! : (session.title ?? state)
		guard raw.count > 90 else { return raw }
		return raw.prefix(90) + "…"
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
