// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "VibeFox",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Direct-distribution auto-update (see docs/SPARKLE.md). Only the app target links
        // it — VibeFoxCore stays dependency-free and unit-testable without AppKit/Sparkle.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0"),
    ],
    targets: [
        // Pure logic + services (no UI): testable library.
        .target(name: "VibeFoxCore", path: "Sources/VibeFoxCore"),
        // Menu-bar app shell (SwiftUI).
        .executableTarget(
            name: "VibeFox",
            dependencies: [
                "VibeFoxCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/VibeFox"
        ),
        .testTarget(
            name: "VibeFoxCoreTests",
            dependencies: ["VibeFoxCore"],
            path: "Tests/VibeFoxCoreTests"
        ),
    ]
)
