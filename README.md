# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/jkislew/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/jkislew/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Leonida Earners: a count-consistent forecaster for GTA VI trophy rarity. An Exophase earn rate is a count in disguise — rate times players tracked is an integer number of earners — and the page only changes at refresh moments, so the recorded history is a staircase rather than a smooth series. The program collapses consecutive identical reads into refresh epochs, rebuilds earners per trophy from the printed rates, extrapolates tracked players and earners separately in log-time with slopes shrunk toward their trophy-class means (story, grind, money, misc, completion), and divides the two forecasts back into a rate. That division is the race that decides week one: new tracked players dilute every rate while earners accumulate. Special handling covers the introductory trophy held by nearly everyone, the platinum and 100%-completion trophies that take hundreds of hours, and floor trophies held by only a handful of players, whose uncertainty is Poisson-shaped rather than a trend. Quantiles are built on the logit scale with a random-walk spread over the horizon, fit residuals pooled by class, and a fattened outer band for refresh shocks. The program is a pure, deterministic function of the case file: no network, no clock, no randomness.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

With no environment variables set it reads `/input` and writes `/output`, one `<case>.out` file per `<case>.in` file, each holding five quantiles (5%, 25%, 50%, 75%, 95%) for all 55 trophies. Running it twice on the same input produces byte-identical output.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tpc75c2v&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
