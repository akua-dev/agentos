# Third-party notices

AgentOS itself is licensed under the MIT License.
Release artifacts may redistribute separate third-party programs under their own licenses.
The release build and its bill of materials determine which notices apply to a particular artifact.

## Herdr

An AgentOS release that includes Herdr redistributes the unmodified Herdr 0.7.3 executable as a separate program under the GNU Affero General Public License v3.0 or later.
AgentOS invokes Herdr through its public command-line and socket interfaces; it does not link or embed Herdr source.

Such a release must include Herdr's license and the corresponding source offer recorded in [THIRD_PARTY_SOURCES.md](THIRD_PARTY_SOURCES.md).
Any patching, linking, embedding, or version change requires a new distribution and license review before publication.
