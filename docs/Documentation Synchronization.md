# Documentation Synchronization

Public documentation and a personal Obsidian vault have different privacy boundaries.
Use explicit file mappings and a three-way review; never mirror the whole directory.

1. Record remote main, branches, exact SHAs, Git status and a source-file hash inventory.
2. Verify prior backup evidence; create a fresh timestamped backup of all vault files,
   including hidden `.obsidian` files, and affected operating notes. Verify SHA-256
   against source both before and after copying. Stop all vault writes on failure.
3. Reconcile merged implementation, current local notes and saved originals. Keep
   historical revisions/test counts dated. Archive private originals locally before
   replacing their current summaries. Do not publish local paths or private archives.
4. Maintain an allowlist of shared notes. Preserve local-only notes, metadata,
   Wikilinks, backlinks, themes, plugins and settings. Never copy `.obsidian` from
   another worktree. Never delete local notes to match main.
5. Use Markdown relative links with real public targets on GitHub. In the vault,
   preserve Wikilinks and mirror required operating notes under a Reference folder;
   link code examples to the reviewed GitHub revision, not stale original source.
6. Before every update compare the saved source and destination hashes. If either
   changed, stop and reconcile the new edits; do not blindly overwrite or auto-resolve.
7. Validate GitHub links/anchors and Obsidian Wikilinks separately. Scan published
   files for paths/secrets and contradictory security claims. Review a docs-only diff,
   run required checks, and merge only when checks pass and repository rules permit.
8. Record the final merge SHA and CI URL locally; compare merged public files against
   approved copies and verify untouched source/configuration/backup hashes.

A local synchronization manifest should record source SHA-256, destination SHA-256,
the Git revision and mapping for each file. A repeat run with matching hashes is
a no-op. A changed source or destination requires fresh review and a new backup.
The private manifest, backups, reports and helper scripts stay outside public commits.

See [Integration Checkpoint](Integration%20Checkpoint.md) for the current implementation and remaining risks.
