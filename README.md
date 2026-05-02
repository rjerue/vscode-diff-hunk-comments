# vscode-diff-hunk-comments

Standalone VS Code extension that adds agent-ready comment actions to diff hunks. In Git and unified diffs, a hunk is one contiguous block of changed lines, usually shown with a header like `@@ -12,4 +12,6 @@`.

This is intended to work with any normal VS Code text diff, including diffs opened by other plugins! It should work with anything using VS Code's built-in `vscode.diff` command.

![Diff Hunk Comments working in a VS Code diff](resources/screenshot-working.png)

## Features

- Detects the active VS Code text diff tab.
- Computes changed Git-style diff hunks from the original and modified documents.
- Adds a `$(comment) Comment for agent` CodeLens above each hunk on the modified side.
- Adds an editor-title/context-menu command for commenting on the hunk under the cursor.
- Prompts for optional feedback and copies a structured payload to the clipboard.
- Appends new comments to an existing Diff Hunk Comments clipboard batch with hidden `diff-hunk-comments` markers, so you can collect several comments before pasting them into an agent.

## Usage

Go find it on https://marketplace.visualstudio.com/items?itemName=RyanJerue.vscode-diff-hunk-comments or grab the latest vsix from the CI artifacts!

1. Go to a diff.
2. Hit the new comment button.
3. Leave a comment.
4. Give the comment to your agent to iterate on!

This does read clipboard and supports the ability to do more than 1 comment at a time so get as many as you need! You do not need to do one at a time!

## Development

```sh
pnpm install
pnpm run compile
pnpm run package:vsix
```

Open this folder in VS Code, press `F5`, and open any diff. For `vscode-git-tree-compare-ws`, open a changed file from the Git Tree Compare view.

## Release

Publishing is handled by the manual GitHub Actions `Publish` workflow.

## Settings

- `diffHunkComments.promptForComment`: prompt for feedback before copying the payload.
- `diffHunkComments.agentCommand`: optional VS Code command id to receive the generated payload. If it is blank or fails, the payload is copied to the clipboard.
- `diffHunkComments.showOnAllDiffs`: when false, only shows CodeLens actions for diff titles containing `(Working Tree)`.
