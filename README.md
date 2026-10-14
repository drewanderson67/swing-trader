# SwingTrader

Mobile-first paper-trading PWA that monitors stocks and trades them automatically against a gain/loss profile.

## Rules (default profile: gain 20%, loss 10%, swing 5%, short gain 20%, short risk 10%)
1. **Long**: sell for profit at +gain %, or sell for loss at −loss %.
2. **After a profit sale**: track the high; when price drops swing % off the high, **sell short**.
3. **Short**: buy to cover for profit after a further −short gain % drop, or for a loss at +short risk %.
4. **After a short profit**: track the low; when price rises swing % off the low, **buy**, and the cycle repeats.
5. **After a loss** (configurable): mirror the swing rule (default), reverse immediately, or stop.

Every fill is logged with its reason and realized P/L (CSV export).

## Price sources
- **Simulated** (default, offline): random walk with trending regimes; per-stock ±% nudges to test rules; scripted **DEMO** walks through every rule.
- **Live**: Finnhub `/quote` polling (free API key, stored only in the browser).

## Build / test
```
python3 build.py                       # -> dist/ (single-file index.html + sw.js, manifest, icons)
(cd dist && python3 -m http.server 8765)
python3 tests/e2e.py                   # Playwright over CDP localhost:29229
```
Paper trading only; no broker orders are placed.
