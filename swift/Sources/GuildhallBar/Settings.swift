import SwiftUI

/// Everything the terminal's help panel can change, changeable here.
///
/// Including the control password. The first version of this refused to offer it
/// and told the person to open a terminal and press a key — which is not an answer
/// a control panel gets to give. The objection was real but it was about the
/// wrong thing: the credential must have ONE implementation of being stored, not
/// one place it can be typed. So the field is here and the hashing is not; the
/// password goes to `guildhall --set-control-password` on stdin and that does
/// what it has always done.
///
/// Every change writes the config file and then restarts the service, because
/// the port and the passcode are read at startup — a setting that is saved but
/// not in effect is worse than one that is obviously not saved.
/// A settings row: what it is on the left, the switch on the right.
///
/// Extracted because there were three toggles in three shapes — one right-aligned
/// with a caption, two hugging their own labels — which looks like three different
/// people wrote them. `.toggleStyle(.switch)` lives here once, and it is the whole
/// difference between a switch and a CHECKBOX: a bare `Toggle` on macOS renders as
/// a checkbox, which reads like a form field rather than a thing that is on or off.
private struct SwitchRow: View {
	let title: String
	let caption: String?
	/// Draw the caption as a problem rather than as an explanation.
	var captionIsError = false
	/// Something is happening that takes seconds. Starting the service means waiting
	/// for node to launch and bind, which is about seven — without a spinner and a
	/// disabled switch, that reads as a dead control.
	var busy = false
	/// The switch's own color when on.
	///
	/// Colour that MEANS something rather than decoration: green matches the menu bar
	/// icon's own language for "working", and the control switch is orange because it
	/// hands somebody the ability to type into every session — the one setting here
	/// with a consequence worth hesitating over. Everything else keeps the system
	/// accent, so the two that are tinted stand out.
	var tint: Color = .accentColor
	@Binding var isOn: Bool

	var body: some View {
		HStack(alignment: .center, spacing: 12) {
			VStack(alignment: .leading, spacing: 2) {
				Text(title).font(.system(size: 13, weight: .medium))
				if let caption {
					Text(caption)
						.font(.caption)
						.foregroundStyle(captionIsError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
						.fixedSize(horizontal: false, vertical: true)
				}
			}
			Spacer(minLength: 0)
			if busy {
				ProgressView().controlSize(.small)
			}
			Toggle("", isOn: $isOn).toggleStyle(.switch).labelsHidden().disabled(busy).tint(tint)
		}
	}
}

struct SettingsView: View {
	@ObservedObject var model: Model
	/// Called to go back to the list. A closure rather than `@Environment(\.dismiss)`,
	/// which does nothing useful here: this is not presented, it is the content.
	let done: () -> Void

	@State private var config = Config.load()
	@State private var passcode = Config.passcode()
	@State private var note = ""
	@State private var failed = false
	@State private var controlPassword = ""
	@State private var controlSet = Config.controlPasswordIsSet()
	/// Whether the browser view is being served, read from launchd rather than from
	/// the config file. `--headless` forces `serve` true for its own run, so the file
	/// cannot answer this question — the only truthful answer is whether the service
	/// is loaded.
	@State private var serving = false
	/// Reported next to the switch that caused it, not at the far end of the page.
	/// The shared note lives below the control password, so a failure from the top
	/// row appeared inches away from the thing that failed.
	@State private var serveNote = ""
	@State private var serveFailed = false
	@State private var serveBusy = false
	/// While `--pick-port` is running, so the button cannot be pressed twice and the
	/// wait is visible — shelling out to node is not instant.
	@State private var picking = false
	/// Why control cannot work, from the serving process itself. See Config.cmuxBlockedNote.
	@State private var cmuxNote: String?
	/// Other guildhalls serving, so a forgotten one is visible. Refreshed when the page
	/// appears; a registry read is cheap but there is no reason to do it per keystroke.
	@State private var alsoServing: [(pid: Int32, port: Int)] = []
	/// What guildhall said about the last stop, shown where the button is
	@State private var stopNote = ""
	@State private var stopping: Int32?
	/// What is on disk, so the page can tell a typed change from no change at all.
	/// Apply used to be enabled always, which offers to save when there is nothing to
	/// save — and gives no signal at the moment there is.
	@State private var savedPort = Config.load().port
	@State private var savedPasscode = Config.passcode()

	/// Only the typed fields need applying. Switches and the picker take effect as
	/// they are used, so they are never "unsaved".
	private var portChanged: Bool { config.port != savedPort }
	private var passcodeChanged: Bool { passcode != savedPasscode }
	private var dirty: Bool { portChanged || passcodeChanged }

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			HStack {
				Button(action: done) {
					HStack(spacing: 3) {
						Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
						Text("Back")
					}
				}
				.buttonStyle(.plain)
				Spacer()
				Text("Settings").font(.headline)
			}

			// The browser view, off unless asked for.
			//
			// This is the setting that was missing, and its absence was the bug: there was
			// no way to say no, so `install:mac` said yes for you and the machine started
			// answering on every interface. The menu bar app needs none of it — it reads
			// the room by running `guildhall --sessions`.
			//
			// Bound to launchd, not to the config file. `--headless` sets `serve` true for
			// its own process whatever the file says, so "is it serving" is only ever
			// answerable by asking whether the service is loaded.
			// One toggle, always. No "go and run a script in the terminal".
			//
			// The first version of this only offered a toggle when the LaunchAgent already
			// existed, and printed an install command otherwise — which, now that
			// install:mac deliberately does not create that agent, is what a fresh machine
			// would always see. A control panel does not get to answer that way; it is the
			// same objection this file already records about the control password, and the
			// same answer: the panel has the switch, and one implementation does the work.
			//
			// `guildhall --set-serve` writes the LaunchAgent, loads it, and updates the
			// config — so the plist has one definition rather than a second one in Swift.
			SwitchRow(
				title: "Serve the browser view",
				caption: serveBusy
					? (serving ? "Starting it — node has to launch and bind the port." : "Stopping it.")
					: !serveNote.isEmpty
						? serveNote
						: serving
							? "A browser can reach this machine. The settings below apply to it."
							: "Off. Nothing is served — the menu bar icon works either way.",
				captionIsError: serveFailed,
				busy: serveBusy,
				tint: .green,
				isOn: Binding(
					get: { serving },
					set: { want in
						serving = want
						Task { await setServing(want) }
					}
				)
			)

			// A second guildhall serving, named.
			//
			// Two were running here for half an hour — the launchd service and a
			// `tools/serve.mjs --port 4319` dev watcher — on different ports, so nothing
			// ever collided and nothing said a word. Both were bound to every interface,
			// both reachable over the tailnet, and the only way to find out was lsof.
			// "I have no indication of that and how would I know" is why this row exists.
			if !alsoServing.isEmpty {
				VStack(alignment: .leading, spacing: 6) {
					/**
					 * A guildhall on the CONFIGURED port is a handover, not a fault.
					 *
					 * service.ts already settled this and I broke the rule in a new place:
					 * "A port held by ANOTHER GUILDHALL is not a conflict and must not be
					 * reported as one… The first version refused here and told the person to
					 * quit their own room. That is not an answer."
					 *
					 * This panel did precisely that. It showed one entry — the server that
					 * was actually serving, on the port the person had chosen — under the
					 * heading "another guildhall" with a Kill it button beside it. The only
					 * working server on the machine, offered up for killing, because it was
					 * not the one launchd started.
					 *
					 * So the port being served by something else is stated, not warned about.
					 * What IS worth flagging is the consequence nobody can see: the service
					 * cannot bind, and launchd retries it every ten seconds forever. The
					 * remedy for that is to stop the SERVICE — the redundant half — which is
					 * a button the main panel already has.
					 *
					 * Servers on other ports are a different thing and keep the warning:
					 * those are genuinely two doors and twice the cost.
					 */
					let handover = alsoServing.first { $0.port == config.port }
					let elsewhere = alsoServing.filter { $0.port != config.port }
					if let h = handover {
						Label(
							"Port \(String(config.port)) is being served by another guildhall (pid \(String(h.pid))), not by this service — the browser view works. The service cannot bind, so launchd keeps restarting it; stop the service if you do not need it.",
							systemImage: "info.circle"
						)
						.font(.caption).foregroundStyle(.secondary)
						.fixedSize(horizontal: false, vertical: true)
					}
					if !elsewhere.isEmpty {
						Label(
							"Another guildhall is also serving on a different port. Each costs about 1% of a core, both are reachable on your network, and they can be running different builds.",
							systemImage: "exclamationmark.triangle.fill"
						)
						.font(.caption).foregroundStyle(.orange)
						.fixedSize(horizontal: false, vertical: true)
					}
					// A button per server, because naming the problem and leaving you to
					// find `kill` is only half an answer — the same objection this file
					// already records about the control password and the serve toggle.
					ForEach(alsoServing, id: \.pid) { s in
						HStack(spacing: 8) {
							Text("port \(String(s.port)) · pid \(String(s.pid))")
								.font(.caption).foregroundStyle(.secondary)
							Spacer()
							if stopping == s.pid {
								ProgressView().controlSize(.small)
							} else {
								Button("Kill it") {
									stopping = s.pid
									Task {
										stopNote = await Config.stopServer(s.pid)
										// Give it a moment to withdraw its registry entry, then
										// re-read: the list has to reflect what happened, or the
										// button looks like it did nothing.
										try? await Task.sleep(for: .milliseconds(600))
										alsoServing = Config.otherServers(configuredPort: config.port)
										stopping = nil
									}
								}
								.controlSize(.small)
							}
						}
					}
					if !stopNote.isEmpty {
						// guildhall's own words: it says which process it actually signalled,
						// which matters because a dev-watcher child is restarted by its parent
						// and the thing that had to stop was the parent.
						Text(stopNote).font(.caption).foregroundStyle(.secondary)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
			}

			Divider()

			// Two columns, not three.
			//
			// A third column of hints beside 80pt fields inside a 380pt popover left every
			// one of them wrapping onto two lines, and clipped the "Reachable on" label
			// outright. The hints say more, in one line underneath, where there is room for
			// them — and the unsaved warning NAMES the field rather than pointing at it.
			Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
				GridRow {
					Text("Port")
					HStack(spacing: 6) {
						TextField("4319", value: $config.port, format: .number.grouping(.never))
							.frame(width: 90)
						// Because the default collided: 4318 is the OTLP/HTTP port, so any
						// machine running a trace collector already had it, and the panel's
						// only advice was "Choose another port" with no way to choose one.
						//
						// The number comes from `guildhall --pick-port`, not from Swift. Which
						// ports are safe is a real decision — see src/port.ts on why anything
						// above 32768 is wrong on macOS — and a second implementation here
						// would be a second chance to get it wrong.
						Button {
							picking = true
							Task {
								if let p = await Config.freePort() { config.port = p }
								picking = false
							}
						} label: {
							if picking { ProgressView().controlSize(.small) } else { Text("Random") }
						}
						.disabled(picking)
						.help("Pick a port nothing is listening on")
					}
				}
				GridRow {
					Text("Passcode")
					TextField("8317", text: $passcode)
						.frame(width: 90)
				}
				GridRow {
					Text("Reachable on")
					// Immediate, like the switches: a discrete choice has no half-typed state
					// to commit, so making it wait for Apply only created a way to forget.
					Picker("", selection: Binding(
						get: { config.host },
						set: { config.host = $0; saveNow() }
					)) {
						Text("this machine only").tag("127.0.0.1")
						Text("the network").tag("0.0.0.0")
					}
					.labelsHidden().frame(width: 180)
				}
			}

			if dirty {
				Label(
					portChanged && passcodeChanged
						? "Port and passcode not saved yet."
						: portChanged ? "Port not saved yet." : "Passcode not saved yet.",
					systemImage: "exclamationmark.circle.fill"
				)
				.font(.caption).foregroundStyle(.orange)
			} else if config.host == "0.0.0.0" {
				Label("Anything on your network or tailnet can reach it, with the passcode.", systemImage: "wifi")
					.font(.caption).foregroundStyle(.orange)
					.fixedSize(horizontal: false, vertical: true)
			} else {
				Text("Loopback only. A new port restarts the service; a new passcode signs every device out.")
					.font(.caption).foregroundStyle(.secondary)
					.fixedSize(horizontal: false, vertical: true)
			}

			Divider()

			// Immediate, like the switch above. These used to need the Apply button while
			// the top switch did not, which is a panel where identical-looking controls
			// behave differently — and Apply is easy to miss, so a flipped switch could
			// look like it had done something when it had not.
			SwitchRow(title: "Let the browser type into sessions", caption: nil, tint: .orange, isOn: Binding(
				get: { config.control },
				set: { config.control = $0; saveNow() }
			))
			// Control can be ON and still impossible, and saying only the first half is how
			// a phone ended up showing cmux's own refusal under a panel that claimed
			// control was available. cmux accepts control only from processes it started;
			// the installed service is not one, so the default setup can read every
			// session and type into none. The serving process records its own verdict —
			// this app cannot compute it, because it is not the process doing the serving.
			if config.control, let why = cmuxNote {
				Label(why, systemImage: "exclamationmark.triangle.fill")
					.font(.caption).foregroundStyle(.orange)
					.fixedSize(horizontal: false, vertical: true)
			}
			// The risk, next to the switch that takes it. The terminal panel keeps this
			// visible whether its explanations are open or not, for the same reason.
			Text(
				config.control
					? "Whoever has the control password can type into every session you have open — editing files and running commands. Refused from anywhere but this machine or your tailnet."
					: "Off: no browser can type into any session."
			)
			.font(.caption).foregroundStyle(config.control ? .orange : .secondary)
			.fixedSize(horizontal: false, vertical: true)

			HStack(spacing: 6) {
				Text("Control password:").font(.caption)
				Text(controlSet ? "set" : "not set yet")
					.font(.caption).foregroundStyle(controlSet ? .green : .orange)
				Spacer()
			}
			// Settable here now. It is not hashed here, though: the password goes to
			// `guildhall --set-control-password` on stdin and that does the scrypt, so
			// there is exactly one implementation of storing this credential. Saying
			// "do it in a terminal" was the wrong answer to a control panel.
			HStack {
				SecureField("new control password", text: $controlPassword)
					.frame(width: 200)
				Button("Set") { setControl() }
					.disabled(controlPassword.count < 8)
			}
			Text("Eight characters or more, and not all the same one. Typed straight into guildhall and stored hashed — never sent over the network, and never written down by this app.")
				.font(.caption).foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)

			Divider()

			SwitchRow(title: "Show Codex sessions too", caption: nil, tint: Color(red: 0.43, green: 0.73, blue: 0.77), isOn: Binding(
				get: { config.codex },
				set: { config.codex = $0; saveNow() }
			))
			// What it costs and what it does not do, because "show another agent" sounds
			// like it might go looking on the network. It reads the same kind of local
			// files the Claude side already does.
			Text("Reads ~/.codex on this machine, the same way Claude Code sessions are read. Nothing is sent anywhere. Codex desks are marked with a teal ◆.")
				.font(.caption).foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)

			Divider()

			SwitchRow(title: "Hold the screen on while sessions work", caption: nil, isOn: Binding(
				get: { config.awakeDisplay },
				set: { config.awakeDisplay = $0; saveNow() }
			))
			Picker("Project labels", selection: $config.labels) {
				Text("beside the desk").tag("vertical")
				Text("under it").tag("horizontal")
			}
			.frame(width: 260)

			if !note.isEmpty {
				Text(note).font(.caption).foregroundStyle(failed ? .red : .green)
					.fixedSize(horizontal: false, vertical: true)
			}

			// The caption on its own line, ABOVE the button, and allowed to wrap.
			//
			// It was beside the button in an HStack, where the button takes its intrinsic
			// width first and the text gets whatever is left — inside a 380pt popover that
			// left "Everything else applies as you c…", which is not a sentence and had to
			// be asked about. A line that explains which controls need Apply is worth the
			// vertical space; a truncated one is worth nothing.
			VStack(alignment: .leading, spacing: 8) {
				Text(dirty
					? "Port and passcode are typed, so they need Apply. Everything else on this page saves the moment you change it."
					: "Everything on this page saves as you change it. Port and passcode are the exceptions — type them, then press Apply.")
					.font(.caption)
					.foregroundStyle(dirty ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
					.fixedSize(horizontal: false, vertical: true)
				HStack {
					Spacer()
					// Two branches rather than a conditional style, because a button style is
					// not a value you can pick between — there is no type-erased wrapper for
					// it, and trying reads as if there were.
					//
					// It was always `.borderedProminent` with a grey tint while disabled, which
					// draws a white label on a near-white fill: a blank white pill with no
					// readable text, which is how "what does this even do" happens.
					if dirty {
						Button("Apply port & passcode") { apply() }
							.keyboardShortcut(.defaultAction)
							.buttonStyle(.borderedProminent)
					} else {
						Button("Apply port & passcode") {}
							.disabled(true)
							.buttonStyle(.bordered)
					}
				}
			}
		}
		.padding(14)
		// Same width as the list, so switching between them does not resize the popover
		// under the pointer.
		.frame(width: 380)
		// Ask launchd what is actually true, once, when the page opens. The toggle's
		// initial value cannot come from the config file — see the note on `serving`.
		.task {
			serving = await Daemon.loaded()
			alsoServing = Config.otherServers(configuredPort: config.port)
			cmuxNote = Config.cmuxBlockedNote()
		}
	}

	/// Flip the service, then report what launchd actually did rather than what was
	/// asked for.
	private func setServing(_ want: Bool) async {
		serveBusy = true
		serveNote = ""
		serveFailed = false
		defer { serveBusy = false }
		guard let (node, entry) = Config.tools() else {
			serveNote = "Cannot find guildhall itself — reinstall, or set GUILDHALL_ENTRY."
			serveFailed = true
			serving = await Daemon.loaded()
			return
		}
		// This blocks for as long as it takes to know the answer — up to about ten
		// seconds, because `--set-serve` waits until the service is genuinely the thing
		// listening rather than merely loaded. Which is the point: it used to return
		// instantly and say "serving" over a job that was respawning and never bound.
		let (status, out) = await Daemon.run(node, [entry, "--set-serve", want ? "on" : "off"])
		let said = out.trimmingCharacters(in: .whitespacesAndNewlines)
		serving = await Daemon.loaded()
		config = Config.load()
		if status == 0 {
			serveNote = ""
			serveFailed = false
		} else {
			serveNote = said.isEmpty ? "Could not change it (exit \(status))." : said
			serveFailed = true
			// Show what is true, not what was asked for.
			serving = false
		}
	}

	/// Write the config for a switch that takes effect immediately, and restart the
	/// service so it is actually in effect rather than merely saved.
	private func saveNow() {
		do {
			try config.save()
			note = "Saved."
			failed = false
			if serving { model.act { await Daemon.restart() } }
		} catch {
			note = error.localizedDescription
			failed = true
		}
	}

	private func setControl() {
		let typed = controlPassword
		// Cleared before the call, not after: it must not sit in view state across an
		// await, and there is nothing to retry with it.
		controlPassword = ""
		Task {
			await setControl(typed)
		}
	}

	private func setControl(_ typed: String) async {
		do {
			try await Config.setControlPassword(typed)
			controlSet = true
			note = "Control password set. Every device must enter it again."
			failed = false
		} catch {
			note = error.localizedDescription
			failed = true
		}
	}

	private func apply() { Task { await applyNow() } }

	private func applyNow() async {
		do {
			// The passcode first: if it is malformed, nothing else should be written
			// either, or the person is left guessing which half of Apply took effect.
			if passcode != Config.passcode() { try await Config.setPasscode(passcode) }
			guard config.port >= 1024, config.port <= 65535 else {
				note = "A port is 1024 to 65535."
				failed = true
				return
			}
			// Can the service actually have this port? Asked before saving, because the old
			// order — save, restart, hope — left launchd retrying a bind that could never
			// succeed, with nothing on screen to say so.
			//
			// Another guildhall holding it is allowed through: that is a handover, the
			// browser view works, and the service takes over when the other one stops.
			// Anything else is refused, because it will not let go.
			if portChanged {
				let status = await Config.portStatus(config.port)
				if !status.free && !status.guildhall {
					note = "Port \(String(config.port)) is held by \(status.holder ?? "another program"), which is not guildhall. The service could never start on it — try Random."
					failed = true
					return
				}
			}
			try config.save()
			// The page is only clean once the write succeeded, so a refused port leaves the
			// hint and the button exactly as they were.
			savedPort = config.port
			savedPasscode = passcode
			note = "Saved — restarting the service so it takes effect."
			failed = false
			if serving { model.act { await Daemon.restart() } }
		} catch {
			note = error.localizedDescription
			failed = true
		}
	}
}
