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
					TextField("4318", value: $config.port, format: .number.grouping(.never))
						.frame(width: 90)
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

			HStack(spacing: 8) {
				Text(dirty
					? "Unsaved changes above."
					: "Everything else applies as you change it.")
					.font(.caption)
					.foregroundStyle(dirty ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
				Spacer()
				// Grey until there is something to apply, and prominent when there is.
				// A button that is always enabled offers to save when nothing has changed
				// and gives no signal at the moment something has — so it reads as a step
				// you must always perform, which is why a flipped switch felt unsaved.
				Button("Apply port & passcode") { apply() }
					.keyboardShortcut(.defaultAction)
					.disabled(!dirty)
					.buttonStyle(.borderedProminent)
					.tint(dirty ? .accentColor : .gray)
			}
		}
		.padding(14)
		// Same width as the list, so switching between them does not resize the popover
		// under the pointer.
		.frame(width: 380)
		// Ask launchd what is actually true, once, when the page opens. The toggle's
		// initial value cannot come from the config file — see the note on `serving`.
		.task { serving = await Daemon.loaded() }
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
