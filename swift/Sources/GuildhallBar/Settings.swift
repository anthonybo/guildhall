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
	@State private var serveInstalled = Daemon.installed

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
			if serveInstalled {
				// A Binding that intercepts the set, rather than `.onChange`: the
				// two-parameter form needs macOS 14 and this app targets 13, and the
				// one-parameter form is deprecated, which -warnings-as-errors treats as a
				// build failure.
				Toggle("Serve the browser view", isOn: Binding(
					get: { serving },
					set: { want in
						serving = want
						Task {
							let failure = want ? await Daemon.start() : await Daemon.stop()
							if let failure {
								note = failure
								failed = true
								// Show what launchd actually did, not what was asked for.
								serving = await Daemon.loaded()
							} else {
								// Keep the file honest too, so the terminal and this agree.
								config.serve = want
								// Best-effort: launchd already did the load or unload, which is what
								// "serving" actually means. A config write that fails must not undo it.
								try? config.save()
								note = want ? "Serving. Press ? in the room for the address." : "Stopped serving."
								failed = false
							}
						}
					}
				))
				Text(serving
					? "A browser can reach this machine. The three settings below apply to it."
					: "Nothing is served. The menu bar icon works either way.")
					.font(.caption).foregroundStyle(.secondary)
			} else {
				Text("Serve the browser view")
				Text("Not installed. Run `sh tools/install-mac.sh --serve` in the checkout once, then it can be switched on here.")
					.font(.caption).foregroundStyle(.secondary)
			}

			Divider()

			Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
				GridRow {
					Text("Port")
					TextField("4318", value: $config.port, format: .number.grouping(.never))
						.frame(width: 80)
					Text("restarts the service").font(.caption).foregroundStyle(.secondary)
				}
				GridRow {
					Text("Passcode")
					TextField("8317", text: $passcode)
						.frame(width: 80)
					Text("four digits · signs every device out").font(.caption).foregroundStyle(.secondary)
				}
				GridRow {
					Text("Reachable on")
					Picker("", selection: $config.host) {
						Text("this machine only").tag("127.0.0.1")
						Text("the network").tag("0.0.0.0")
					}
					.labelsHidden().frame(width: 170)
					Color.clear.frame(height: 1)
				}
			}

			Divider()

			Toggle("Let the browser type into sessions", isOn: $config.control)
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

			Toggle("Hold the screen on while sessions work", isOn: $config.awakeDisplay)
			Picker("Project labels", selection: $config.labels) {
				Text("beside the desk").tag("vertical")
				Text("under it").tag("horizontal")
			}
			.frame(width: 260)

			if !note.isEmpty {
				Text(note).font(.caption).foregroundStyle(failed ? .red : .green)
					.fixedSize(horizontal: false, vertical: true)
			}

			HStack {
				Spacer()
				Button("Apply") { apply() }.keyboardShortcut(.defaultAction)
			}
		}
		.padding(14)
		// Same width as the list, so switching between them does not resize the popover
		// under the pointer.
		.frame(width: 380)
		// Ask launchd what is actually true, once, when the page opens. The toggle's
		// initial value cannot come from the config file — see the note on `serving`.
		.task {
			serveInstalled = Daemon.installed
			serving = serveInstalled ? await Daemon.loaded() : false
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
			note = "Saved — restarting the service so it takes effect."
			failed = false
			model.act { await Daemon.restart() }
		} catch {
			note = error.localizedDescription
			failed = true
		}
	}
}
