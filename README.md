# Pattern Pulse Trader

Build a Pepperstone cTrader pattern scanner and trading automation dashboard based on the attached documents and specifications:

1. Ticker Selection:
- Allow selecting up to 6 tickers/symbols to monitor simultaneously from Pepperstone cTrader (e.g. US100, EURUSD, GBPUSD, XAUUSD, US500, BTCUSD).

2. Timeframe Selection (up to 13 active timeframes):
- Provide a checklist of all available timeframes including seconds intervals (15 SEC, 30 SEC, 45 SEC, 1 MIN, 3 MIN, 5 MIN, 15 MIN, 30 MIN, 45 MIN, 75 MIN, 125 MIN, 1 HR, 2 HR, 4 HR, 1 D), allowing the user to select and monitor up to 13 active timeframes at once.

3. Pattern Detection Logic (Legin - Boring - Legout):
Reference New_Microsoft_Word_Document-1a.docx and New_Microsoft_Word_Document_a.docx:
- Legin Candle: True Range (TR) > Average True Range (ATR). Wick-to-body ratio <= 40% (Body:Wick at least 60:40, ideally 70:30 or 80:20). Strong momentum candle.
- Boring Candle (Base): True Range (TR) < Average True Range (ATR). Small body candle. Size baseline = 1.
- Legout Candle (Legout 1, 2, or 3): True Range (TR) > Average True Range (ATR). Wick-to-body ratio <= 40%. Size double of Legin candle (and Legin size double of Boring candle).
- Volume Progression: Legin volume > Boring volume, and Legout volume > Legin volume.

4. Trade Signal & Limit Order Calculation:
- Bullish Pattern (Rally-Base-Rally / Drop-Base-Rally):
  - Limit Price = Boring Candle High
  - Stop Loss (SL) = Boring Candle Low
- Bearish Pattern (Drop-Base-Drop / Rally-Base-Drop):
  - Limit Price = Boring Candle Low
  - Stop Loss (SL) = Boring Candle High

5. Dashboard & Scanner Features:
- Live multi-chart / multi-timeframe scanner grid showing real-time scanning status across all active tickers and timeframes.
- Active Signals & Orders feed displaying detected patterns, Boring candle high/low levels, calculated limit price, SL, risk/reward, and execution status.
- Settings panel for cTrader Open API configuration (Client ID, Client Secret, Access Token, Account ID) with connection status indicator and mock/demo data toggle for instant local testing.
- Export / VPS Deployment package tab providing Dockerfile, run script, and configuration files to migrate to VPS.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/2d205f32-8772-47f2-ac6e-8ad7a1c9f206).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
