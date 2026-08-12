// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "VibeFox",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure logic + services (no UI): testable library.
        .target(name: "VibeFoxCore", path: "Sources/VibeFoxCore"),
        // Menu-bar app shell (SwiftUI).
        .executableTarget(
            name: "VibeFox",
            dependencies: ["VibeFoxCore"],
            path: "Sources/VibeFox"
        ),
        .testTarget(
            name: "VibeFoxCoreTests",
            dependencies: ["VibeFoxCore"],
            path: "Tests/VibeFoxCoreTests"
        ),
    ]
)
