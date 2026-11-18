# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/uujhsiiuds-afk/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/uujhsiiuds-afk/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A calm-dip swing bot for Coinbase Wrapped BTC (cbBTC) on 1-minute bars. It buys only a real dip — the close at least 50 bps below its 64-bar EMA, once the last 5 bars have stopped plunging — sells half at +100 bps over cost, trails the rest 40 bps from its peak close, and cuts the whole position at -120 bps. Two stop-outs in a row pause entries for 180 bars. On the published dev window it makes +$22.90 net PnL with 9 trades and a 1.09% maximum drawdown, against -$31.63 for buy-and-hold.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zy5cp793&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
