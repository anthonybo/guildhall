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
