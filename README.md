# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/OWNER/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/OWNER/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API for repositories, contents, issues and pull requests; the GraphQL v4 API; and a Model Context Protocol endpoint — all four surfaces over one shared store, with a real git object model (SHA-1, packs, deltas, merges) underneath.

## Run it

```sh
node main.ts
# binds an ephemeral port, registers it with $MAKEFUN_ENV_URL/register, serves until the suite answers done
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=lucky-comet-18&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
