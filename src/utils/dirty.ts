import chalk from "chalk";
import {
    applyAndDropStash,
    isMainRepoBare,
    isWorktreeClean,
    readStashRecord,
    stashChanges,
} from "./git.js";
import { handleDirtyState } from "./tui.js";
import { onShutdown } from "./shutdown.js";

/**
 * Handle for restoring the state guarded by {@link guardDirtyState}.
 */
export interface DirtyStateGuard {
    /**
     * Unregister interruption handling and restore any stashed changes.
     * Idempotent; call from the operation's `finally` block.
     */
    finish: () => Promise<void>;
}

/**
 * Protect uncommitted changes in the main worktree around a long-running operation.
 *
 * - Warns if a stash from a previous (crashed) run was never restored.
 * - Skips the dirty check for bare repositories.
 * - Prompts to stash/abort/continue when the main worktree is dirty; stashed
 *   changes are restored by `finish()` and on SIGINT.
 *
 * @param stashMessage - Message recorded with the stash, identifying the operation
 * @returns Guard whose `finish()` must be called exactly once (from `finally`)
 */
export async function guardDirtyState(stashMessage: string): Promise<DirtyStateGuard> {
    const pending = await readStashRecord(".");
    if (pending) {
        console.warn(chalk.yellow(`Warning: stashed changes from a previous run were never restored (commit ${pending.hash}).`));
        console.warn(chalk.yellow(`Recover them with: git stash apply ${pending.hash}`));
    }

    let stashHash: string | null = null;
    let unregister: (() => void) | null = null;

    const isBare = await isMainRepoBare();
    if (!isBare) {
        console.log(chalk.blue("Checking if main worktree is clean..."));
        const isClean = await isWorktreeClean(".");

        if (!isClean) {
            const action = await handleDirtyState("Your main worktree has uncommitted changes.");

            if (action === "abort") {
                console.log(chalk.yellow("Operation cancelled."));
                process.exit(0);
            } else if (action === "stash") {
                console.log(chalk.blue("Stashing your changes..."));
                stashHash = await stashChanges(".", stashMessage);
                if (stashHash) {
                    console.log(chalk.green("Changes stashed successfully."));
                    unregister = onShutdown(async () => {
                        if (stashHash) {
                            console.log(chalk.blue("Restoring stashed changes due to interruption..."));
                            await applyAndDropStash(stashHash, ".");
                        }
                    });
                }
            } else {
                console.log(chalk.yellow("Proceeding with uncommitted changes..."));
            }
        } else {
            console.log(chalk.green("Main worktree is clean."));
        }
    }

    return {
        finish: async () => {
            if (unregister) {
                unregister();
                unregister = null;
            }
            if (stashHash) {
                console.log(chalk.blue("Restoring your stashed changes..."));
                const restored = await applyAndDropStash(stashHash, ".");
                if (restored) {
                    console.log(chalk.green("Changes restored successfully."));
                }
                stashHash = null;
            }
        },
    };
}
