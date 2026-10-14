"""E2E: python3 tests/e2e.py [url]  (Playwright over CDP localhost:29229, serve dist/ on :8765)."""
import sys, time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/"
EXPECT = ["BUY", "SELL", "SHORT", "COVER", "BUY", "SELL", "BUY", "SELL", "SHORT", "COVER", "SHORT"]
ok = True
def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg); ok = ok and cond

with sync_playwright() as p:
    br = p.chromium.connect_over_cdp("http://localhost:29229")
    ctx = br.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL); page.evaluate("localStorage.clear()"); page.reload()
    page.wait_for_selector("text=Run demo scenario")
    page.evaluate("S.settings.speed=20; restartLoops()")
    page.click("text=Run demo scenario")
    t0 = time.time()
    while time.time() - t0 < 40 and page.evaluate("S.quotes.DEMO.script.length") > 0:
        time.sleep(0.5)
    time.sleep(0.5)
    page.evaluate("S.settings.running=false")
    trades = page.evaluate("S.trades.map(t=>[t.action,t.price,t.pl,t.reason])")
    for t in trades: print("   ", t)
    check([t[0] for t in trades[:len(EXPECT)]] == EXPECT, "demo hits every rule in order")
    pls = [t[2] for t in trades if t[2] is not None]
    check(len(pls) >= 5 and pls[0] > 0 and pls[1] > 0 and pls[2] < 0 and pls[3] > 0 and pls[4] < 0, "P/L signs: profit, short profit, stop loss, profit, short loss")
    # nudge test on a fresh stock
    page.click("#tabs [data-go=new]"); page.fill("#nSym", "AAPL"); page.fill("#nQty", "10")
    page.click("[data-act=create]"); page.wait_for_selector(".bot >> text=AAPL")
    page.click(".bot:has-text('AAPL')"); page.wait_for_selector("#sheet:not(.hidden)")
    page.evaluate("pushPrice('AAPL', S.bots.find(b=>b.sym==='AAPL').entry*1.21, Date.now())")
    page.wait_for_timeout(300)
    check(page.evaluate("S.bots.find(b=>b.sym==='AAPL').phase") == "WATCH_PEAK", "AAPL +21% -> sold, watching top")
    for _ in range(3): page.click("[data-act=nudge][data-v='-1']")
    page.click("[data-act=nudge][data-v='-5']"); page.wait_for_timeout(300)
    check(page.evaluate("S.bots.find(b=>b.sym==='AAPL').phase") == "SHORT", "-5% off high -> short")
    page.screenshot(path="tests/shot-sheet-mobile.png")
    page.click("#sheet [data-close].x")
    page.screenshot(path="tests/shot-portfolio-mobile.png", full_page=True)
    for v in ["new", "log", "profiles", "settings", "portfolio"]:
        page.click(f"#tabs [data-go={v}]"); page.wait_for_timeout(300)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check(sw <= 390, f"{v}: no horizontal overflow at 390px ({sw})")
        if v in ("log", "profiles"): page.screenshot(path=f"tests/shot-{v}-mobile.png")
    page.set_viewport_size({"width": 1280, "height": 860}); page.wait_for_timeout(400)
    page.screenshot(path="tests/shot-portfolio-desktop.png")
    page.click(".bot:has-text('DEMO')"); page.wait_for_timeout(400)
    page.screenshot(path="tests/shot-sheet-desktop.png")
    check(not errs, "no page errors " + str(errs))
    page.close(); ctx.close()
print("ALL PASS" if ok else "FAILURES")
sys.exit(0 if ok else 1)
