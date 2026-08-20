// swift-tools-version: 6.0
//
// The menu bar app.
//
// Swift Package Manager rather than a checked-in Xcode project: an .xcodeproj is
// thousands of lines of generated XML that conflicts on every touch and encodes
// one machine's paths. This builds with `swift build` and `swift/build.sh`
// assembles the .app around it, which is the whole of what Xcode was doing here.
//
// It has no dependencies and will not get any. Everything it needs — a timer, an
// HTTP request, a launchctl call — is in the system frameworks, and a menu bar
// app that pulls in a package graph is a menu bar app somebody has to maintain.
import PackageDescription

let package = Package(
	name: "GuildhallBar",
	platforms: [
		// MenuBarExtra is 13+. Nothing here needs anything newer, and pinning higher
		// would exclude machines for no reason — the app is a list and three buttons.
		.macOS(.v13)
	],
	targets: [
		// Swift 6 language mode, so strict concurrency is ENFORCED rather than
		// mentioned. The package was 5.9, which meant the 6.2 compiler reported data
		// races as warnings nobody saw — including a genuine one, a mutable global
		// written from the main thread and from a process termination handler.
		.executableTarget(
			name: "GuildhallBar", path: "Sources/GuildhallBar",
			swiftSettings: [.swiftLanguageMode(.v6)])
	]
)
