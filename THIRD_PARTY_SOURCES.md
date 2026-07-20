# Third-party source offers

This file records reproducible source locations for copyleft software redistributed by AgentOS releases.
Release packaging must copy this record and the applicable license into every artifact that includes the corresponding executable.

## Bun 1.4.0-canary.1+3979cbe80

AgentOS may convey the unmodified normal platform archives from Bun revision
`1.4.0-canary.1+3979cbe80`. The immutable upstream source commit is
`3979cbe80db3b8ad766f858fb1c82fc385318fa6`; that revision pins WebKit commit
`a0e65bf298499d828f0c60d4557899b94a69d7ae`.

- Bun source archive: <https://github.com/oven-sh/bun/archive/3979cbe80db3b8ad766f858fb1c82fc385318fa6.tar.gz>
- Bun source tree and build instructions: <https://github.com/oven-sh/bun/tree/3979cbe80db3b8ad766f858fb1c82fc385318fa6>
- WebKit source tree: <https://github.com/oven-sh/WebKit/tree/a0e65bf298499d828f0c60d4557899b94a69d7ae>
- License and relinking record: attached to the immutable AgentOS toolchain
  prerelease named in `THIRD_PARTY_NOTICES.md`

The upstream Bun license describes how to build against a modified WebKit
checkout. Release packaging must preserve that license, LGPL text and source
record beside every mirrored Bun archive.

## Herdr 0.7.3

AgentOS may convey the upstream `herdr-linux-x86_64` or `herdr-linux-aarch64` executable from Herdr v0.7.3 as an unmodified, separate program.
The immutable upstream source commit is `299dd4163a96381ec2d8e5bde13d7ba6d6432373`.

- Source archive: <https://github.com/ogulcancelik/herdr/archive/299dd4163a96381ec2d8e5bde13d7ba6d6432373.tar.gz>
- SHA-256: `4e4a536fff8cd74019a1f8b4f1eef7fce556042f2b3e389eb6f9a155c1a7c6d5`
- License: <https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/LICENSE>

The archive includes Herdr's Rust source, locked dependency graph, build files, and its vendored `portable-pty` patch source.
Build and release automation must verify this checksum and preserve Herdr as a separate process.
