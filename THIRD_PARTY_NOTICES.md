# Third-party notices

AgentOS itself is licensed under the MIT License.
Release artifacts may redistribute separate third-party programs under their own licenses.
The release build and its bill of materials determine which notices apply to a particular artifact.

## pi-quota-router

`services/quota-router/` derives its private atomic storage, Codex account
identity/refresh, usage parsing and quota-selection policy from
[`robinbraemer/pi-quota-router`](https://github.com/robinbraemer/pi-quota-router)
at commit `f328540fb9092619c9d8e8bf07f082724c948c2a`, used under the MIT License:

> MIT License
>
> Copyright (c) 2026 Robin Braemer
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Subrouter

`services/quota-router/` adapts request proxying, path normalization and session
stickiness ideas from
[`manaflow-ai/subrouter`](https://github.com/manaflow-ai/subrouter) at commit
`a691ae027723f31d838da543afc31ccd19d09d33`, used under the MIT License:

> MIT License
>
> Copyright (c) 2026 Manaflow
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Herdr

An AgentOS release that includes Herdr redistributes the unmodified Herdr 0.7.3 executable as a separate program under the GNU Affero General Public License v3.0 or later.
AgentOS invokes Herdr through its public command-line and socket interfaces; it does not link or embed Herdr source.

Such a release must include Herdr's license and the corresponding source offer recorded in [THIRD_PARTY_SOURCES.md](THIRD_PARTY_SOURCES.md).
Any patching, linking, embedding, or version change requires a new distribution and license review before publication.

## ArtifactFS

The optional ArtifactFS Scout image includes the unmodified ArtifactFS
`1.0.0-rc.6` executable as a separate program under the Apache License 2.0.
The corresponding upstream commit is
[`eb426cd0c09ed6986b4755ccae9ff2deb2e0acdd`](https://github.com/cloudflare/artifact-fs/tree/eb426cd0c09ed6986b4755ccae9ff2deb2e0acdd).
The image preserves ArtifactFS's license at
`/usr/share/licenses/artifact-fs/LICENSE`.

Release automation must include the optional image's complete generated
software bill of materials and license inventory because the statically built
executable contains its locked Go dependencies. A version, source, patch or
linking change requires a fresh distribution and license review.
