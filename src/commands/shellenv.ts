import chalk from "chalk";

const POSIX_FUNCTION = `wt() {
    local _wt_target_file
    _wt_target_file=$(mktemp -t wt-cd.XXXXXX) || return 1
    WT_CD_FILE="$_wt_target_file" command wt "$@"
    local _wt_exit=$?
    if [ -s "$_wt_target_file" ]; then
        local _wt_target
        _wt_target=$(cat "$_wt_target_file")
        if [ -d "$_wt_target" ]; then
            cd "$_wt_target" || true
        fi
    fi
    rm -f "$_wt_target_file"
    return $_wt_exit
}
`;

const FISH_FUNCTION = `function wt
    set -l _wt_target_file (mktemp -t wt-cd.XXXXXX)
    WT_CD_FILE=$_wt_target_file command wt $argv
    set -l _wt_exit $status
    if test -s "$_wt_target_file"
        set -l _wt_target (cat "$_wt_target_file")
        if test -d "$_wt_target"
            cd "$_wt_target"
        end
    end
    rm -f "$_wt_target_file"
    return $_wt_exit
end
`;

type SupportedShell = "bash" | "zsh" | "fish";

function detectShell(): SupportedShell {
    const shellPath = process.env.SHELL || "";
    if (shellPath.endsWith("/fish")) return "fish";
    if (shellPath.endsWith("/bash")) return "bash";
    return "zsh";
}

export async function shellenvHandler(shell?: string) {
    const target = (shell?.toLowerCase() as SupportedShell) || detectShell();

    switch (target) {
        case "bash":
        case "zsh":
            process.stdout.write(POSIX_FUNCTION);
            break;
        case "fish":
            process.stdout.write(FISH_FUNCTION);
            break;
        default:
            console.error(chalk.red(`Unsupported shell: ${shell}`));
            console.error(chalk.yellow("Supported shells: bash, zsh, fish"));
            process.exit(1);
    }
}
