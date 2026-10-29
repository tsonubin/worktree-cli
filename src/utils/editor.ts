import { execa } from "execa";
import chalk from "chalk";
import { getDefaultEditor, shouldSkipEditor } from "../config.js";

export type EditorOutcome = "opened" | "skipped" | "failed";

/**
 * Open a path in the configured (or explicitly provided) editor.
 *
 * The `WT_EDITOR` environment variable overrides the configured default
 * (see `getDefaultEditor`); `none` skips opening entirely.
 *
 * @param path - Path to open
 * @param customEditor - Editor command from the `--editor` flag, if any
 * @returns Whether the editor was opened, skipped, or failed to launch
 */
export async function openInEditor(path: string, customEditor?: string): Promise<EditorOutcome> {
    const editorCommand = customEditor || getDefaultEditor();

    if (shouldSkipEditor(editorCommand)) {
        console.log(chalk.gray(`Editor set to 'none', skipping editor open.`));
        return "skipped";
    }

    console.log(chalk.blue(`Opening ${path} in ${editorCommand}...`));
    try {
        await execa(editorCommand, [path], { stdio: "inherit" });
        console.log(chalk.green(`Successfully opened worktree in ${editorCommand}.`));
        return "opened";
    } catch {
        console.error(
            chalk.red(`Failed to open editor "${editorCommand}". Please ensure it's installed and in your PATH.`)
        );
        return "failed";
    }
}
