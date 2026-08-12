import Testing
@testable import VibeFoxCore

@Test func userDataDirMatchesElectronLayout() {
    let dir = AppPaths.userDataDir.path
    #expect(dir.hasSuffix("/Library/Application Support/VibeFox"))
    #expect(AppPaths.configFile.lastPathComponent == "config.json")
}
