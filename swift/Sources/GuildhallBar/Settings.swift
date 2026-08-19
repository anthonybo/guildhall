import SwiftUI

/// Everything the terminal's help panel can change, changeable here.
///
/// The one exception is the control password, which is an scrypt hash written
/// behind a deliberate guard and is set by typing it into the terminal. That is
/// stated on screen rather than left as a gap somebody has to discover.
///
/// Every change writes the config file and then restarts the service, because
/// the port and the passcode are read at startup — a setting that is saved but
/// not in effect is worse than one that is obviously not saved.
struct SettingsView: View {
	@ObservedObject var model: Model
	@Environment(\.dismiss) private var dismiss

	@State private var config = Config.load()
	@State private var passcode = Config.passcode()
	@State private var note = ""
	@State private var failed = false

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			HStack {
				Text("Settings").font(.headline)
				Spacer()
				Button("Done") { dismiss() }
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
					TextField("1234", text: $passcode)
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
				Text(Config.controlPasswordIsSet() ? "set" : "not set yet")
					.font(.caption).foregroundStyle(Config.controlPasswordIsSet() ? .green : .orange)
				Spacer()
			}
			// Not editable here on purpose, and it says why rather than simply omitting
			// the field. It is stored as a hash behind a guard that exists because a
			// script once overwrote the real password with a test string.
			Text("Set it by running guildhall in a terminal, pressing ? then c. It is stored hashed and never accepted over the network.")
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
		.padding(16)
		.frame(width: 420)
	}

	private func apply() {
		do {
			// The passcode first: if it is malformed, nothing else should be written
			// either, or the person is left guessing which half of Apply took effect.
			if passcode != Config.passcode() { try Config.setPasscode(passcode) }
			guard config.port >= 1024, config.port <= 65535 else {
				note = "A port is 1024 to 65535."
				failed = true
				return
			}
			try config.save()
			note = "Saved — restarting the service so it takes effect."
			failed = false
			model.act { Daemon.restart() }
		} catch {
			note = error.localizedDescription
			failed = true
		}
	}
}
