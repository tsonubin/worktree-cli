import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRepoRoot } from "./git.js";
import { confirmCommands } from "./tui.js";

interface WorktreeSetupData {
    "setup-worktree"?: string[];
    [key: string]: unknown;
}

/**
 * Load and parse setup commands from worktrees.json
 */
async function loadSetupCommands(repoRoot: string): Promise<{ commands: string[]; filePath: string } | null> {
    // Check for .cursor/worktrees.json first
    const cursorSetupPath = join(repoRoot, ".cursor", "worktrees.json");
    try {
        await stat(cursorSetupPath);
        const content = await readFile(cursorSetupPath, "utf-8");
        const data = JSON.parse(content) as WorktreeSetupData | string[];

        let commands: string[] = [];
        if (Array.isArray(data)) {
            commands = data;
        } else if (data && typeof data === 'object' && Array.isArray(data["setup-worktree"])) {
            commands = data["setup-worktree"];
        }

        if (commands.length > 0) {
            return { commands, filePath: cursorSetupPath };
        }
    } catch {
        // Not found, try fallback
    }

    // Check for worktrees.json
    const fallbackSetupPath = join(repoRoot, "worktrees.json");
    try {
        await stat(fallbackSetupPath);
        const content = await readFile(fallbackSetupPath, "utf-8");
        const data = JSON.parse(content) as WorktreeSetupData | string[];

        let commands: string[] = [];
        if (Array.isArray(data)) {
            commands = data;
        } else if (data && typeof data === 'object' && Array.isArray(data["setup-worktree"])) {
            commands = data["setup-worktree"];
        }

        if (commands.length > 0) {
            return { commands, filePath: fallbackSetupPath };
        }
    } catch {
        // Not found
    }

    return null;
}

/**
 * Execute setup commands with user confirmation (SECURE)
 *
 * This is the centralized, secure function for loading and executing setup commands.
 * It ensures commands are displayed to the user and requires confirmation before execution,
 * unless the --trust flag is set.
 *
 * SECURITY: This function implements the trust model - all commands are shown to the user
 * and require confirmation before execution. Use --trust flag in CI environments only.
 *
 * @param worktreePath - Path to the worktree where commands should be executed
 * @param options - Execution options (trust flag bypasses confirmation)
 * @returns true if setup commands were found and executed, false if no setup file exists
 */
export async function runSetupScriptsSecure(
    worktreePath: string,
    options: { trust?: boolean } = {}
): Promise<boolean> {
    const repoRoot = await getRepoRoot();
    if (!repoRoot) {
        console.warn(chalk.yellow("Could not determine repository root. Skipping setup scripts."));
        return false;
    }

    const setupResult = await loadSetupCommands(repoRoot);

    if (!setupResult) {
        return false;
    }

    console.log(chalk.blue(`Found setup file: ${setupResult.filePath}`));

    // Show commands and ask for confirmation (unless --trust flag is set)
    const shouldRun = await confirmCommands(setupResult.commands, {
        title: "The following setup commands will be executed:",
        trust: options.trust,
    });

    if (!shouldRun) {
        console.log(chalk.yellow("Setup commands skipped."));
        return false;
    }

    // Execute commands
    const env = { ...process.env, ROOT_WORKTREE_PATH: repoRoot };
    for (const command of setupResult.commands) {
        console.log(chalk.gray(`Executing: ${command}`));
        try {
            await execa(command, { shell: true, cwd: worktreePath, env, stdio: "inherit" });
        } catch (cmdError: unknown) {
            if (cmdError instanceof Error) {
                console.error(chalk.red(`Setup command failed: ${command}`), cmdError.message);
            } else {
                console.error(chalk.red(`Setup command failed: ${command}`), cmdError);
            }
            // Continue with other commands
        }
    }
    console.log(chalk.green("Setup commands completed."));
    return true;
}
