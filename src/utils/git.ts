import { execa, ExecaError } from "execa";
import chalk from "chalk";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Record of stashed changes that have not been restored yet.
 * The stash commit created by `stashChanges` is dangling (not in `refs/stash`),
 * so this file is the durable link back to the user's uncommitted work.
 */
interface StashRecord {
    hash: string;
    message: string;
    createdAt: string;
    /** Commit whose tree represents the index before the stash was created. */
    indexCommit?: string;
    /** Paths that were untracked or unstaged before stashing and must be
     *  returned to that index state after the stash is applied */
    resetPaths?: string[];
}

export async function stashRecordPath(cwd: string = "."): Promise<string> {
    const { stdout } = await execa("git", ["-C", cwd, "rev-parse", "--git-common-dir"]);
    // --git-common-dir may be relative to the target cwd, not the process cwd
    return join(resolve(cwd, stdout.trim()), "wt-stash.json");
}

/**
 * Read the record of a not-yet-restored stash, if one exists.
 * Returns null when no record exists or it cannot be read/parsed.
 */
export async function readStashRecord(cwd: string = "."): Promise<StashRecord | null> {
    try {
        const raw = await readFile(await stashRecordPath(cwd), "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "hash" in parsed && typeof parsed.hash === "string") {
            return {
                hash: parsed.hash,
                message: "message" in parsed && typeof parsed.message === "string" ? parsed.message : "",
                createdAt: "createdAt" in parsed && typeof parsed.createdAt === "string" ? parsed.createdAt : "",
                indexCommit: "indexCommit" in parsed && typeof parsed.indexCommit === "string" ? parsed.indexCommit : undefined,
                resetPaths:
                    "resetPaths" in parsed &&
                    Array.isArray(parsed.resetPaths) &&
                    parsed.resetPaths.every(entry => typeof entry === "string")
                        ? parsed.resetPaths
                        : [],
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Validate that we are inside a git work tree
 *
 * @throws Error with a user-friendly message when we are not
 */
export async function validateGitRepo(): Promise<void> {
    try {
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);
    } catch {
        throw new Error("Not a git repository. Please run this command from within a git repository.");
    }
}

export async function isWorktreeClean(worktreePath: string = "."): Promise<boolean> {
    try {
        // Use --porcelain to get easily parsable output.
        // An empty output means clean (for tracked files).
        // We check the specific worktree path provided, defaulting to current dir.
        const { stdout } = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);

        // If stdout is empty, the worktree is clean regarding tracked/staged files.
        // You might also consider ignoring untracked files depending on strictness,
        // but for operations like checkout, it's safer if it's fully clean.
        // If stdout has anything, it means there are changes (modified, staged, untracked, conflicts etc.)
        if (stdout.trim() === "") {
            return true;
        } else {
            // Optional: Log *why* it's not clean for better user feedback
            // console.warn(chalk.yellow("Git status details:\n" + stdout));
            return false;
        }
    } catch (error: any) {
        // If git status itself fails (e.g., not a git repo)
        console.error(chalk.red(`Failed to check git status for ${worktreePath}:`), error.stderr || error.message);
        // Treat failure to check as "not clean" or rethrow, depending on desired behavior.
        // Let's treat it as potentially unsafe to proceed.
        return false;
    }
}

/**
 * Determine whether the main (non-worktree) Git repository is configured as a bare repository.
 *
 * Checks the repository root for the `core.bare` setting and returns its boolean value. If the
 * `core.bare` key does not exist or the check cannot be performed, the function returns `false`
 * and emits a warning.
 *
 * @param cwd - Working directory used to locate the Git repository (defaults to current directory)
 * @returns `true` if the repository's `core.bare` configuration is `true`, `false` otherwise
 */
export async function isMainRepoBare(cwd: string = '.'): Promise<boolean> {
    try {
        // Find the root of the git repository
        const { stdout: gitDir } = await execa('git', ['-C', cwd, 'rev-parse', '--git-dir']);
        const mainRepoDir = gitDir.endsWith('/.git') ? gitDir.slice(0, -5) : gitDir; // Handle bare repo paths vs normal .git

        // Check the core.bare setting specifically for that repository path
        const { stdout: bareConfig } = await execa('git', ['config', '--get', '--bool', 'core.bare'], {
            cwd: mainRepoDir, // Check config in the main repo dir, not the potentially detached worktree CWD
        });

        // stdout will be 'true' or 'false' as a string
        return bareConfig.trim() === 'true';
    } catch (error: any) {
        // If the command fails (e.g., not a git repo, or config not set),
        // assume it's not bare, but log a warning.
        // A non-existent core.bare config defaults to false.
        if (error.exitCode === 1 && error.stdout === '' && error.stderr === '') {
            // This specific exit code/output means the config key doesn't exist, which is fine (defaults to false).
            return false;
        }
        console.warn(chalk.yellow(`Could not reliably determine if the main repository is bare. Proceeding cautiously. Error:`), error.stderr || error.message);
        return false; // Default to non-bare to avoid blocking unnecessarily, but warn the user.
    }
}

/**
 * Determine the upstream remote name for the repository.
 *
 * Intelligently determines the correct remote to use by:
 * 1. Checking the tracking information for the main branch
 * 2. Falling back to common remote names ('origin', 'upstream')
 * 3. Using the first available remote if no common names are found
 *
 * @param cwd - Working directory used to locate the Git repository (defaults to current directory)
 * @returns The remote name (e.g., 'origin', 'upstream'), or 'origin' as a fallback
 */
export async function getUpstreamRemote(cwd: string = "."): Promise<string> {
    try {
        // Strategy 1: Try to get the remote from the main/master branch's tracking information
        // This handles cases where main is tracking upstream/main instead of origin/main
        for (const candidate of ["main", "master"]) {
            const { stdout: upstreamRef } = await execa("git", ["-C", cwd, "rev-parse", "--abbrev-ref", `${candidate}@{upstream}`], {
                reject: false,
            });

            if (upstreamRef.trim()) {
                // Extract remote name from refs/remotes/upstream/main -> upstream
                const match = upstreamRef.trim().match(/^([^\/]+)\//);
                if (match && match[1]) {
                    return match[1];
                }
            }
        }

        // Strategy 2: Get all remotes and check for common names
        const { stdout: remotesOutput } = await execa("git", ["-C", cwd, "remote"]);
        const remotes = remotesOutput.split('\n').map(r => r.trim()).filter(r => r);

        if (remotes.length === 0) {
            // No remotes configured, return 'origin' as fallback
            return 'origin';
        }

        // Check for common remote names in order of preference
        const commonRemotes = ['origin', 'upstream'];
        for (const commonRemote of commonRemotes) {
            if (remotes.includes(commonRemote)) {
                return commonRemote;
            }
        }

        // Strategy 3: Use the first available remote
        return remotes[0];
    } catch (error) {
        // If all else fails, return 'origin' as a reasonable default
        return 'origin';
    }
}

/**
 * Determine the top-level directory of the Git repository containing the given working directory.
 *
 * @param cwd - Path of the working directory to query (defaults to the current directory)
 * @returns The absolute path to the repository's top-level directory, or `null` if it cannot be determined
 */
export async function getRepoRoot(cwd: string = "."): Promise<string | null> {
    try {
        const { stdout } = await execa("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        return stdout.trim();
    } catch (error) {
        console.error(chalk.yellow("Could not determine repository root."), error);
        return null;
    }
}

/**
 * Extract the hostname from a Git remote URL.
 *
 * Handles both HTTPS URLs (https://github.com/user/repo.git) and
 * SSH URLs (git@github.com:user/repo.git or ssh://git@github.com/repo).
 *
 * @param remoteUrl - The Git remote URL to parse
 * @returns The lowercase hostname, or null if parsing fails
 */
function getRemoteHostname(remoteUrl: string): string | null {
    try {
        // Handle SSH URLs (e.g., git@github.com:user/repo.git)
        if (remoteUrl.startsWith("git@")) {
            const match = remoteUrl.match(/^git@([^:]+):/);
            if (match) {
                return match[1].toLowerCase();
            }
        }
        // Handle ssh:// URLs (e.g., ssh://git@github.com/repo)
        if (remoteUrl.startsWith("ssh://")) {
            const match = remoteUrl.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)/);
            if (match) {
                return match[1].toLowerCase();
            }
        }
        // Handle HTTP/HTTPS URLs
        if (remoteUrl.startsWith("http://") || remoteUrl.startsWith("https://")) {
            const urlObj = new URL(remoteUrl);
            return urlObj.hostname.toLowerCase();
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Detect the Git hosting provider (GitHub or GitLab) for the repository.
 *
 * Examines the remote URL for the upstream remote and determines whether
 * it points to GitHub or GitLab by parsing the hostname.
 *
 * @param cwd - Working directory used to locate the Git repository (defaults to current directory)
 * @returns `'gh'` if the remote is GitHub, `'glab'` if the remote is GitLab, or `null` if undetectable
 */
export async function detectGitProvider(cwd: string = "."): Promise<'gh' | 'glab' | null> {
    try {
        const remote = await getUpstreamRemote(cwd);
        const { stdout } = await execa("git", ["-C", cwd, "remote", "get-url", remote]);
        const remoteUrl = stdout.trim();
        const hostname = getRemoteHostname(remoteUrl);

        if (!hostname) {
            return null;
        }

        // Check for GitHub
        if (hostname === 'github.com') {
            return 'gh';
        }

        // Check for GitLab (gitlab.com or self-hosted gitlab.* domains)
        if (hostname === 'gitlab.com' || /^gitlab\.[a-z.]+$/.test(hostname)) {
            return 'glab';
        }

        return null;
    } catch (error) {
        // Could not get remote URL, return null
        return null;
    }
}

/**
 * Represents a parsed Git worktree with typed fields
 */
export interface WorktreeInfo {
    /** Absolute path to the worktree directory */
    path: string;
    /** HEAD commit hash */
    head: string;
    /** Branch name (short form, e.g., "main" not "refs/heads/main") */
    branch: string | null;
    /** Whether the worktree is in detached HEAD state */
    detached: boolean;
    /** Whether the worktree is locked */
    locked: boolean;
    /** Lock reason if locked */
    lockReason?: string;
    /** Whether the worktree is prunable (stale) */
    prunable: boolean;
    /** Prune reason if prunable */
    pruneReason?: string;
    /** Whether this is the main worktree (not a linked worktree) */
    isMain: boolean;
    /** Whether this is a bare repository worktree */
    bare: boolean;
}

/**
 * Parse git worktree list --porcelain output into typed WorktreeInfo objects
 *
 * Handles all edge cases including:
 * - Bare repositories
 * - Detached HEAD states
 * - Locked worktrees (with optional reason)
 * - Prunable (stale) worktrees
 * - Paths and reasons containing unsafe bytes (newlines, quotes)
 *
 * @param cwd - Working directory to run git command from
 * @returns Array of WorktreeInfo objects in git's order (main worktree first)
 */
export async function getWorktrees(cwd: string = "."): Promise<WorktreeInfo[]> {
    try {
        // -z keeps paths and lock/reason values with unsafe bytes (newlines,
        // quotes, ...) unquoted inside NUL-terminated fields; git 2.36+
        // documents this as the workaround for unreliable c-quoting in the
        // plain porcelain output
        const { stdout } = await execa("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"]);

        if (!stdout.trim()) {
            return [];
        }

        // Records are separated by an empty NUL-terminated field
        const blocks = stdout.split('\0\0').filter(block => block.length > 0);
        const worktrees: WorktreeInfo[] = [];
        let isFirstWorktree = true;

        for (const block of blocks) {
            const fields = block.split('\0');
            const info: WorktreeInfo = {
                path: '',
                head: '',
                branch: null,
                detached: false,
                locked: false,
                prunable: false,
                isMain: isFirstWorktree,
                bare: false,
            };

            for (const field of fields) {
                if (field.startsWith('worktree ')) {
                    info.path = field.substring('worktree '.length);
                } else if (field.startsWith('HEAD ')) {
                    info.head = field.substring('HEAD '.length);
                } else if (field.startsWith('branch ')) {
                    // Convert refs/heads/branch-name to branch-name
                    const fullRef = field.substring('branch '.length);
                    info.branch = fullRef.replace('refs/heads/', '');
                } else if (field === 'detached') {
                    info.detached = true;
                } else if (field === 'bare') {
                    info.bare = true;
                } else if (field === 'locked') {
                    info.locked = true;
                } else if (field.startsWith('locked ')) {
                    info.locked = true;
                    info.lockReason = field.substring('locked '.length);
                } else if (field === 'prunable') {
                    info.prunable = true;
                } else if (field.startsWith('prunable ')) {
                    info.prunable = true;
                    info.pruneReason = field.substring('prunable '.length);
                }
            }

            if (info.path) {
                worktrees.push(info);
            }
            isFirstWorktree = false;
        }

        return worktrees;
    } catch (error: unknown) {
        const execaError = error as ExecaError; // execa rejects with ExecaError
        console.error(chalk.red("Failed to list worktrees:"), execaError.stderr || execaError.message);
        return [];
    }
}

/**
 * Find a worktree by branch name
 *
 * @param branch - Short branch name to find
 * @param cwd - Working directory to run git command from
 * @returns WorktreeInfo if found, null otherwise
 */
export async function findWorktreeByBranch(branch: string, cwd: string = "."): Promise<WorktreeInfo | null> {
    const worktrees = await getWorktrees(cwd);
    return worktrees.find(wt => wt.branch === branch) || null;
}

/**
 * Find a worktree by path
 *
 * @param path - Path to find (will be compared against worktree paths)
 * @param cwd - Working directory to run git command from
 * @returns WorktreeInfo if found, null otherwise
 */
export async function findWorktreeByPath(targetPath: string, cwd: string = "."): Promise<WorktreeInfo | null> {
    const worktrees = await getWorktrees(cwd);
    const { resolve } = await import('node:path');
    const { realpath } = await import('node:fs/promises');

    // Resolve the target path to its real path (following symlinks)
    // This handles macOS where /var is a symlink to /private/var
    let resolvedTarget: string;
    try {
        resolvedTarget = await realpath(resolve(targetPath));
    } catch {
        resolvedTarget = resolve(targetPath);
    }

    for (const wt of worktrees) {
        let wtRealPath: string;
        try {
            wtRealPath = await realpath(wt.path);
        } catch {
            wtRealPath = resolve(wt.path);
        }

        if (wtRealPath === resolvedTarget) {
            return wt;
        }
    }

    return null;
}

/**
 * Get the repository name from the remote URL or directory name
 *
 * @param cwd - Working directory to run git command from
 * @returns Repository name (e.g., "my-project")
 */
export async function getRepoName(cwd: string = "."): Promise<string> {
    try {
        // Try to get from remote URL first
        const remote = await getUpstreamRemote(cwd);
        const { stdout } = await execa("git", ["-C", cwd, "remote", "get-url", remote]);
        const remoteUrl = stdout.trim();

        // Extract repo name from URL
        // Handles: git@github.com:user/repo.git, https://github.com/user/repo.git, etc.
        const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
        if (match && match[1]) {
            return match[1];
        }
    } catch {
        // Fall through to directory name
    }

    // Fallback: use the directory name of the repo root
    const repoRoot = await getRepoRoot(cwd);
    if (repoRoot) {
        const { basename } = await import('node:path');
        return basename(repoRoot);
    }

    return 'repo';
}

/**
 * Stash changes in the current worktree using Git commit/tree plumbing.
 * This creates a unique, identifiable dangling commit and returns its hash
 * to prevent race conditions with concurrent operations.
 *
 * @param cwd - Working directory
 * @param message - Optional stash message
 * @returns Stash hash if changes were stashed, null if working tree was clean
 */
export async function stashChanges(cwd: string = ".", message?: string): Promise<string | null> {
    try {
        // First check if there are any changes to stash, noting which paths were
        // untracked or unstaged so the restore can return them to that state
        // (`stash apply` stages everything otherwise)
        const { stdout: statusOutput } = await execa("git", ["-C", cwd, "status", "--porcelain", "-z"]);
        if (!statusOutput.trim()) {
            // No changes to stash
            return null;
        }
        const resetPaths: string[] = [];
        for (const entry of statusOutput.split("\0")) {
            if (entry.length < 4) {
                continue;
            }
            const x = entry[0];
            const y = entry[1];
            if (x === "?" || (x === " " && y !== " ")) {
                resetPaths.push(entry.substring(3));
            }
        }

        // Save the original index as the second parent of the custom stash
        // commit. Applying that parent later restores staged/unstaged splits.
        const { stdout: headOutput } = await execa("git", ["-C", cwd, "rev-parse", "HEAD"]);
        const { stdout: indexTreeOutput } = await execa("git", ["-C", cwd, "write-tree"]);
        const { stdout: indexCommitOutput } = await execa(
            "git",
            [
                "-C",
                cwd,
                "commit-tree",
                indexTreeOutput.trim(),
                "-p",
                headOutput.trim(),
                "-m",
                "wt index snapshot",
            ]
        );

        // Add untracked files to the index temporarily so they're included in
        // the stash tree, then create a stash-shaped commit whose second
        // parent is the original index snapshot.
        await execa("git", ["-C", cwd, "add", "-A"]);
        const { stdout: stashTreeOutput } = await execa("git", ["-C", cwd, "write-tree"]);
        const { stdout: stashOutput } = await execa(
            "git",
            [
                "-C",
                cwd,
                "commit-tree",
                stashTreeOutput.trim(),
                "-p",
                headOutput.trim(),
                "-p",
                indexCommitOutput.trim(),
                "-m",
                message || "wt stash",
            ]
        );
        const stashHash = stashOutput.trim();

        if (!stashHash) {
            // No changes were stashed (shouldn't happen since we checked above)
            return null;
        }

        // Record the dangling stash commit before the destructive reset so an
        // interrupted run can recover both content and index state.
        try {
            await writeFile(
                await stashRecordPath(cwd),
                JSON.stringify({
                    hash: stashHash,
                    message: message ?? "",
                    createdAt: new Date().toISOString(),
                    indexCommit: indexCommitOutput.trim(),
                    resetPaths,
                })
            );
        } catch (recordError: unknown) {
            // Non-fatal: the stash succeeded and callers restore by hash
            console.warn(
                chalk.yellow("Could not record the stash for crash recovery:"),
                recordError instanceof Error ? recordError.message : recordError
            );
        }

        // Reset the working directory to HEAD to complete the stash effect.
        await execa("git", ["-C", cwd, "reset", "--hard", "HEAD"]);

        // Clean untracked files.
        await execa("git", ["-C", cwd, "clean", "-fd"]);

        return stashHash;
    } catch (error: unknown) {
        const execaError = error as ExecaError; // execa rejects with ExecaError
        console.error(chalk.red("Failed to stash changes:"), execaError.stderr || execaError.message);
        return null;
    }
}
/**
 * Apply a specific stash by hash
 * This ensures we restore the exact changes that were stashed, avoiding conflicts
 * with the shared stash stack. The commit is dangling (created by `stashChanges`),
 * so on failure the hash must be surfaced to the user for manual recovery.
 *
 * @param stashHash - The unique hash of the stash to apply
 * @param cwd - Working directory
 * @returns true if stash was applied successfully
 */
export async function applyAndDropStash(stashHash: string, cwd: string = "."): Promise<boolean> {
    try {
        const record = await readStashRecord(cwd);

        // Apply the specific stash by hash. The original index is restored
        // explicitly below because the stash tree includes temporarily staged
        // untracked files.
        await execa("git", ["-C", cwd, "stash", "apply", stashHash]);

        if (record?.hash === stashHash) {
            if (record.indexCommit) {
                await execa("git", ["-C", cwd, "read-tree", "--reset", `${record.indexCommit}^{tree}`]);
            } else if (record.resetPaths?.length) {
                // Compatibility with records written before index snapshots.
                try {
                    await execa("git", ["-C", cwd, "reset", "-q", "--", ...record.resetPaths]);
                } catch {
                    // Leave the paths staged rather than failing the restore
                }
            }
            await rm(await stashRecordPath(cwd), { force: true });
        }
        return true;
    } catch (error: unknown) {
        const execaError = error as ExecaError; // execa rejects with ExecaError
        console.error(chalk.red("Failed to apply stash:"), execaError.stderr || execaError.message);
        console.error(chalk.yellow(`Your changes are preserved in commit ${stashHash}. Recover them with: git stash apply ${stashHash}`));
        return false;
    }
}