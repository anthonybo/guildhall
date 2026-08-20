import AppKit
import SwiftUI

/// The status item's glyph, coloured by what the room is doing.
///
/// Colour needs a NON-TEMPLATE image. A menu bar item renders a template image as
/// a solid mask in the system's own colour — that is what makes ordinary status
/// icons follow light and dark mode — so `.foregroundStyle` on the label is
/// discarded. The way to keep a colour is to render the symbol with a palette
/// configuration and clear `isTemplate`, which opts out of the tinting.
///
/// The cost of opting out: the system no longer inverts it for you, so each colour
/// has to work on both a light and a dark menu bar. The three below are system
/// colours, which are defined for both.
enum BarIcon {
	/// What the icon is saying, in the order that matters.
	enum Mood: Equatable {
		/// something is waiting on a person
		case needsYou
		/// at least one session is generating or running a command
		case active
		/// everything finished or parked
		case quiet
		/// the server cannot be reached
		case unknown
	}

	/// Rendered images, kept between renders.
	///
	/// `NSImage(systemSymbolName:)` plus a symbol configuration is not free, and the
	/// label is rebuilt whenever the model publishes. There are four of these ever,
	/// so they are built once each and held.
	@MainActor private static var cache: [String: NSImage] = [:]

	@MainActor static func image(for mood: Mood) -> NSImage? {
		let key = "\(mood)"
		if let hit = cache[key] { return hit }
		guard let made = render(mood) else { return nil }
		cache[key] = made
		return made
	}

	@MainActor private static func render(_ mood: Mood) -> NSImage? {
		// Colour ONLY where it means something, and a template everywhere else.
		//
		// Opting out of template rendering buys a colour and costs the system's
		// tinting, which is what keeps an icon legible against a light menu bar, a
		// dark one, and the translucency over whatever wallpaper is behind it. A grey
		// non-template hall is the worst of both: no meaning, and worse contrast than
		// the icons either side of it.
		//
		// So the two states that are saying nothing stay ordinary system icons, and
		// green and orange are reserved for the two that are.
		let (symbol, colour): (String, NSColor?) = {
			switch mood {
			// The one state you must not miss keeps the shape the whole system uses for
			// it, rather than a differently coloured hall.
			case .needsYou: return ("exclamationmark.triangle.fill", .systemOrange)
			case .active: return ("building.columns.fill", .systemGreen)
			case .quiet: return ("building.columns", nil)
			case .unknown: return ("building.columns", nil)
			}
		}()

		guard let base = NSImage(systemSymbolName: symbol, accessibilityDescription: label(for: mood)) else { return nil }
		let plain = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
		guard let colour else {
			guard let templated = base.withSymbolConfiguration(plain) else { return nil }
			templated.isTemplate = true
			return templated
		}
		guard let coloured = base.withSymbolConfiguration(plain.applying(NSImage.SymbolConfiguration(paletteColors: [colour]))) else { return nil }
		// The line that actually keeps the colour. Left as a template, the menu bar
		// would paint the whole glyph in one system colour and the palette above would
		// have no visible effect at all.
		coloured.isTemplate = false
		return coloured
	}

	/// Spoken aloud, since the colour and the shape both carry the meaning and a
	/// screen reader gets neither.
	static func label(for mood: Mood) -> String {
		switch mood {
		case .needsYou: return "sessions need you"
		case .active: return "sessions working"
		case .quiet: return "all sessions idle"
		case .unknown: return "guildhall not reachable"
		}
	}
}
