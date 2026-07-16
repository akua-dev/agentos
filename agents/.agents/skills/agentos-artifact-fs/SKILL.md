---
name: agentos-artifact-fs
description: Select, prepare, operate, and retire ArtifactFS-backed Scout workspaces for fast read-heavy access to large or multiple Git repositories. Use when a First or Second Mate is delegating a scout investigation whose clone startup or cross-repository breadth justifies an isolated FUSE-enabled Crewmate profile; never use it for persistent Mates or ship work by default.
---

# Explore repositories with ArtifactFS

Use ArtifactFS only as an optional Scout workspace. Keep First Mate, Second Mate,
ship Crewmates and ordinary scouts on native Git unless measured repository size
or multi-repository breadth makes lazy hydration materially useful.

## Select the profile

1. Confirm the Assignment is `scout` and its durable output is a report, not a
   project change. Load `$agentos-delegation` before provisioning the worker.
2. Inspect repository count, size, expected files and write intensity. Prefer
   native Git for one modest repository or build-heavy, status-heavy and
   write-heavy work.
3. Read ArtifactFS's current official
   [README](https://github.com/cloudflare/artifact-fs),
   [consumer skill](https://github.com/cloudflare/artifact-fs/blob/main/.agents/skills/artifact-fs/SKILL.md)
   and [releases](https://github.com/cloudflare/artifact-fs/releases). Treat
   prereleases as experimental. Pin an exact reviewed tag or commit and the
   resulting Scout image by digest.
4. Ask before building an image, installing cluster support, mounting
   credentials or granting FUSE-related Pod permissions. If the platform lacks
   an already reviewed `/dev/fuse` path, stop or use native Git; never improvise
   a privileged Pod, host runtime socket or host-wide policy exception.

## Prepare the Scout

1. Build `agents/crewmate/images/artifact-fs/Dockerfile` on top of the exact
   reviewed Crewmate image. Do not add ArtifactFS, Go or FUSE packages to the
   common AgentOS image.
2. Create one dedicated Crewmate Pod and ServiceAccount for the Assignment.
   Keep database, repository and Kubernetes permissions bounded to that Scout.
   Use the platform's reviewed device plugin, DRA driver or equivalent to expose
   `/dev/fuse`. Add only the capability and AppArmor/seccomp exception proven
   necessary by a lifecycle test, and record them in the reviewed per-Agent
   overlay. Do not grant cluster-admin.
3. Keep the daemon in the same container and mount namespace as the Scout
   harness. Use one daemon for the Assignment's repositories, not one daemon or
   credential set shared across the Fleet.
4. Use dedicated scratch state and mount roots keyed by Assignment ID. Keep
   repository credentials ambient through a scoped Git credential helper, SSH
   agent or mounted file. Never embed a token in the remote URL, command
   arguments, brief, image or logs.
5. Register each repository with a credential-free HTTPS or SSH URL. Start the
   long-running daemon in its own named Herdr pane, then start the Scout harness
   in a separate pane with the declared mount as its workspace. Do not hide the
   daemon behind a repository-owned background shell script.
6. Verify every mounted repository's commit, branch, status and ArtifactFS
   health before the Scout reads it. A placeholder mount, I/O error, dirty
   overlay or unexpected ref is a blocker, not a ready workspace.

## Preserve the Scout boundary

- Treat the mounted commit as the base view and every local write as disposable
  overlay state. Do not open a pull request or promote overlay edits into ship
  work.
- Query only the files needed for the report. Lazy hydration saves startup only
  when the Scout does not immediately read or build the entire repository.
- Persist findings, decisions and blockers through Task, Assignment and Inbox
  state. The mount, cache and terminal history are not the durable report.
- If implementation is requested, complete the Scout report and create a ship
  Task with a native isolated Treehouse worktree. Do not reuse the ArtifactFS
  overlay as delivered source.

## Retire cleanly

1. Make the report durable and let the owning Mate accept it.
2. Stop the Scout harness, then stop the ArtifactFS daemon and verify every
   mount is gone. Remove registered repositories and Assignment-scoped scratch
   state only after acceptance.
3. Revoke or unmount repository credentials and remove the exceptional Pod.
4. Close the Assignment and retire the Scout through the ordinary guarded
   delegation lifecycle.

Use `$agentos-runtime` for native Herdr, Pod and recovery operations. ArtifactFS
does not replace Git as delivered-code truth or PostgreSQL as Fleet truth.
