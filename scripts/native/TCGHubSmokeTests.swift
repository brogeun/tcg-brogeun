import XCTest

// Runs only in an isolated, anonymous iPhone simulator. It never starts an
// OAuth provider flow, submits forms, changes holdings, or deletes an account.
final class TCGHubSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-accessibility"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func tapNavigation(_ app: XCUIApplication, _ label: String) throws {
        let query = app.webViews.firstMatch.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", label))
        XCTAssertTrue(query.firstMatch.waitForExistence(timeout: 20), "Missing navigation: \(label)")
        // The bottom navigation and page heading can share a label. Select
        // the visible element nearest the bottom of this simulator screen.
        guard let target = query.allElementsBoundByIndex.filter({ $0.isHittable })
            .max(by: { $0.frame.midY < $1.frame.midY }) else {
            XCTFail("No hittable navigation: \(label)")
            return
        }
        target.tap()
    }

    func testHostedNavigationAndAnonymousAccountBoundary() throws {
        let app = XCUIApplication(bundleIdentifier: "kr.tcghub.app")
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 45), "The native WebView did not appear")
        XCTAssertTrue(web.staticTexts["내 카드의 오늘을 확인하세요"].waitForExistence(timeout: 45),
                      "The actual hosted home page did not finish rendering")
        attach(app, "01-home")

        try tapNavigation(app, "시세")
        XCTAssertTrue(web.staticTexts["SNKRDUNK 실거래가 기준"].waitForExistence(timeout: 20))
        XCTAssertTrue(web.buttons["박스"].firstMatch.waitForExistence(timeout: 20))
        attach(app, "02-prices")

        try tapNavigation(app, "소식")
        XCTAssertTrue(web.buttons["공식 매장"].firstMatch.waitForExistence(timeout: 20))
        attach(app, "03-news")

        try tapNavigation(app, "카드 정보")
        XCTAssertTrue(web.staticTexts["포켓몬 · 원피스 · 리프트바운드 확장팩 목록, 발매일, 수록 카드 정보"]
            .waitForExistence(timeout: 20))
        attach(app, "04-card-catalogue")

        try tapNavigation(app, "마이페이지")
        let signIn = web.buttons.matching(NSPredicate(format: "label CONTAINS %@", "이메일로 로그인")).firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 20), "Anonymous account gate did not appear")
        let deletion = web.buttons["회원 탈퇴 (계정 영구 삭제)"].firstMatch
        XCTAssertFalse(deletion.exists && deletion.isHittable,
                       "Anonymous visitors must not receive an account deletion action")
        attach(app, "05-anonymous-account-gate")

        try tapNavigation(app, "홈")
        XCTAssertTrue(web.staticTexts["내 카드의 오늘을 확인하세요"].waitForExistence(timeout: 20))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
        XCTAssertTrue(app.webViews.firstMatch.staticTexts["내 카드의 오늘을 확인하세요"]
            .waitForExistence(timeout: 45), "Cold relaunch did not restore a usable home page")
        attach(app, "06-cold-relaunch")
    }
}
