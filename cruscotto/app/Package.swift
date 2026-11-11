// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "CruscottoClaude",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "CruscottoClaude", path: "Sources/CruscottoClaude"),
    ]
)
