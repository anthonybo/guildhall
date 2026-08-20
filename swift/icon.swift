// Draw the app's Finder icon, so /Applications has something you can pick out.
//
// The bundle shipped with no icon at all. That is invisible in two ways nobody
// notices until they need it: Finder draws the generic blank sheet for it, and
// Spotlight has nothing to show, so when the menu bar item goes away there is no
// obvious thing to click to bring it back. The app was always there and always
// launchable — you just could not see it.
//
// The glyph is the SAME symbol the menu bar draws, because an icon that does not
// look like the thing it starts is not much better than a blank one.
//
// Compiled by build.sh with swiftc rather than being a SwiftPM target: it runs once
// per build, produces a file, and has nothing to do with the app's own sources. It
// is also allowed to fail without failing the build — an older macOS missing the
// symbol should still get a working app, just a plain-looking one.

import AppKit

let sizes = [16, 32, 64, 128, 256, 512, 1024]

/// Where to write the .iconset. Passed in so build.sh owns the layout.
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./GuildhallBar.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

/// Draws one size: a squircle-ish plate with the hall glyph on it, into a bitmap of
/// EXACT pixel dimensions.
///
/// `NSImage.lockFocus()` was the obvious way and it is wrong here: it inherits the
/// current display's backing scale, so on a Retina Mac every file came out at twice
/// its nominal size — `icon_16x16.png` was 32x32 — and `iconutil` silently dropped
/// the slots whose contents did not match their name. The .icns was produced, was
/// non-empty, and was missing its 16px and 128px entries; nothing said so.
///
/// Setting `rep.size` equal to the pixel dimensions makes one point one pixel,
/// whatever display the build happens to run on.
func draw(_ px: Int) -> NSBitmapImageRep {
	let size = CGFloat(px)
	guard let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
		bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
		colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
	) else {
		FileHandle.standardError.write("icon: could not allocate \(px)px bitmap\n".data(using: .utf8)!)
		exit(1)
	}
	rep.size = NSSize(width: size, height: size)
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
	defer {
		NSGraphicsContext.restoreGraphicsState()
	}

	// Apple's grid leaves roughly a tenth of the canvas empty on each side, and the
	// corner radius is a bit under a quarter of the plate. Eyeballed against the
	// system icons in /Applications rather than derived — if it looks wrong beside
	// them, change these two numbers.
	let inset = size * 0.085
	let plate = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
	let radius = plate.width * 0.235

	let path = NSBezierPath(roundedRect: plate, xRadius: radius, yRadius: radius)
	// A quiet slate, so a white glyph carries the shape and the plate does not
	// compete with it. Vertical gradient only — anything busier reads as noise at
	// 16px, which is the size that actually has to work.
	let gradient = NSGradient(colors: [
		NSColor(calibratedRed: 0.16, green: 0.20, blue: 0.27, alpha: 1),
		NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.13, alpha: 1),
	])
	gradient?.draw(in: path, angle: -90)

	// A hairline lift along the top edge, which is what keeps the plate from looking
	// flat against a dark wallpaper.
	NSColor(calibratedWhite: 1, alpha: 0.10).setStroke()
	path.lineWidth = max(1, size * 0.006)
	path.stroke()

	let glyphBox = plate.insetBy(dx: plate.width * 0.19, dy: plate.height * 0.19)
	let config = NSImage.SymbolConfiguration(pointSize: glyphBox.height, weight: .medium)
		.applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
	if let symbol = NSImage(systemSymbolName: "building.columns.fill", accessibilityDescription: "guildhall")?
		.withSymbolConfiguration(config)
	{
		// Fit by aspect rather than stretching: the hall is wider than it is tall, and
		// filling the box would squash the columns.
		let s = symbol.size
		let scale = min(glyphBox.width / s.width, glyphBox.height / s.height)
		let drawn = NSSize(width: s.width * scale, height: s.height * scale)
		let origin = NSPoint(
			x: glyphBox.midX - drawn.width / 2,
			y: glyphBox.midY - drawn.height / 2
		)
		symbol.draw(in: NSRect(origin: origin, size: drawn))
	}
	return rep
}

/// The names `iconutil` insists on. A missing pair is not an error, it is a size
/// the Finder silently falls back on, which is how an icon ends up looking soft.
let names: [Int: [String]] = [
	16: ["icon_16x16"],
	32: ["icon_16x16@2x", "icon_32x32"],
	64: ["icon_32x32@2x"],
	128: ["icon_128x128"],
	256: ["icon_128x128@2x", "icon_256x256"],
	512: ["icon_256x256@2x", "icon_512x512"],
	1024: ["icon_512x512@2x"],
]

for px in sizes {
	let rep = draw(px)
	guard let png = rep.representation(using: .png, properties: [:]) else {
		FileHandle.standardError.write("icon: could not encode \(px)px\n".data(using: .utf8)!)
		exit(1)
	}
	// The size is asserted, not assumed. Getting this wrong produced a plausible
	// .icns with holes in it and no error from anything.
	guard rep.pixelsWide == px, rep.pixelsHigh == px else {
		FileHandle.standardError.write("icon: asked for \(px)px, got \(rep.pixelsWide)x\(rep.pixelsHigh)\n".data(using: .utf8)!)
		exit(1)
	}
	for name in names[px] ?? [] {
		let path = "\(out)/\(name).png"
		do {
			try png.write(to: URL(fileURLWithPath: path))
		} catch {
			FileHandle.standardError.write("icon: could not write \(path): \(error)\n".data(using: .utf8)!)
			exit(1)
		}
	}
}
